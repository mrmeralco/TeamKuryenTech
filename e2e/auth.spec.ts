import { expect, test, type Page } from "@playwright/test";

async function mockEmailVerification(page: Page) {
  let verified = false;
  const sentCodes: string[] = [];
  await page.route("**/api/auth/email-code/verify/send", async (route) => {
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sent: true }) });
  });
  await page.route("**/api/auth/email-code/verify/confirm", async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toMatch(/^Bearer /);
    const body = request.postDataJSON() as { code?: string };
    sentCodes.push(body.code ?? "");
    if (body.code === "123456") verified = true;
    await route.fulfill({ status: body.code === "123456" ? 200 : 400, contentType: "application/json", body: JSON.stringify(body.code === "123456" ? { verified: true } : { detail: "Invalid code." }) });
  });
  await page.route("**/api/auth/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verified }) });
  });
  return { sentCodes };
}

test("public landing routes lead into guarded dashboard access", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /Log in/i })).toBeVisible();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.locator("#reg-email")).toBeVisible();
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: /reset|password/i }).first()).toBeVisible();
  await expect(pageErrors).toEqual([]);
});

test("email registration verifies by OTP, persists the session and personal records, then signs in again", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const verification = await mockEmailVerification(page);

  await page.goto("/register");
  const email = `landing-emulator-${Date.now()}@example.invalid`;
  const password = `Emulator-${crypto.randomUUID()}-9!`;
  await page.locator("#reg-name").fill("SmartWatts Landing Tester");
  await page.locator("#reg-email").fill(email);
  await page.locator("#reg-password").fill(password);
  await page.getByRole("button", { name: "Create account with email" }).click();
  await expect(page).toHaveURL(/\/login\?verify=1$/);
  await expect(page.getByRole("heading", { name: "Enter verification code" })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("6-digit verification code").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator("#navigation")).toBeVisible();

  const account = await page.evaluate(async () => {
    const { auth } = await import("/src/lib/firebase.ts");
    await auth?.authStateReady();
    return {
      uid: auth?.currentUser?.uid ?? null,
      email: auth?.currentUser?.email ?? null,
      anonymous: auth?.currentUser?.isAnonymous ?? true,
      provider: auth?.currentUser?.providerData[0]?.providerId ?? null,
    };
  });
  expect(account).toMatchObject({ email, anonymous: false, provider: "password" });
  expect(account.uid).toBeTruthy();
  expect(verification.sentCodes).toEqual(["123456"]);

  await page.evaluate(async () => {
    const store = await import("/src/lib/personal/store.ts");
    await store.saveUserProfile({ displayName: "SmartWatts Landing Tester", preferredLanguage: "tl" });
    await store.saveAppliance({
      name: "Landing Test Refrigerator",
      category: "refrigeration",
      watts: 0,
      quantity: 1,
      hoursPerDay: 24,
      daysPerWeek: 7,
      scheduleNote: "Emulator-only record.",
      source: "manual",
      testedKwhMonth: 26.1,
    });
  });
  await page.reload();
  await expect(page.locator("#navigation")).toBeVisible();
  expect(await page.evaluate(async () => (await import("/src/lib/firebase.ts")).auth?.currentUser?.uid ?? null)).toBe(account.uid);
  expect(await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).loadPreferredLanguage())).toBe("tl");
  expect(await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).listAppliances())).toMatchObject([
    { name: "Landing Test Refrigerator", testedKwhMonth: 26.1 },
  ]);

  await page.locator("#logoutButton").click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/login");
  await page.locator("#li-email").fill(email);
  await page.locator("#li-pass").fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect.poll(() => page.evaluate(async () => {
    const { auth } = await import("/src/lib/firebase.ts");
    await auth?.authStateReady();
    return auth?.currentUser?.uid ?? null;
  })).toBe(account.uid);
  expect(pageErrors).toEqual([]);
});

test("Google login uses Firebase Auth Emulator and stays behind the verified-session guard", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/auth/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verified: true }) }));
  await page.goto("/login");
  const popupPromise = page.waitForEvent("popup", { timeout: 10_000 });
  await page.getByRole("button", { name: "Continue with Google" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await popup.getByText("Add new account", { exact: true }).click();
  await popup.locator("#email-input").fill(`google-emulator-${Date.now()}@example.com`);
  await expect(popup.locator("#sign-in")).toBeEnabled();
  await popup.getByRole("button", { name: "Sign in with Google.com" }).click();
  await Promise.race([
    page.waitForURL(/\/dashboard$/, { timeout: 20_000 }).catch(() => undefined),
    page.locator('[role="alert"]').waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined),
  ]);
  const googleAlerts = (await page.locator('[role="alert"]').allTextContents()).map((message) => message.trim()).filter(Boolean);
  expect(page.url(), `Google sign-in stayed on the login page. UI messages: ${googleAlerts.join(" | ") || "none"}`).toMatch(/\/dashboard$/);
  const provider = await page.evaluate(async () => {
    const { auth } = await import("/src/lib/firebase.ts");
    await auth?.authStateReady();
    return auth?.currentUser?.providerData.map((item) => item.providerId) ?? [];
  });
  expect(provider).toContain("google.com");
  await page.reload();
  await expect(page.locator("#navigation")).toBeVisible();
  await page.locator("#logoutButton").click();
  await expect(page).toHaveURL(/\/$/);
  expect(pageErrors).toEqual([]);
});
