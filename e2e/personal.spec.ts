import { expect, test } from "@playwright/test";

// Tier 1 (SmartWatts Personal) in local demo mode: no Firebase configured,
// so personal data is stored on this device only.
test.beforeEach(async ({ page }) => {
  await page.goto("/dashboard");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("plans page offers exactly two tiers and no IoT hardware", async ({ page }) => {
  await page.getByRole("button", { name: "Plans" }).click();
  const cards = page.locator(".plan-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("SmartWatts Personal");
  await expect(cards.nth(0)).toContainText("Free");
  await expect(cards.nth(1)).toContainText("SmartWatts Rentals");
  await expect(cards.nth(1)).toContainText("₱299.00");
  await expect(cards.nth(1)).toContainText("Up to 10 rental units");
  await expect(page.locator("body")).not.toContainText(/Tier 3|Property Pro/i);
  await expect(page.locator(".plan-grid")).not.toContainText(/camera|IoT/i);
  await expect(page.getByText("does not use IoT cameras")).toBeVisible();
});

test("simulated usage is labelled as sample data, never as a live meter", async ({ page }) => {
  await expect(page.locator(".stats")).not.toContainText("Live");
  await page.getByRole("button", { name: "Usage Patterns" }).click();
  await expect(page.locator("#content")).not.toContainText(/Connected|Last sync|Live reading/);
  await expect(page.locator("#content .kind-sample").first()).toBeVisible();
  await expect(page.getByText("No meter is connected.")).toBeVisible();
});

test("register appliances, simulate savings, and save a plan", async ({ page }) => {
  await page.getByRole("button", { name: "My Appliances" }).click();
  await expect(page.getByText("saved on this device only")).toBeVisible();
  const form = page.locator('[data-form="appliance-save"]');
  await form.getByLabel("Name").fill("Bedroom aircon");
  await form.getByLabel("Category").selectOption("cooling");
  await form.getByLabel("Power (watts)").fill("1000");
  await form.getByLabel("Hours used per day").fill("8");
  await form.getByLabel("Usage schedule (optional)").fill("9 PM – 5 AM");
  await form.getByRole("button", { name: "Save appliance" }).click();
  await expect(page.locator('[data-slot="appliances"]')).toContainText("Bedroom aircon");
  await expect(page.locator('[data-slot="appliances"]')).toContainText("243.5");
  await expect(page.locator('[data-slot="appliances"] .kind-estimate').first()).toHaveText("Estimate");

  await page.getByRole("button", { name: "Bill Upload & History" }).click();
  const bill = page.locator('[data-form="bill-save"]');
  await bill.getByLabel("Period start").fill("2026-09-01");
  await bill.getByLabel("Period end").fill("2026-09-30");
  await bill.getByLabel("Billed kWh").fill("200");
  await bill.getByLabel("Total current charges (₱)").fill("2,450.00");
  await bill.getByRole("button", { name: "Save bill" }).click();
  await expect(page.locator('[data-slot="bills"]')).toContainText("₱2,450.00");
  await expect(page.locator('[data-slot="bill-rate"]')).toContainText("₱12.25");

  await page.getByRole("button", { name: "Savings Simulator" }).click();
  await expect(page.getByLabel("Your rate (₱ per kWh)")).toHaveValue("12.25");
  await page.getByLabel("Planned hours per day for Bedroom aircon").fill("6");
  await page.getByRole("button", { name: "Simulate" }).click();
  await expect(page.locator('[data-slot="simulation-result"]')).toContainText("₱745.66");
  await page.getByLabel("Save as plan").fill("Cooler nights");
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect(page.locator('[data-slot="plans"]')).toContainText("Cooler nights");

  await page.reload();
  await page.getByRole("button", { name: "My Appliances" }).click();
  await expect(page.locator('[data-slot="appliances"]')).toContainText("Bedroom aircon");
});

test("user-entered text is escaped, not executed", async ({ page }) => {
  await page.getByRole("button", { name: "My Appliances" }).click();
  const form = page.locator('[data-form="appliance-save"]');
  await form.getByLabel("Name").fill('<img src=x onerror="window.__xss=1">');
  await form.getByLabel("Power (watts)").fill("10");
  await form.getByLabel("Hours used per day").fill("1");
  await form.getByRole("button", { name: "Save appliance" }).click();
  await expect(page.locator('[data-slot="appliances"]')).toContainText("<img src=x");
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("appliance scanner provides camera, upload, and manual entry with live estimates and privacy controls", async ({ page }) => {
  await page.getByRole("button", { name: "My Appliances" }).click();

  // 1. Verify entry paths
  const scanBtn = page.locator(".scanner-btn", { hasText: "Scan Appliance Label" });
  await expect(scanBtn).toBeVisible();
  const cameraInput = scanBtn.locator('input[type="file"]');
  await expect(cameraInput).toHaveAttribute("capture", "environment");

  const uploadBtn = page.locator(".scanner-btn", { hasText: "Upload Label Photo" });
  await expect(uploadBtn).toBeVisible();

  const manualBtn = page.locator('button[data-act="scanner-manual-mode"]');
  await expect(manualBtn).toBeVisible();
  await manualBtn.click();
  await expect(page.locator('[data-form="appliance-save"] input[name="name"]')).toBeFocused();

  // 2. Verify live estimation calculation
  const form = page.locator('[data-form="appliance-save"]');
  await form.getByLabel("Power (watts)").fill("1200");
  await form.getByLabel("Hours used per day").fill("10");
  await expect(page.locator('[data-slot="appliance-live-kwh"]')).toContainText("365.25 kWh / month");

  // Adjust hours -> live estimate updates
  await form.getByLabel("Hours used per day").fill("5");
  await expect(page.locator('[data-slot="appliance-live-kwh"]')).toContainText("182.63 kWh / month");

  // 3. Verify image upload preview, rotation toolbar, and discard
  // Create a minimal 1x1 test image to upload
  const buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  await uploadBtn.locator('input[type="file"]').setInputFiles({
    name: "rating-plate.png",
    mimeType: "image/png",
    buffer,
  });

  // Verify preview box and toolbar appear
  await expect(page.locator(".scanner-box")).toBeVisible();
  await expect(page.locator('button[data-act="scanner-rotate-cw"]')).toBeVisible();
  await expect(page.locator('button[data-act="scanner-rotate-ccw"]')).toBeVisible();
  const discardBtn = page.locator('button[data-act="scanner-discard"]');
  await expect(discardBtn).toBeVisible();

  // Discard image clears preview (privacy)
  await discardBtn.click();
  await expect(page.locator(".scanner-box")).not.toBeVisible();
  await expect(page.locator('[data-slot="scanner-preview"]')).toBeEmpty();

  // 4. Privacy note
  await expect(page.getByText(/saved on this device only|Landlords and property managers can never see this data/)).toBeVisible();
});

test("Personal appliance registration supports Energy Efficiency Label with tested kWh/month without requiring wattage", async ({ page }) => {
  await page.getByRole("button", { name: "My Appliances" }).click();
  await expect(page.getByText("saved on this device only")).toBeVisible();

  const form = page.locator('[data-form="appliance-save"]');
  await form.getByLabel("Name").fill("LG Inverter Refrigerator");
  await form.getByLabel("Brand (optional)").fill("LG");
  await form.getByLabel("Model (optional)").fill("GR-B202SQBB");
  await form.getByLabel("Category").selectOption("refrigeration");
  // Set tested kWh/month to 26.1 and leave watts empty
  await form.getByLabel("Tested energy (kWh/month, optional)").fill("26.1");
  await form.getByLabel("Energy efficiency rating (optional)").fill("253");
  await form.getByLabel("Power (watts)").fill("");

  // Live estimate reflects the tested monthly consumption
  await expect(page.locator('[data-slot="appliance-live-kwh"]')).toContainText("26.1 kWh / month");

  // Save the appliance
  await form.getByRole("button", { name: "Save appliance" }).click();

  // Verify saved in appliance list with (Energy Label) tag and EER
  await expect(page.locator('[data-slot="appliances"]')).toContainText("LG Inverter Refrigerator");
  await expect(page.locator('[data-slot="appliances"]')).toContainText("26.1 kWh/mo (Energy Label)");
  await expect(page.locator('[data-slot="appliances"]')).toContainText("EER: 253");
});

test("Rentals explains its requirements when Firebase is not configured", async ({ page }) => {
  await page.getByRole("button", { name: "SmartWatts Rentals" }).click();
  await expect(page.getByText("require legal and regulatory review").first()).toBeVisible();
  await expect(page.getByText("needs Firebase and the SmartWatts API")).toBeVisible();
});

test("real LG refrigerator energy label populates 26.10 kWh/month via actual OCR and persists", async ({ page }, testInfo) => {
  // No OCR mocking: the real fixture goes through Tesseract.js in the browser.
  test.setTimeout(150_000);
  await page.locator("#navigation [data-page=devices]").click();
  const form = page.locator('[data-form="appliance-save"]');
  await page.locator('input[data-ocr="appliance-label"]').last().setInputFiles("tests/fixtures/ph-refrigerator-energy-label.jpg");

  await expect(form.locator('input[name="model"]')).toHaveValue("GR-B202SQBB", { timeout: 120_000 });
  const tested = form.locator('input[name="testedKwhMonth"]');
  const check = async () => {
    await expect(form.locator('input[name="name"]')).toHaveValue("LG Refrigerator");
    await expect(form.locator('input[name="brand"]')).toHaveValue("LG");
    await expect(form.locator('select[name="category"]')).toHaveValue("refrigeration");
    await expect(form.locator('input[name="watts"]')).toHaveValue("");
    await expect(tested).toHaveValue("26.10");
    await expect(form.locator('input[name="energyEfficiencyRating"]')).not.toHaveValue("2023");
    await expect(form.locator('input[name="labelType"]')).toHaveValue("ENERGY_EFFICIENCY");
    await expect(form.locator('input[name="consumptionBasis"]')).toHaveValue("monthly_test");
    await expect(form.locator('input[name="source"]')).toHaveValue("ocr");
  };
  await check();
  // Values must survive post-OCR work (status rendering, translation pass).
  await page.waitForTimeout(2_000);
  await check();

  // Estimate uses the 26.10 kWh/month baseline; the default 8 h/day is NOT multiplied in.
  await expect(form.locator('[data-slot="appliance-live-kwh"]')).toHaveText("26.1 kWh / month");
  await expect(form.locator('[data-slot="appliance-live-basis"]')).toContainText("manufacturer tested monthly consumption (26.10 kWh/month");
  await testInfo.attach("after-ocr", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  await form.getByRole("button", { name: "Save appliance" }).click();
  const list = page.locator('[data-slot="appliances"]');
  await expect(list).toContainText("LG Refrigerator");
  await expect(list).toContainText("LG · GR-B202SQBB");
  await expect(list).toContainText("26.1 kWh/mo (Energy Label)");

  await page.reload();
  await page.locator("#navigation [data-page=devices]").click();
  await expect(page.locator('[data-slot="appliance-summary"]')).toContainText("26.1 kWh");
  await expect(list).toContainText("LG · GR-B202SQBB");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("smartwatts-personal-v1") ?? "{}").appliances?.[0]);
  expect(saved).toMatchObject({
    name: "LG Refrigerator", brand: "LG", model: "GR-B202SQBB", category: "refrigeration", watts: 0,
    testedKwhMonth: 26.1, labelType: "ENERGY_EFFICIENCY", consumptionBasis: "monthly_test", source: "ocr",
  });
  expect(saved.energyEfficiencyRating ?? null).not.toBe(2023);
});

test("itemized bill feeds a per-category savings estimate with stated assumptions", async ({ page }) => {
  await page.locator("#navigation [data-page=devices]").click();
  const appliance = page.locator('[data-form="appliance-save"]');
  await appliance.getByLabel("Name").fill("Aircon");
  await appliance.getByLabel("Power (watts)").fill("1000");
  await appliance.getByLabel("Hours used per day").fill("8");
  await appliance.getByRole("button", { name: "Save appliance" }).click();
  await expect(page.locator('[data-slot="appliances"]')).toContainText("Aircon");

  await page.locator("#navigation [data-page=bills]").click();
  await expect(page.getByText("never uploaded or stored")).toBeVisible();
  const bill = page.locator('[data-form="bill-save"]');
  await bill.getByLabel("Period start").fill("2026-09-12");
  await bill.getByLabel("Period end").fill("2026-10-11");
  await bill.getByLabel("Billed kWh").fill("200");
  await bill.getByLabel("Total current charges (₱)").fill("2,400.00");
  await bill.locator("summary", { hasText: "Charge breakdown" }).click();
  await bill.getByLabel("Generation").fill("1,500.00");
  await bill.getByLabel("Distribution").fill("600.00");
  await bill.getByLabel("Subsidies (lifeline / senior citizen)").fill("-100.00");
  await bill.getByLabel("Taxes").fill("400.00");
  await bill.getByRole("button", { name: "Save bill" }).click();
  await expect(page.locator("#toast")).toContainText("breakdown matches the total");
  await expect(page.locator('[data-slot="bills"]')).toContainText("₱2,400.00");

  await page.locator("#navigation [data-page=simulator]").click();
  await expect(page.getByLabel("Your rate (₱ per kWh)")).toHaveValue("12.00");
  await page.getByLabel("Planned hours per day for Aircon").fill("6");
  await page.getByRole("button", { name: "Simulate" }).click();
  const result = page.locator('[data-slot="simulation-result"]');
  // 243.5 → 182.63 kWh/month (estimates). Per-category rates from the bill (₱7.50, ₱3.00, -₱0.50, ₱2.00 per kWh),
  // each rounded to the centavo: ₱2,922.00 → ₱2,191.57, so savings = ₱730.43.
  await expect(result).toContainText("60.87 kWh per month");
  await expect(result).toContainText("₱2,922.00 now → ₱2,191.57 planned");
  await expect(result).toContainText("₱730.43");
  await expect(result.locator("table")).toContainText("Generation");
  await expect(result.locator("table")).toContainText("Subsidies (lifeline / senior citizen)");
  await result.locator("summary", { hasText: "Calculation assumptions" }).click();
  await expect(result).toContainText("not modeled");
});

test("consumption calendar shows recorded billing periods without inventing daily data", async ({ page }) => {
  await page.locator("#navigation [data-page=bills]").click();
  const bill = page.locator('[data-form="bill-save"]');
  for (const [start, end, kwh, amount] of [["2026-08-12", "2026-09-11", "186", "2,232.00"], ["2026-09-12", "2026-10-11", "200", "2,400.00"]]) {
    await bill.getByLabel("Period start").fill(start);
    await bill.getByLabel("Period end").fill(end);
    await bill.getByLabel("Billed kWh").fill(kwh);
    await bill.getByLabel("Total current charges (₱)").fill(amount);
    await bill.getByRole("button", { name: "Save bill" }).click();
    await expect(page.locator('[data-slot="bills"]')).toContainText(`₱${amount}`);
  }

  await page.locator("#navigation [data-page=calendar]").click();
  const calendar = page.locator('[data-slot="personal-calendar"]');
  const september = calendar.locator(".calendar-month", { hasText: "Sep 2026" });
  await expect(september.locator(".calendar-period")).toHaveCount(2);
  await expect(september).toContainText("11 day(s) in this month");
  await expect(september).toContainText("19 day(s) in this month");
  await expect(calendar.locator(".calendar-month", { hasText: "Dec 2026" })).toContainText("No record");
  // 186 kWh / 31 days → 200 kWh / 30 days = +11.11% per day; goal default 320 kWh scaled to 30 days.
  const latestRow = calendar.locator("tbody tr").first();
  await expect(latestRow).toContainText("2026-09-12 – 2026-10-11");
  await expect(latestRow).toContainText("+11.11%");
  await expect(latestRow).toContainText("315.4 kWh goal");
  await expect(calendar).toContainText("never split into invented daily");
});
