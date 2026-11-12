import { expect, test, type Browser, type BrowserContext, type Page, devices } from "@playwright/test";

// One SmartWatts NFC card URL for everyone: "/nfc". Identity comes from the Firebase session
// (Auth emulator), never from the URL. Accounts below are synthetic emulator fixtures.
const AUTH = `http://127.0.0.1:${process.env.NFC_E2E_AUTH_PORT ?? "9099"}`;
const PASSWORD = "Correct-horse-battery-9!";
const run = Date.now().toString(36);
const PROPERTY = { propertyId: "prop_demo_1", propertyName: "Demo Residences" };

interface Account { email: string; uid: string }

async function createAccount(label: string): Promise<Account> {
  const email = `nfc-${label}-${run}@example.com`;
  const created = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/demo-smartwatts/accounts`, {
    method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(created.ok).toBe(true);
  const uid = (await created.json()).localId as string;
  const verified = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/demo-smartwatts/accounts:update`, {
    method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ localId: uid, emailVerified: true }),
  });
  expect(verified.ok).toBe(true);
  return { email, uid };
}

let owner: Account;
let tenant: Account;
let multi: Account;
let stranger: Account;

test.beforeAll(async () => {
  [owner, tenant, multi, stranger] = await Promise.all(["owner", "tenant", "multi", "stranger"].map(createAccount));
});

/** UID from the emulator ID token (unsigned in the emulator; the real backend verifies signatures). */
function uidFromAuthHeader(header: string | undefined): string | null {
  const token = header?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).user_id ?? null;
  } catch {
    return null;
  }
}

/** Stub API: memberships are decided by the signed-in UID, like GET /api/account/workspaces. */
async function stubApi(page: Page | BrowserContext, options: { workspacesStatus?: number } = {}) {
  const seen: string[] = [];
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"stubbed"}' }));
  await page.route("**/api/platform/me", (route) => route.fulfill({ json: { platformAdmin: false } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { verified: true } }));
  await page.route("**/api/account/workspaces", (route) => {
    const uid = uidFromAuthHeader(route.request().headers().authorization);
    seen.push(uid ?? "none");
    if (!uid) return route.fulfill({ status: 401, json: { detail: "A Firebase sign-in is required." } });
    if (options.workspacesStatus) return route.fulfill({ status: options.workspacesStatus, json: { detail: "x" } });
    const rentalMemberships =
      uid === owner.uid ? [{ ...PROPERTY, role: "owner", unitId: null, unitLabel: null, lifecycle: "pending_activation" }]
      : uid === tenant.uid ? [{ ...PROPERTY, role: "tenant", unitId: "unit_1", unitLabel: "Unit 1", lifecycle: null }]
      : uid === multi.uid ? [
        { ...PROPERTY, role: "owner", unitId: null, unitLabel: null, lifecycle: "active" },
        { propertyId: "prop_demo_2", propertyName: "Second Court", role: "tenant", unitId: "unit_9", unitLabel: "Unit 9", lifecycle: null },
      ]
      : [];
    return route.fulfill({ json: { personal: { tier: 1 }, rentalMemberships, canCreateProperty: true } });
  });
  return seen;
}

async function signIn(page: Page, account: Account) {
  await page.locator("#li-email").fill(account.email);
  await page.locator("#li-pass").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}

async function tapCard(page: Page, path = "/nfc") {
  await page.goto(path);
}

async function expectDashboard(page: Page, title: string) {
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await expect(page.locator("#pageTitle")).toHaveText(title, { timeout: 20_000 });
}

async function newPage(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await stubApi(context);
  return { context, page: await context.newPage() };
}

test("NFC route loads with the branded entry page and carries no credentials", async ({ page, request }) => {
  await stubApi(page);
  const direct = await request.get("/nfc");
  expect(direct.status()).toBe(200);
  const html = await direct.text();
  expect(html).toContain('alt="SmartWatts"');
  expect(html).toContain("Opening SmartWatts");
  expect(html).not.toMatch(/idToken|refreshToken|password=|platformAdmin|role=owner|uid=|@gmail/i);
  await page.goto("/nfc");
  // Signed out: the existing login flow takes over, keeping only the fixed "nfc" return key.
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  expect(await page.evaluate(() => sessionStorage.getItem("smartwatts-return-to"))).toBe("nfc");
});

