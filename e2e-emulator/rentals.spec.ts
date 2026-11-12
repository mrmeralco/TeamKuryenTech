import { expect, test, type Page } from "@playwright/test";

// Full Tier 2 flow on the Firebase Emulator Suite ("demo-" project, no real Firebase access).
const AUTH = "http://127.0.0.1:9099";
const API = "http://127.0.0.1:8001";
const run = Date.now().toString(36);
const ownerEmail = `owner-${run}@example.com`;
const tenantEmail = `tenant-${run}@example.com`;
const PASSWORD = "correct horse battery";

async function staffToken(): Promise<string> {
  const email = `staff-${run}@example.com`;
  const created = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/demo-smartwatts/accounts`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(created.ok).toBe(true);
  // Equivalent of Admin SDK setCustomUserClaims(uid, { platformAdmin: true }).
  const claims = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/demo-smartwatts/accounts:update`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ localId: (await created.json()).localId, customAttributes: JSON.stringify({ platformAdmin: true }) }),
  });
  expect(claims.ok).toBe(true);
  const signIn = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  return (await signIn.json()).idToken;
}

async function createAccount(page: Page, email: string) {
  await page.getByRole("button", { name: "Account Settings" }).click();
  const form = page.locator('[data-form="account-create"]');
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(PASSWORD);
  await form.getByRole("button", { name: /Create account/ }).click();
  // Account creation = link credential + verification email + token refresh + workspace reload
  // (measured 1.7–3.1 s on the emulator), so allow more than the 5 s default.
  await expect(page.getByText(`Signed in as`)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-slot="account-security"]')).toContainText(email);
}

function nav(page: Page, name: string) {
  return page.locator("#navigation").getByRole("button", { name, exact: true }).click();
}

