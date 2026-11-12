import { expect, test, type Browser, type Page } from "@playwright/test";

// Full Tier 2 flow on the Firebase Emulator Suite ("demo-" project, no real Firebase access).
// Accounts are created through the public landing registration (landing-first auth). Only the
// SmartWatts email-code endpoints are stubbed, exactly like e2e/auth.spec.ts.
const AUTH = `http://127.0.0.1:${process.env.RENTALS_E2E_AUTH_PORT ?? "9099"}`;
const API = "http://127.0.0.1:8001";
const run = Date.now().toString(36);
const ownerEmail = `owner-${run}@example.com`;
const tenantEmail = `tenant-${run}@example.com`;
const PASSWORD = "Correct-horse-battery-9!";

const staffEmail = `staff-${run}@example.com`;
let staffCreated = false;

/** Creates (once) a verified staff account with the platformAdmin custom claim, then returns an ID token. */
async function staffToken(): Promise<string> {
  const email = staffEmail;
  if (staffCreated) {
    const again = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    });
    return (await again.json()).idToken;
  }
  staffCreated = true;
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
    body: JSON.stringify({ localId: (await created.json()).localId, emailVerified: true, customAttributes: JSON.stringify({ platformAdmin: true }) }),
  });
  expect(claims.ok).toBe(true);
  const signIn = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  return (await signIn.json()).idToken;
}

async function stubEmailCode(page: Page) {
  let verified = false;
  await page.route("**/api/auth/email-code/verify/send", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"sent":true}' }));
  await page.route("**/api/auth/email-code/verify/confirm", (route) => {
    verified = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"verified":true}' });
  });
  await page.route("**/api/auth/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verified }) }));
}

async function newUser(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubEmailCode(page);
  return { context, page };
}

async function register(page: Page, name: string, email: string) {
  await page.goto("/register");
  await page.locator("#reg-name").fill(name);
  await page.locator("#reg-email").fill(email);
  await page.locator("#reg-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account with email" }).click();
  await expect(page.getByRole("heading", { name: "Enter verification code" })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("6-digit verification code").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
  await expect(page.locator("#navigation")).toBeVisible();
}

async function askChat(page: Page, question: string) {
  const panel = page.getByRole("region", { name: "SmartWatts Assistant" });
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Chat with us" }).click();
  await panel.getByLabel("Message").fill(question);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText("Thinking...")).toHaveCount(0, { timeout: 15_000 });
  return panel;
}

function nav(page: Page, name: string) {
  return page.locator("#navigation").getByRole("button", { name, exact: true }).click();
}

// Set RENTALS_E2E_SCREENSHOTS=1 to save review screenshots into test-results/rentals-*.png.
async function shot(page: Page, name: string) {
  if (!process.env.RENTALS_E2E_SCREENSHOTS) return;
  await page.screenshot({ path: `test-results/rentals-${name}.png`, fullPage: true, animations: "disabled" });
}

async function loaded(page: Page) {
  await expect(page.locator('#content [data-slot] .muted-note:text("Loading…")')).toHaveCount(0, { timeout: 15_000 });
}

