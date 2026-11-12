import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// NFC demonstration on the isolated emulator stack with the seeded fixture (see global-setup.ts).
// Real Firebase Auth (emulator) + real FastAPI + real Firestore (emulator). No API stubs.
const AUTH = "http://127.0.0.1:9399";
const API = "http://127.0.0.1:8021";
const PASSWORD = process.env.DEMO_EMULATOR_PASSWORD ?? "smartwatts-demo-emulator";
const OWNER = "rolexesto0001@gmail.com";
const TENANT = "rolexesto001@gmail.com";
const STAFF = "schoolproware@gmail.com";
const seed = JSON.parse(readFileSync("test-results/demo-seed.json", "utf8"));
const PID: string = seed.first.propertyId;
const SHOTS = !!process.env.DEMO_E2E_SCREENSHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `test-results/demo-${name}.png`, fullPage: true, animations: "disabled" });
}

async function idToken(email: string): Promise<string> {
  const response = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()).idToken;
}

const api = (path: string, token?: string) => fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

/** Tap the card while signed out → login → back through /nfc → the account's authorized dashboard. */
async function tapAndSignIn(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/nfc");
  await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  await page.locator("#li-email").fill(email);
  await page.locator("#li-pass").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  return { context, page };
}

async function settled(page: Page) {
  await expect(page.locator('#content [data-slot] .muted-note:text("Loading…")')).toHaveCount(0, { timeout: 20_000 });
}

function nav(page: Page, name: string) {
  return page.locator("#navigation").getByRole("button", { name, exact: true }).click();
}

test("seed is idempotent and reports the exact records created", () => {
  expect(seed.preview.result).toContain("dry-run");
  expect(seed.preview.preview.existing.state).toBe("absent");
  expect(seed.first.created).toMatchObject({ units: 2, meters: 2, meterReadings: 8, utilityBills: 6, publishedStatements: 3, tenantMemberships: 1 });
  expect(seed.first.email).toEqual({ queuedInSandbox: 9, deliveryAttempts: 0, delivered: 0 });
  expect(seed.second.result).toBe("already-seeded");
  expect(seed.first.target.project).toBe("demo-smartwatts");
});

test("owner: NFC tap → Owner dashboard with the demo property's persisted data", async ({ browser }) => {
  const { context, page } = await tapAndSignIn(browser, OWNER);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(page.locator("#pageTitle")).toHaveText("Property Overview", { timeout: 20_000 });
  await settled(page);
  const content = page.locator("#content");
  await expect(page.getByTestId("demo-data-banner")).toContainText("Demo Data");
  await expect(page.getByTestId("demo-data-banner")).toContainText("SAMPLE DATA — FOR DEMONSTRATION ONLY");
  await expect(content).toContainText("1 occupied · 50%");
  await expect(content).toContainText("2026-10-01 – 2026-10-31");
  await expect(content).toContainText("₱1,892.00");
  await expect(content).toContainText("₱572.00");
  await expect(content).toContainText("-0.56%"); // calendar per day: Oct 224 kWh/31 d (7.23) vs Sep 218 kWh/30 d (7.27)
  await expect(content).toContainText("+10.97%"); // Sep 7.27 vs Aug 203 kWh/31 d (6.55)
  await expect(content).not.toContainText("+230.77%");
  await expect(page.locator("#workspaceSelect option:checked")).toHaveText("SmartWatts Demo Residences · Owner");
  await shot(page, "owner-overview");

  await nav(page, "Property Analytics");
  await settled(page);
  await expect(content).toContainText("₱7,095.00"); // 3 property bills: 2,233 + 2,398 + 2,464
  await expect(content).toContainText("6 bills · 645 kWh");
  await expect(content).toContainText("₱5,280.00"); // tenant statements: 1,628 + 1,760 + 1,892
  await expect(content).toContainText("480 kWh");
  await expect(content).toContainText("1 / 2");
  // Trend compares whole-property totals: Oct 224 kWh vs Sep 218 kWh (not Meter 101 vs Meter 102).
  await expect(content).toContainText("+6 kWh (2.8%)");
  await shot(page, "owner-analytics");
  // Three-month data → filter to one month.
  await page.locator('[data-form="analytics-filter"] input[name="from"]').fill("2026-09-01");
  await page.locator('[data-form="analytics-filter"] input[name="to"]').fill("2026-09-30");
  await page.locator('[data-form="analytics-filter"]').getByRole("button", { name: "Apply" }).click();
  await settled(page);
  await expect(content).toContainText("₱2,398.00");
  await expect(content).toContainText("2 bills · 218 kWh");
  await shot(page, "owner-analytics-september");

  await nav(page, "Meter Readings");
  await settled(page);
  for (const value of ["1,680", "1,508", "1,348", "1,200", "665", "613", "555", "500"]) await expect(content).toContainText(value);

  await nav(page, "Utility Bills");
  await settled(page);
  for (const amount of ["₱1,628.00", "₱605.00", "₱1,760.00", "₱638.00", "₱1,892.00", "₱572.00"]) await expect(content).toContainText(amount);
  await expect(content).not.toContainText(/\bpaid\b/i);
  await shot(page, "owner-bills");

  await nav(page, "Tenant Statements");
  await settled(page);
  await expect(content.getByText("Published", { exact: false }).first()).toBeVisible();
  await shot(page, "owner-statements");

  await nav(page, "Account Settings");
  await expect(content).toContainText(OWNER);
  await context.close();
});