test("signed-out tap → login → Owner Overview of the authorized property", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await tapCard(page);
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 }); // #next=nfc is consumed from the address bar
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await signIn(page, owner);
  await expectDashboard(page, "Property Overview");
  await expect(page.locator("#workspaceSwitcher")).toHaveCount(1);
  const workspace = await page.evaluate(() => JSON.parse(localStorage.getItem("smartwatts-workspace") ?? "null"));
  expect(workspace).toEqual({ type: "rental", propertyId: PROPERTY.propertyId });
  // Pending activation is not bypassed: the Subscription page stays in the owner nav and staff tools are absent.
  await expect(page.locator("#navigation")).toContainText("Subscription");
  await expect(page.locator("#navigation")).not.toContainText("Rentals Subscriptions");
  await context.close();
});

test("signed-in tenant tapping the same card opens their tenant workspace", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await page.goto("/login");
  await signIn(page, tenant);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await tapCard(page);
  await expectDashboard(page, "My Statements");
  await expect(page.locator("#navigation")).not.toContainText("Units & Tenants");
  await expect(page.locator("#navigation")).not.toContainText("Rentals Subscriptions");
  await context.close();
});

test("refreshing /nfc after login routes again (deep link + session restore)", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await page.goto("/login");
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await page.goto("/nfc");
  await expectDashboard(page, "Property Overview");
  await page.goto("/nfc/");
  await expectDashboard(page, "Property Overview");
  await context.close();
});

test("multiple memberships show an authorized chooser", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await page.goto("/login");
  await signIn(page, multi);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await tapCard(page);
  await expect(page.getByRole("heading", { name: "Choose a property" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Second Court/ }).click();
  await expectDashboard(page, "My Statements");
  await context.close();
});

test("an account without a Rentals membership is not let in", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await page.goto("/login");
  await signIn(page, stranger);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await tapCard(page, `/nfc?p=${PROPERTY.propertyId}`); // a copied property hint grants nothing
  await expect(page.getByRole("heading", { name: "No Rentals access on this account" })).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem("smartwatts-workspace") ?? "")).not.toContain(PROPERTY.propertyId);
  await context.close();
});

test("open-redirect attempts are ignored", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await page.goto("/login#next=https://evil.example/");
  await signIn(page, owner);
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:5181\/dashboard$/, { timeout: 20_000 });
  await page.goto("/nfc?next=https://evil.example&redirect=//evil.example&returnTo=javascript:alert(1)");
  await expectDashboard(page, "Property Overview");
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:5181");
  await context.close();
});

test("switching accounts clears the previous account's workspace", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await page.goto("/login");
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await tapCard(page);
  await expectDashboard(page, "Property Overview");
  await page.locator("#logoutButton").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await tapCard(page);
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  await signIn(page, tenant);
  await expectDashboard(page, "My Statements");
  await context.close();
});

test("API session rejection shows the expired-session state", async ({ browser }) => {
  const context = await browser.newContext();
  await stubApi(context, { workspacesStatus: 401 });
  const page = await context.newPage();
  await page.goto("/login");
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await tapCard(page);
  await expect(page.getByRole("heading", { name: "Your session has expired" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
  await context.close();
});

test("network failure shows a retry state", async ({ browser }) => {
  const context = await browser.newContext();
  await stubApi(context, { workspacesStatus: 503 });
  const page = await context.newPage();
  await page.goto("/login");
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await tapCard(page);
  await expect(page.getByRole("heading", { name: "Can't reach SmartWatts" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await context.close();
});

for (const [name, device] of [["Android Chrome (Pixel 7)", devices["Pixel 7"]], ["iPhone 13 viewport", devices["iPhone 13"]]] as const) {
  test(`mobile landing layout fits: ${name}`, async ({ browser }) => {
    const { defaultBrowserType: _ignored, ...options } = device;
    const { context, page } = await newPage(browser, options);
    await page.goto("/login");
    await signIn(page, multi);
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
    await tapCard(page);
    await expect(page.getByRole("heading", { name: "Choose a property" })).toBeVisible({ timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await page.getByRole("button", { name: /Demo Residences/ }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44); // touch target
    await page.screenshot({ path: `test-results/nfc-${name.split(" ")[0].toLowerCase()}.png` });
    await context.close();
  });
}
