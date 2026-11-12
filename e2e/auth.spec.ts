import { expect, test } from "@playwright/test";

test("notifications render and remain usable without a missing-symbol runtime error", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#navigation")).toBeVisible();
  await page.locator('#navigation [data-page="notifications"]').click();
  await expect(page.locator("#content")).toContainText("Sample Usage Alert");
  await expect(page.locator("#content .alert").first()).toHaveAttribute("data-notif-id", "notif-seed-1");
  await page.locator('#content [data-action="markRead"]').click();
  await expect(page.locator("#content .unread-dot")).toHaveCount(0);
  await expect(page.locator("#notificationBadge")).toHaveCSS("display", "none");
  expect(pageErrors).toEqual([]);
});

test("email registration links the anonymous UID and persists profile and tested-energy appliance data", async ({ browser }) => {
  const pageErrors: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto("/");
    await page.locator('#navigation [data-page="devices"]').click();
    await expect(page.locator('[data-form="appliance-save"]')).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const { auth } = await import("/src/lib/firebase.ts");
      await auth?.authStateReady();
      return auth?.currentUser?.isAnonymous ?? false;
    })).toBe(true);
    const guest = await page.evaluate(async () => {
      const { auth } = await import("/src/lib/firebase.ts");
      await auth?.authStateReady();
      return { uid: auth?.currentUser?.uid ?? null, anonymous: auth?.currentUser?.isAnonymous ?? false };
    });
    expect(guest.uid).toBeTruthy();
    expect(guest.anonymous).toBe(true);
    const missingGuestProfile = await page.evaluate(async () => {
      const store = await import("/src/lib/personal/store.ts");
      return { profile: await store.loadUserProfile(), language: await store.loadPreferredLanguage() };
    });
    expect(missingGuestProfile).toEqual({
      profile: {
        displayName: null,
        preferredLanguage: null,
        dwellingType: null,
        utilityRecordType: null,
        baselineKwh: null,
        baselinePeriodEnd: null,
      },
      language: null,
    });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const email = `smartwatts-emulator-${suffix}@example.invalid`;
    const password = `Emulator-${crypto.randomUUID()}-9!`;
    await page.locator('#navigation [data-page="account"]').click();
    const createForm = page.locator('[data-form="account-create"]');
    await createForm.locator('[name="displayName"]').fill("SmartWatts Emulator Tester");
    await createForm.locator('[name="dwellingType"]').selectOption("homeowner");
    await createForm.locator('[name="utilityRecordType"]').selectOption("meralco_bill");
    await createForm.locator('[name="baselineKwh"]').fill("235.5");
    await createForm.locator('[name="baselinePeriodEnd"]').fill("2026-10-31");
    await createForm.locator('[name="email"]').fill(` ${email} `);
    await createForm.locator('[name="password"]').fill(password);
    await createForm.locator('button[type="submit"]').click();
    await expect.poll(async () => page.evaluate(async () => {
      const { auth } = await import("/src/lib/firebase.ts");
      await auth?.authStateReady();
      return !!auth?.currentUser && !auth.currentUser.isAnonymous;
    }), { timeout: 20_000 }).toBe(true);
    await page.locator('#navigation [data-page="account"]').click();
    await expect(page.locator("#content")).toContainText("Signed in as", { timeout: 20_000 });
    await expect(page.locator("#toast")).toContainText("Account created", { timeout: 20_000 });
    const linked = await page.evaluate(async () => {
      const { auth } = await import("/src/lib/firebase.ts");
      await auth.authStateReady();
      return { uid: auth?.currentUser?.uid ?? null, anonymous: auth?.currentUser?.isAnonymous ?? true, email: auth?.currentUser?.email ?? null };
    });
    expect(linked).toEqual({ uid: guest.uid, anonymous: false, email });

    const profile = await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).loadUserProfile());
    expect(profile).toMatchObject({
      displayName: "SmartWatts Emulator Tester",
      preferredLanguage: "en",
      dwellingType: "homeowner",
      utilityRecordType: "meralco_bill",
      baselineKwh: 235.5,
      baselinePeriodEnd: "2026-10-31",
    });
    await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).saveUserProfile({ preferredLanguage: "tl" }));
    expect(await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).loadPreferredLanguage())).toBe("tl");
    await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).ensureUserProfile({
      displayName: "Should Not Replace Existing Name",
      preferredLanguage: "ko",
    }));
    expect(await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).loadUserProfile())).toMatchObject({
      displayName: "SmartWatts Emulator Tester",
      preferredLanguage: "tl",
      baselineKwh: 235.5,
      baselinePeriodEnd: "2026-10-31",
    });

    await page.locator('#navigation [data-page="account"]').click();
    await page.locator('#content [data-act="sign-out"]').click();
    const signInForm = page.locator('[data-form="account-sign-in"]');
    await expect(signInForm).toBeVisible();
    await signInForm.locator('[name="email"]').fill(email);
    await signInForm.locator('[name="password"]').fill(password);
    await signInForm.locator('button[type="submit"]').click();
    await expect(page.locator("#content")).toContainText("Signed in as", { timeout: 20_000 });
    const returningAccount = await page.evaluate(async () => (await import("/src/lib/firebase.ts")).auth?.currentUser?.uid ?? null);
    expect(returningAccount).toBe(linked.uid);
    expect(await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).loadUserProfile())).toMatchObject({
      displayName: "SmartWatts Emulator Tester",
      preferredLanguage: "tl",
    });

    await page.locator('#navigation [data-page="devices"]').click();
    const applianceForm = page.locator('[data-form="appliance-save"]');
    await applianceForm.locator('[name="name"]').fill("Emulator Refrigerator");
    await applianceForm.locator('[name="category"]').selectOption("refrigeration");
    await applianceForm.locator('[name="watts"]').fill("0");
    await applianceForm.locator('[name="testedKwhMonth"]').fill("26.10");
    await applianceForm.locator('[name="quantity"]').fill("1");
    await applianceForm.locator('[name="hoursPerDay"]').fill("24");
    await applianceForm.locator('[name="daysPerWeek"]').fill("7");
    await applianceForm.locator('[name="scheduleNote"]').fill("Manufacturer tested monthly energy label.");
    await applianceForm.locator('button[type="submit"]').click();
    await expect(page.locator('[data-slot="appliances"]')).toContainText("Emulator Refrigerator");
    await expect(page.locator('[data-slot="appliances"]')).toContainText("26.1 kWh/mo");
    await page.locator('#navigation [data-page="notifications"]').click();
    await expect(page.locator("#content .alert").first()).toContainText("Emulator Refrigerator");
    await page.locator('#navigation [data-page="devices"]').click();

    let appliances = await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).listAppliances());
    expect(appliances).toHaveLength(1);
    const first = appliances[0];
    expect(first).toMatchObject({ id: expect.any(String), name: "Emulator Refrigerator", watts: 0, testedKwhMonth: 26.1 });
    await page.reload();
    await page.locator('#navigation [data-page="devices"]').click();
    await expect(page.locator('[data-slot="appliances"]')).toContainText("Emulator Refrigerator");
    expect(await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).loadUserProfile())).toMatchObject({
      displayName: "SmartWatts Emulator Tester",
      preferredLanguage: "tl",
    });

    await page.evaluate(async (id) => {
      const store = await import("/src/lib/personal/store.ts");
      const records = await store.listAppliances();
      await store.saveAppliance({ ...records.find((record) => record.id === id)!, id, scheduleNote: "Updated in emulator E2E." });
    }, first.id);
    appliances = await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).listAppliances());
    expect(appliances[0].scheduleNote).toBe("Updated in emulator E2E.");

    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    secondPage.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await secondPage.goto("/");
      await secondPage.locator('#navigation [data-page="devices"]').click();
      await expect.poll(async () => secondPage.evaluate(async () => {
        const { auth } = await import("/src/lib/firebase.ts");
        await auth?.authStateReady();
        return auth?.currentUser?.isAnonymous ?? false;
      })).toBe(true);
      const secondGuest = await secondPage.evaluate(async () => {
        const { auth } = await import("/src/lib/firebase.ts");
        await auth?.authStateReady();
      return auth?.currentUser?.uid ?? null;
      });
      await secondPage.locator('#navigation [data-page="account"]').click();
      const secondForm = secondPage.locator('[data-form="account-create"]');
      await secondForm.locator('[name="displayName"]').fill("Second Emulator Account");
      await secondForm.locator('[name="dwellingType"]').selectOption("homeowner");
      await secondForm.locator('[name="utilityRecordType"]').selectOption("meralco_bill");
      await secondForm.locator('[name="baselineKwh"]').fill("210");
      await secondForm.locator('[name="baselinePeriodEnd"]').fill("2026-10-31");
      await secondForm.locator('[name="email"]').fill(email);
      await secondForm.locator('[name="password"]').fill(password);
      await secondForm.locator('button[type="submit"]').click();
      await expect(secondPage.locator("#toast")).toContainText("already has an account", { timeout: 15_000 });
      const actualDuplicateErrorCode = await secondPage.evaluate(async ({ email: duplicateEmail, password: duplicatePassword }) => {
        const { createPermanentAccount } = await import("/src/lib/account.ts");
        try {
          await createPermanentAccount(duplicateEmail, duplicatePassword);
          return "no-error";
        } catch (error) {
          return (error as { code?: string }).code ?? "unknown-error";
        }
      }, { email, password });
      expect(actualDuplicateErrorCode).toBe("auth/email-already-in-use");
      const afterCollision = await secondPage.evaluate(async () => {
        const { auth } = await import("/src/lib/firebase.ts");
        return { uid: auth?.currentUser?.uid ?? null, anonymous: auth?.currentUser?.isAnonymous ?? false };
      });
      expect(afterCollision).toEqual({ uid: secondGuest, anonymous: true });

      const otherEmail = `smartwatts-emulator-other-${suffix}@example.invalid`;
      await secondForm.locator('[name="email"]').fill(otherEmail);
      await secondForm.locator('[name="password"]').fill(`Other-${crypto.randomUUID()}-9!`);
      await secondForm.locator('button[type="submit"]').click();
      await expect(secondPage.locator("#content")).toContainText("Signed in as", { timeout: 20_000 });
      const otherUid = await secondPage.evaluate(async () => (await import("/src/lib/firebase.ts")).auth?.currentUser?.uid ?? null);
      expect(otherUid).toBeTruthy();
      expect(otherUid).not.toBe(linked.uid);
      await secondPage.locator('#navigation [data-page="notifications"]').click();
      await expect(secondPage.locator("#content")).not.toContainText("Emulator Refrigerator");

      const otherToken = await secondPage.evaluate(async () => (await import("/src/lib/firebase.ts")).auth?.currentUser?.getIdToken() ?? null);
      expect(otherToken).toBeTruthy();
      const response = await fetch(`http://127.0.0.1:18080/v1/projects/demo-smartwatts/databases/(default)/documents/users/${linked.uid}/appliances/${first.id}`, {
        headers: { Authorization: `Bearer ${otherToken!}` },
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.status).toBe("PERMISSION_DENIED");
    } finally {
      await secondContext.close();
    }

    await page.locator('[data-act="appliance-delete"]').click();
    await expect(page.locator('[data-slot="appliances"]')).not.toContainText("Emulator Refrigerator");
    appliances = await page.evaluate(async () => (await import("/src/lib/personal/store.ts")).listAppliances());
    expect(appliances).toHaveLength(0);
    await page.reload();
    const afterRefresh = await page.evaluate(async () => {
      const { auth } = await import("/src/lib/firebase.ts");
      await auth?.authStateReady();
      return { uid: auth?.currentUser?.uid ?? null, permanent: !!auth?.currentUser && !auth.currentUser.isAnonymous };
    });
    expect(afterRefresh).toEqual({ uid: linked.uid, permanent: true });
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