test("tenant: NFC tap → Tenant dashboard for Unit 101 only", async ({ browser }) => {
  const { context, page } = await tapAndSignIn(browser, TENANT);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(page.locator("#pageTitle")).toHaveText("My Statements", { timeout: 20_000 });
  await settled(page);
  const content = page.locator("#content");
  await expect(page.getByTestId("demo-data-banner")).toContainText("Demo Data");
  await expect(content).toContainText("SmartWatts Demo Residences");
  await expect(content).toContainText("Unit 101");
  await expect(content).toContainText("Meter 101");
  for (const amount of ["₱1,628.00", "₱1,760.00", "₱1,892.00"]) await expect(content).toContainText(amount);
  for (const kwh of ["148 kWh", "160 kWh", "172 kWh"]) await expect(content).toContainText(kwh);
  // Vacant unit and owner-only material never appear.
  for (const hidden of ["Unit 102", "Meter 102", "₱605.00", "₱638.00", "₱572.00"]) await expect(content).not.toContainText(hidden);
  await expect(page.locator("#navigation")).not.toContainText("Utility Bills");
  await expect(page.locator("#navigation")).not.toContainText("Property Analytics");
  await shot(page, "tenant-statements");

  await nav(page, "My Meter History");
  await settled(page);
  for (const value of ["1,680", "1,508", "1,348", "1,200"]) await expect(content).toContainText(value);
  await expect(content).not.toContainText("Meter 102");
  await shot(page, "tenant-meters");

  await nav(page, "Account Settings");
  await expect(content).toContainText(TENANT);
  await context.close();
});

test("staff: NFC tap → no Rentals membership; the seed granted no platform claim", async ({ browser }) => {
  const { context, page } = await tapAndSignIn(browser, STAFF);
  await expect(page.getByRole("heading", { name: "No Rentals access on this account" })).toBeVisible({ timeout: 30_000 });
  const token = await idToken(STAFF);
  expect(await (await api("/api/platform/me", token)).json()).toEqual({ platformAdmin: false });
  await shot(page, "staff-nfc");
  await context.close();
});

test("server-side authorization: unauthenticated, tenant and staff requests are denied", async () => {
  expect((await api(`/api/rentals/properties/${PID}/analytics`)).status).toBe(401);
  expect((await api("/api/account/workspaces")).status).toBe(401);
  const tenant = await idToken(TENANT);
  for (const path of ["/analytics", "/utility-bills", "/readings", "/statements", "/units", "/subscription"]) {
    expect((await api(`/api/rentals/properties/${PID}${path}`, tenant)).status, path).toBe(403);
  }
  const staff = await idToken(STAFF);
  expect((await api(`/api/rentals/properties/${PID}/analytics`, staff)).status).toBe(404);
  expect((await api("/api/platform/subscriptions", staff)).status).toBe(403);
  const owner = await idToken(OWNER);
  const analytics = await (await api(`/api/rentals/properties/${PID}/analytics`, owner)).json();
  expect([analytics.totalOfficialBilledCentavos, analytics.totalTenantBilledCentavos]).toEqual([709_500, 528_000]);
  const empty = await (await api(`/api/rentals/properties/${PID}/analytics?from=2027-01-01&to=2027-03-31`, owner)).json();
  expect(empty.bills).toEqual([]);
});

test("NFC entry page carries no credentials or identities", async ({ request }) => {
  const html = await (await request.get("/nfc")).text();
  expect(html).not.toMatch(/idToken|refreshToken|password=|platformAdmin|rolexesto|schoolproware|demo-property/i);
});