test("owner sets up a draft, activates, invites a tenant, bills transparently, and privacy holds", async ({ browser }) => {
  if (process.env.RENTALS_E2E_SCREENSHOTS) test.setTimeout(300_000);
  const { context: ownerContext, page: owner } = await newUser(browser);
  await register(owner, "Olivia Owner", ownerEmail);

  // ---- Grounded assistant: Personal workspace uses only this user's own records.
  let chat = await askChat(owner, "Which of my appliances uses the most electricity?");
  await expect(chat.getByTestId("chat-context")).toHaveText("SmartWatts Personal");
  await expect(chat.locator('[role="log"]')).toContainText("No appliances");
  await nav(owner, "My Appliances");
  const appliance = owner.locator('[data-form="appliance-save"]');
  await appliance.getByLabel("Name").fill("Owner Aircon");
  await appliance.getByLabel("Power (watts)").fill("1000");
  await appliance.getByLabel("Hours used per day").fill("8");
  await appliance.getByRole("button", { name: "Save appliance" }).click();
  await expect(owner.locator('[data-slot="appliances"]')).toContainText("Owner Aircon");
  chat = await askChat(owner, "Which of my appliances uses the most electricity?");
  await expect(chat.locator('[role="log"]')).toContainText("Highest estimated consumer: Owner Aircon (243.50 kWh per month)");
  await chat.getByText("Calculated figures and assumptions").last().click();
  await expect(chat.locator(".smartwatts-fact-kind").first()).toHaveText("Estimate");
  // ---- Bill retrieval regression: a bill saved in Bill Upload & History is what the assistant answers with.
  await nav(owner, "Bill Upload & History");
  const billSave = owner.locator('[data-form="bill-save"]');
  await billSave.getByLabel("Period start").fill("2026-10-01");
  await billSave.getByLabel("Period end").fill("2026-10-31");
  await billSave.getByLabel("Billed kWh").fill("212.5");
  await billSave.getByLabel("Total current charges (₱)").fill("2,684.50");
  await billSave.getByLabel(/I reviewed this bill/).check();
  await billSave.getByRole("button", { name: "Save bill" }).click();
  await expect(owner.locator('[data-slot="bills"]')).toContainText("2,684.50");
  await owner.reload(); // hard refresh: the saved bill persists
  await nav(owner, "Bill Upload & History");
  await expect(owner.locator('[data-slot="bills"]')).toContainText("2,684.50", { timeout: 15_000 });
  chat = await askChat(owner, "how much the previous bill i upload");
  await expect(chat.locator('[role="log"]')).toContainText("current charges of ₱2,684.50");
  await expect(chat.getByTestId("chat-grounding-status").last()).toHaveText(/Answered directly from your SmartWatts records/);
  await owner.getByRole("button", { name: "Close", exact: true }).click();

  // ---- Milestone 1: draft property with free setup
  await nav(owner, "SmartWatts Rentals");
  await expect(owner.locator("#content")).toContainText("How SmartWatts Rentals works");
  await shot(owner, "0-start");
  const propertyForm = owner.locator('[data-form="property-create"]');
  await propertyForm.getByLabel("Property name").fill("Sampaguita Residences");
  await propertyForm.getByLabel("Address").fill("12 Mabini St, Quezon City");
  await propertyForm.getByRole("button", { name: "Create draft property" }).click();
  await expect(owner.locator("#content")).toContainText("Property setup");
  await expect(owner.locator(".property-title")).toContainText("Draft");
  await shot(owner, "1-draft-overview");

  await nav(owner, "Account Settings");
  await expect(owner.locator('[data-slot="account-context"]')).toContainText("Rentals Owner");
  await expect(owner.locator("#account-first-name")).toHaveValue("");
  await expect(owner.locator("#account-current-display-name")).toHaveText("Olivia Owner");
  await expect(owner.locator("#account-email")).toHaveValue(ownerEmail);
  await expect(owner.locator("#account-email")).toHaveAttribute("readonly", "");
  await nav(owner, "Overview");

  // The reported bug: asking about "my uploaded bill" while a property (with no bills) is selected.
  const draftPropertyId = await owner.evaluate(() => JSON.parse(localStorage.getItem("smartwatts-workspace") ?? "{}").propertyId);
  chat = await askChat(owner, "how much the previous bill i upload");
  await expect(chat.getByTestId("chat-context")).toHaveText("SmartWatts Rentals — Sampaguita Residences");
  await expect(chat.locator('[role="log"]')).toContainText("You have 1 bill(s) saved in SmartWatts Personal");
  await expect(chat.locator('[role="log"]')).not.toContainText("2,684.50"); // no silent mixing of scopes
  await chat.getByRole("button", { name: "Switch to SmartWatts Personal" }).click();
  await expect(chat.getByTestId("chat-context")).toHaveText("SmartWatts Personal");
  await expect(chat.locator('[role="log"]')).toContainText("current charges of ₱2,684.50", { timeout: 15_000 });
  await expect(chat.locator('[role="log"]')).not.toContainText("Sampaguita"); // property chat history not carried over
  await owner.getByRole("button", { name: "Close", exact: true }).click();
  await owner.locator("#workspaceSelect").selectOption(draftPropertyId);
  await expect(owner.locator(".property-title")).toContainText("Draft", { timeout: 15_000 });
  const propertyId = await owner.evaluate(() => JSON.parse(localStorage.getItem("smartwatts-workspace") ?? "{}").propertyId);
  expect(propertyId).toBeTruthy();

  await nav(owner, "Units & Tenants");
  await loaded(owner);
  const unitForm = owner.locator('[data-form="unit-create"]');
  await unitForm.getByLabel("Unit label").fill("Unit 1A");
  await unitForm.getByRole("button", { name: "Add unit" }).click();
  await expect(owner.locator('[data-slot="units"]')).toContainText("Unit 1A");
  await expect(owner.locator('[data-slot="invite-form"]')).toContainText("Available after this property's subscription is activated");
  await expect(owner.locator('[data-slot="invite-form"]').getByRole("button", { name: "Create invitation" })).toBeDisabled();

  await nav(owner, "Meters & Allocation");
  await loaded(owner);
  const meterForm = owner.locator('[data-form="meter-create"]');
  await meterForm.getByLabel("Label").fill("Meralco 1A");
  await meterForm.getByLabel("Type").selectOption("utility_individual");
  await meterForm.getByRole("button", { name: "Register meter" }).click();
  await expect(owner.locator("#content")).toContainText("Meralco 1A");
  const assignForm = owner.locator('[data-form="assignment-create"]');
  await assignForm.getByLabel("Effective from").fill("2026-01-01");
  await assignForm.getByRole("button", { name: "Assign" }).click();
  await expect(owner.getByText("Ongoing")).toBeVisible();

  await nav(owner, "Subscription");
  await owner.getByRole("button", { name: "Request activation" }).click();
  await expect(owner.locator("#content")).toContainText("Pending activation");

  // Owners can't use platform administration, even by calling the API directly.
  const ownerPlatform = await owner.evaluate(async (pid) => {
    const { getIdToken } = await import("/src/lib/apiAuth.ts");
    const headers = { Authorization: `Bearer ${await getIdToken()}`, "Content-Type": "application/json" };
    const list = await fetch("/api/platform/subscriptions", { headers });
    const approve = await fetch(`/api/platform/subscriptions/${pid}/approve`, { method: "POST", headers,
      body: JSON.stringify({ confirm: true, expectedVersion: 1, activationSource: "administrative_grant", reason: "self approval attempt", periodEnd: "2027-06-30" }) });
    return [list.status, approve.status];
  }, propertyId);
  expect(ownerPlatform).toEqual([403, 403]);
  await expect(owner.locator("#navigation")).not.toContainText("Rentals Subscriptions");

  // ---- Workstream A: a SmartWatts platform administrator approves the request in the staff UI.
  await staffToken();
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await staff.goto("/login");
  await staff.locator("#li-email").fill(staffEmail);
  await staff.locator("#li-pass").fill(PASSWORD);
  await staff.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(staff).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
  await nav(staff, "Rentals Subscriptions");
  await loaded(staff);
  await expect(staff.locator('[data-slot="platform-list"]')).toContainText("Sampaguita Residences");
  await staff.locator('[data-slot="platform-list"] tr', { hasText: "Sampaguita Residences" }).getByRole("button", { name: "Review" }).click();
  const detail = staff.locator('[data-slot="platform-detail"]');
  await expect(detail).toContainText(ownerEmail);
  await detail.locator("summary", { hasText: "Approve" }).click();
  const approveForm = detail.locator('[data-platform-action="approve"]');
  await approveForm.getByLabel("Activation source").selectOption("administrative_grant");
  await approveForm.getByLabel("Entitlement end date").fill("2027-06-30");
  await approveForm.getByLabel(/Reason/).fill("Pilot property approved by the SmartWatts team.");
  await approveForm.getByRole("button", { name: "Approve" }).click();
  await staff.locator("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(detail).toContainText("Active", { timeout: 15_000 });
  await expect(detail).toContainText("administrative_grant");
  await shot(staff, "7-platform-admin");

  await owner.reload();
  await nav(owner, "Subscription");
  await loaded(owner);
  await expect(owner.locator("#content")).toContainText("Administrative grant");
  await expect(owner.locator("#content")).toContainText("Subscription history");
  await nav(owner, "Overview");
  await expect(owner.locator(".property-title")).toContainText("Active");

  // ---- Milestone 2: invitation → signed-out tenant → landing registration → join
  await nav(owner, "Units & Tenants");
  await loaded(owner);
  const inviteForm = owner.locator('[data-form="invite-create"]');
  await inviteForm.getByLabel("Unit (tenants)").selectOption({ label: "Unit 1A" });
  await inviteForm.getByLabel("Move-in date").fill("2026-01-01");
  await inviteForm.getByRole("button", { name: "Create invitation" }).click();
  await expect(owner.locator(".qr svg")).toBeVisible();
  const inviteLink = await owner.getByLabel("Invitation link").inputValue();
  expect(inviteLink).toContain("#join=");

  const { context: tenantContext, page: tenant } = await newUser(browser);
  await tenant.goto(inviteLink.replace(/^https?:\/\/[^/]+/, ""));
  await expect(tenant).toHaveURL(/\/$/, { timeout: 15_000 }); // signed out → landing page
  await register(tenant, "Tomas Tenant", tenantEmail);
  // The pending invitation resumes after registration.
  await expect(tenant.locator("#content")).toContainText("Sampaguita Residences", { timeout: 15_000 });
  await tenant.getByRole("button", { name: "Accept invitation" }).click();
  await expect(tenant.locator("#navigation")).toContainText("My Statements");
  await expect(tenant.locator("#content")).toContainText("No published statements yet");
  await expect(tenant.locator("#content")).toContainText("Meralco 1A");
  await nav(tenant, "Account Settings");
  await expect(tenant.locator('[data-slot="account-context"]')).toContainText("Rentals Tenant");
  await expect(tenant.locator("#account-first-name")).toHaveValue("");
  await expect(tenant.locator("#account-current-display-name")).toHaveText("Tomas Tenant");
  await expect(tenant.locator("#account-email")).toHaveValue(tenantEmail);
  await expect(tenant.locator("#account-email")).not.toHaveValue(ownerEmail);

  // Tenant-private appliance data and owner-only API denial.
  await nav(tenant, "My Appliances");
  const tenantAppliance = tenant.locator('[data-form="appliance-save"]');
  await tenantAppliance.getByLabel("Name").fill("Secret gaming PC");
  await tenantAppliance.getByLabel("Power (watts)").fill("600");
  await tenantAppliance.getByLabel("Hours used per day").fill("6");
  await tenantAppliance.getByRole("button", { name: "Save appliance" }).click();
  await expect(tenant.locator('[data-slot="appliances"]')).toContainText("Secret gaming PC");
  const tenantForbidden = await tenant.evaluate(async (pid) => {
    const { getIdToken } = await import("/src/lib/apiAuth.ts");
    const headers = { Authorization: `Bearer ${await getIdToken()}` };
    return Promise.all(["utility-bills", "readings", "analytics", "review-requests"].map(async (path) =>
      (await fetch(`/api/rentals/properties/${pid}/${path}`, { headers })).status));
  }, propertyId);
  expect(tenantForbidden).toEqual([403, 403, 403, 403]);

  // ---- Milestone 3: readings with interval consumption, bill with breakdown
  await owner.reload();
  await nav(owner, "Meter Readings");
  await loaded(owner);
  for (const [day, value] of [["2026-10-01", "1000"], ["2026-10-31", "1180.5"]]) {
    const readingForm = owner.locator('[data-form="reading-create"]');
    await readingForm.getByLabel("Reading date (when you read the meter)").fill(day);
    await readingForm.getByLabel("Cumulative register value (kWh)").fill(value);
    await readingForm.getByLabel("I checked this value against the physical meter.").check();
    await readingForm.getByRole("button", { name: "Save verified reading" }).click();
    await expect(owner.locator("#content")).toContainText(day);
  }
  await expect(owner.locator("#content")).toContainText("180.5 kWh");
  await expect(owner.locator("#content")).toContainText("over 30 day(s)");
  await shot(owner, "3-readings");

  await nav(owner, "Utility Bills");
  await loaded(owner);
  const billForm = owner.locator('[data-form="rental-bill-create"]');
  await billForm.getByLabel("Utility meter").selectOption({ index: 0 });
  await billForm.getByLabel("Period start").fill("2026-10-01");
  await billForm.getByLabel("Period end").fill("2026-10-31");
  await billForm.getByLabel("Total kWh").fill("180.5");
  await billForm.getByLabel("Total amount (₱)").fill("2,215.40");
  await billForm.getByLabel("Charge breakdown (optional)").fill("Generation = 1,500.00\nTaxes = 715.40");
  await billForm.getByRole("button", { name: "Save bill" }).click();
  await expect(owner.locator('[data-slot="rental-bills"]')).toContainText("₱2,215.40");
  await expect(owner.locator('[data-slot="rental-bills"]')).toContainText("Utility bill · owner-entered");
  await owner.getByRole("button", { name: "Generate draft statements" }).click();
  await expect(owner.locator('[data-slot="reconciliation"]')).toContainText("every centavo is accounted for");

  // ---- Milestone 4: Draft → Reviewed → Published
  await nav(owner, "Tenant Statements");
  await loaded(owner);
  await expect(owner.locator("#content")).toContainText(tenantEmail);
  await expect(owner.getByRole("button", { name: "Publish to tenant" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Mark as reviewed" }).click();
  await owner.getByRole("button", { name: "Publish to tenant" }).click();
  await owner.locator("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(owner.locator("#content")).toContainText("v1 · Published");

  await nav(tenant, "My Statements");
  await loaded(tenant);
  await expect(tenant.locator("#content")).toContainText("₱2,215.40");
  await expect(tenant.locator("#content")).toContainText("New electricity statement");
  await tenant.getByText("Ask your landlord to re-check this statement").click();
  await tenant.getByLabel("Message to your landlord").fill("The kWh looks higher than usual this month.");
  await tenant.getByRole("button", { name: "Send request" }).click();
  await expect(tenant.locator("#content")).toContainText("Waiting for your landlord");
  await shot(tenant, "4-tenant-statements");
  const tenantChat = await askChat(tenant, "Why is my statement higher than last month?");
  await expect(tenantChat.getByTestId("chat-context")).toContainText("Your Unit Unit 1A");
  await expect(tenantChat.locator('[role="log"]')).toContainText("₱2,215.40");
  await expect(tenantChat.locator('[role="log"]')).toContainText("Only one published statement");
  await expect(tenantChat.locator('[role="log"]')).not.toContainText("Secret gaming PC");
  await tenant.getByRole("button", { name: "Close", exact: true }).click();

  await nav(owner, "Tenant Statements");
  await loaded(owner);
  await expect(owner.locator('[data-slot="review-requests"]')).toContainText("The kWh looks higher than usual");
  await owner.getByLabel("Response").fill("Checked against the bill and both meter readings; the figures match.");
  await owner.getByRole("button", { name: "Send response" }).click();
  await expect(owner.locator('[data-slot="review-requests"]')).toContainText("Answered");
  await shot(owner, "5-owner-statements");

  await nav(owner, "Property Analytics");
  await loaded(owner);
  await expect(owner.locator("#content")).toContainText("Meter-level comparison");
  await expect(owner.getByRole("button", { name: "Print / Save as PDF" })).toBeVisible();

  // Owner screens never show the tenant's private appliance data.
  for (const page of ["Overview", "Property Analytics", "Units & Tenants", "Meter Readings", "Tenant Statements", "Audit Log"]) {
    await nav(owner, page);
    await loaded(owner);
    await expect(owner.locator("#content")).not.toContainText("Secret gaming PC");
  }

  // Mobile: the overview fits a phone screen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.reload();
  await expect(owner.locator(".property-title")).toBeVisible({ timeout: 15_000 });
  await loaded(owner);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(owner, "6-mobile-overview");
  await owner.setViewportSize({ width: 1280, height: 800 });
  await owner.reload();

  // Revocation through the accessible confirmation dialog.
  await nav(owner, "Units & Tenants");
  await loaded(owner);
  await owner.locator('[data-slot="members"]').getByRole("button", { name: "Remove access" }).click();
  await owner.locator("dialog").getByRole("button", { name: "Remove access" }).click();
  await expect(owner.locator('[data-slot="members"]')).toContainText("No tenants or administrators yet.");
  const afterRevoke = await tenant.evaluate(async (pid) => {
    const { getIdToken } = await import("/src/lib/apiAuth.ts");
    const headers = { Authorization: `Bearer ${await getIdToken()}` };
    const unit = await fetch(`/api/rentals/properties/${pid}/me/unit`, { headers });
    const statements = await fetch(`/api/rentals/properties/${pid}/me/statements`, { headers });
    return [unit.status, statements.status, (await statements.json()).length];
  }, propertyId);
  expect(afterRevoke).toEqual([404, 200, 1]);

  // ---- Grounded assistant in the Rentals workspace (owner): scoped context, real records, read-only.
  await owner.reload();
  await nav(owner, "Overview");
  await loaded(owner);
  chat = await askChat(owner, "What is the status of my rental subscription?");
  await expect(chat.getByTestId("chat-context")).toHaveText("SmartWatts Rentals — Sampaguita Residences");
  await expect(chat.locator('[role="log"]')).not.toContainText("Owner Aircon"); // Personal history is not carried over
  await expect(chat.locator('[role="log"]')).toContainText("Subscription status: active");
  chat = await askChat(owner, "how much the previous bill i upload");
  await expect(chat.locator('[role="log"]')).toContainText("₱2,215.40"); // this property's utility bill
  await expect(chat.locator('[role="log"]')).not.toContainText("2,684.50"); // never the Personal bill
  chat = await askChat(owner, "Activate my subscription for another year");
  await expect(chat.locator('[role="log"]')).toContainText("I can't make changes");
  // Auth restoration: after a refresh the assistant still answers with the restored session.
  await owner.reload();
  await nav(owner, "Overview");
  chat = await askChat(owner, "Which meter has the highest recorded interval consumption?");
  await expect(chat.locator('[role="log"]')).toContainText("Meralco 1A");
  // Backend outage: the UI explains it instead of inventing an answer.
  await owner.route("**/api/assistant/chat", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  chat = await askChat(owner, "How did my bill change?");
  await expect(chat.locator('[role="log"]')).toContainText("assistant is unavailable right now");
  await owner.unroute("**/api/assistant/chat");

  // ---- Workstream A: suspension is enforced in the owner UI and API, then reactivated.
  await staff.reload();
  await nav(staff, "Rentals Subscriptions");
  await staff.getByRole("button", { name: "Active", exact: true }).click();
  await loaded(staff);
  await staff.locator('[data-slot="platform-list"] tr', { hasText: "Sampaguita Residences" }).getByRole("button", { name: "Review" }).click();
  await detail.locator("summary", { hasText: "Suspend" }).click();
  await detail.locator('[data-platform-action="suspend"]').getByLabel(/Reason/).fill("Payment dispute under review by finance.");
  await detail.locator('[data-platform-action="suspend"]').getByRole("button", { name: "Suspend" }).click();
  await staff.locator("dialog").getByRole("button", { name: "Suspend" }).click();
  await expect(detail).toContainText("Suspended", { timeout: 15_000 });
  await owner.reload();
  await nav(owner, "Subscription");
  await loaded(owner);
  await expect(owner.locator("#content")).toContainText("Payment dispute under review by finance.");
  await nav(owner, "Units & Tenants");
  await loaded(owner);
  await expect(owner.locator('[data-slot="invite-form"]').getByRole("button", { name: "Create invitation" })).toBeDisabled();
  await detail.locator("summary", { hasText: "Reactivate" }).click();
  const reactivate = detail.locator('[data-platform-action="reactivate"]');
  await reactivate.getByLabel("Activation source").selectOption("external_payment_verified");
  await reactivate.getByLabel("Payment reference (for verified payments)").fill("BANK-REF-20261113");
  await reactivate.getByLabel(/Reason/).fill("Dispute resolved; payment confirmed by finance.");
  await reactivate.getByRole("button", { name: "Reactivate" }).click();
  await staff.locator("dialog").getByRole("button", { name: "Reactivate" }).click();
  await expect(detail).toContainText("BANK-REF-20261113", { timeout: 15_000 });
  await expect(detail.locator("table")).toContainText("suspend");

  await staffContext.close();
  await ownerContext.close();
  await tenantContext.close();
});