test("owner sets up a property, invites a tenant, bills them transparently, and privacy holds", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  owner.on("dialog", (dialog) => dialog.accept());
  await owner.goto("/");

  // Personal data created as an anonymous guest survives the upgrade to a permanent account.
  await nav(owner, "My Appliances");
  const appliance = owner.locator('[data-form="appliance-save"]');
  await appliance.getByLabel("Name").fill("Owner fridge");
  await appliance.getByLabel("Power (watts)").fill("150");
  await appliance.getByLabel("Hours used per day").fill("24");
  await appliance.getByRole("button", { name: "Save appliance" }).click();
  await expect(owner.locator('[data-slot="appliances"]')).toContainText("Owner fridge");
  await createAccount(owner, ownerEmail);
  await nav(owner, "My Appliances");
  await expect(owner.locator('[data-slot="appliances"]')).toContainText("Owner fridge");

  // Create a property: it starts inactive, and writes are blocked until staff activate it.
  await nav(owner, "SmartWatts Rentals");
  const propertyForm = owner.locator('[data-form="property-create"]');
  await propertyForm.getByLabel("Property name").fill("Sampaguita Residences");
  await propertyForm.getByLabel("Address").fill("12 Mabini St, Quezon City");
  await propertyForm.getByRole("button", { name: "Create property" }).click();
  await expect(owner.locator("#navigation")).toContainText("Units & Tenants");
  await expect(owner.locator("#content")).toContainText("is not active");
  const propertyId = await owner.evaluate(() => JSON.parse(localStorage.getItem("smartwatts-workspace") ?? "{}").propertyId);
  expect(propertyId).toBeTruthy();

  const activation = await fetch(`${API}/api/rentals/admin/properties/${propertyId}/subscription`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await staffToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "active", currentPeriodEnd: "2027-01-31T00:00:00+00:00" }),
  });
  expect(activation.status, await activation.clone().text()).toBe(200);

  // Units, meter, and assignment.
  await nav(owner, "Units & Tenants");
  await owner.locator('[data-form="unit-create"]').getByLabel("Unit label").fill("Unit 1A");
  await owner.getByRole("button", { name: "Add unit" }).click();
  await expect(owner.locator('[data-slot="units"]')).toContainText("Unit 1A");

  await nav(owner, "Meters & Allocation");
  const meterForm = owner.locator('[data-form="meter-create"]');
  await meterForm.getByLabel("Label").fill("Meralco 1A");
  await meterForm.getByLabel("Type").selectOption("utility_individual");
  await meterForm.getByRole("button", { name: "Register meter" }).click();
  await expect(owner.locator("#content")).toContainText("Meralco 1A");
  const assignForm = owner.locator('[data-form="assignment-create"]');
  await assignForm.getByLabel("Effective from").fill("2026-01-01");
  await assignForm.getByRole("button", { name: "Assign" }).click();
  await expect(owner.getByText("Ongoing")).toBeVisible();

  // Invitation with QR code.
  await nav(owner, "Units & Tenants");
  const inviteForm = owner.locator('[data-form="invite-create"]');
  await inviteForm.getByLabel("Unit (tenants)").selectOption({ label: "Unit 1A" });
  await inviteForm.getByLabel("Move-in date").fill("2026-01-01");
  await inviteForm.getByRole("button", { name: "Create invitation" }).click();
  await expect(owner.locator(".qr svg")).toBeVisible();
  const inviteLink = await owner.getByLabel("Invitation link").inputValue();
  expect(inviteLink).toContain("#join=");

  // Tenant joins with the link and creates a permanent account.
  const tenantContext = await browser.newContext();
  const tenant = await tenantContext.newPage();
  await tenant.goto(inviteLink.replace(/^https?:\/\/[^/]+/, ""));
  await expect(tenant.locator("#content")).toContainText("Sampaguita Residences");
  expect(tenant.url()).not.toContain("#join=");
  await tenant.locator("#content").getByRole("button", { name: "Create account" }).click();
  await createAccount(tenant, tenantEmail);
  await tenant.getByRole("button", { name: "Continue to your rental invitation" }).click();
  await tenant.getByRole("button", { name: "Accept invitation" }).click();
  await expect(tenant.locator("#navigation")).toContainText("My Statements");
  await expect(tenant.locator("#content")).toContainText("No finalized statements yet.");

  // Tenant-private appliance data.
  await nav(tenant, "My Appliances");
  await expect(tenant.getByText("Landlords and property managers can never see this data.")).toBeVisible();
  const tenantAppliance = tenant.locator('[data-form="appliance-save"]');
  await tenantAppliance.getByLabel("Name").fill("Secret gaming PC");
  await tenantAppliance.getByLabel("Power (watts)").fill("600");
  await tenantAppliance.getByLabel("Hours used per day").fill("6");
  await tenantAppliance.getByRole("button", { name: "Save appliance" }).click();
  await expect(tenant.locator('[data-slot="appliances"]')).toContainText("Secret gaming PC");

  // Tenant cannot reach owner-only APIs.
  const tenantForbidden = await tenant.evaluate(async (pid) => {
    const { getIdToken } = await import("/src/lib/apiAuth.ts");
    const response = await fetch(`/api/rentals/properties/${pid}/utility-bills`, { headers: { Authorization: `Bearer ${await getIdToken()}` } });
    return response.status;
  }, propertyId);
  expect(tenantForbidden).toBe(403);

  // Owner records the official bill and generates a statement.
  await owner.reload();
  await nav(owner, "Utility Bills");
  const billForm = owner.locator('[data-form="rental-bill-create"]');
  await billForm.getByLabel("Utility meter").selectOption({ index: 0 });
  await billForm.getByLabel("Period start").fill("2026-10-01");
  await billForm.getByLabel("Period end").fill("2026-10-31");
  await billForm.getByLabel("Total kWh").fill("180.5");
  await billForm.getByLabel("Total amount (₱)").fill("2,215.40");
  await billForm.getByRole("button", { name: "Save official bill" }).click();
  await expect(owner.locator('[data-slot="rental-bills"]')).toContainText("₱2,215.40");
  await owner.getByRole("button", { name: "Generate statements" }).click();
  await expect(owner.locator('[data-slot="reconciliation"]')).toContainText("every centavo is accounted for");

  await nav(owner, "Tenant Statements");
  await expect(owner.locator("#content")).toContainText(tenantEmail);
  await owner.getByRole("button", { name: "Finalize" }).click();
  await expect(owner.locator("#content")).toContainText("Finalized");

  // Owner screens never show the tenant's private appliance data.
  for (const page of ["Overview", "Property Analytics", "Units & Tenants", "Meter Readings", "Tenant Statements", "Audit Log"]) {
    await nav(owner, page);
    await expect(owner.locator('#content [data-slot] .muted-note:text("Loading…")')).toHaveCount(0);
    await expect(owner.locator("#content")).not.toContainText("Secret gaming PC");
  }

  // Verify Property Analytics displays unit-level metrics and export control
  await nav(owner, "Property Analytics");
  await expect(owner.locator("#content")).toContainText("Unit-Level Electricity Analytics");
  await expect(owner.locator("#content")).toContainText("Unit 1A");
  await expect(owner.locator('button[data-act="export-property-analytics"]')).toBeVisible();

  // Tenant sees the finalized, clearly labelled statement.
  await nav(tenant, "My Statements");
  await expect(tenant.locator("#content")).toContainText("₱2,215.40");
  await expect(tenant.locator("#content .kind-official").first()).toHaveText("Official utility bill");
  await expect(tenant.locator("#content")).toContainText("legal/regulatory review");
  // Tenant calendar: only their own finalized statement period.
  await expect(tenant.locator("#content .calendar-month", { hasText: "Oct 2026" })).toContainText("2026-10-01 – 2026-10-31");
  await expect(tenant.locator("#content .calendar-period")).toHaveCount(1);

  // Owner calendar: property billing periods from official bills.
  await nav(owner, "Overview");
  await expect(owner.locator("#content .calendar-month", { hasText: "Oct 2026" })).toContainText("180.5 kWh");

  // Revocation: the tenant loses access to unit details.
  await nav(owner, "Units & Tenants");
  await owner.getByRole("button", { name: "Remove access" }).click();
  await expect(owner.locator('[data-slot="members"]')).toContainText("No tenants or administrators yet.");
  const afterRevoke = await tenant.evaluate(async (pid) => {
    const { getIdToken } = await import("/src/lib/apiAuth.ts");
    const headers = { Authorization: `Bearer ${await getIdToken()}` };
    const unit = await fetch(`/api/rentals/properties/${pid}/me/unit`, { headers });
    const statements = await fetch(`/api/rentals/properties/${pid}/me/statements`, { headers });
    return [unit.status, statements.status, (await statements.json()).length];
  }, propertyId);
  expect(afterRevoke).toEqual([404, 200, 1]);

  await ownerContext.close();
  await tenantContext.close();
});
