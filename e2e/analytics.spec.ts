import { expect, test } from "@playwright/test";

test.describe("Personal Energy Analytics Month Filter & Data Accuracy", () => {
  test("analytics page initializes with verified records and switches data accurately across months", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    // Seed mock personal data into localStorage
    await page.evaluate(() => {
      const data = {
        bills: [
          {
            id: "bill-may-2026",
            periodStart: "2026-04-15",
            periodEnd: "2026-05-14",
            kwh: 342.18,
            amountCentavos: 410616,
            source: "ocr",
          },
          {
            id: "bill-apr-2026",
            periodStart: "2026-03-15",
            periodEnd: "2026-04-14",
            kwh: 285.5,
            amountCentavos: 342600,
            source: "manual",
          },
        ],
        appliances: [
          {
            id: "app-ac",
            name: "Living Room Aircon",
            category: "cooling",
            watts: 900,
            quantity: 1,
            hoursPerDay: 8,
            daysPerWeek: 7,
            scheduleNote: null,
          },
          {
            id: "app-fridge",
            name: "Kitchen Refrigerator",
            category: "refrigeration",
            watts: 150,
            quantity: 1,
            hoursPerDay: 24,
            daysPerWeek: 7,
            scheduleNote: null,
          },
        ],
      };
      localStorage.setItem("smartwatts-personal-v1", JSON.stringify(data));
    });

    await page.reload();
    await page.locator('#navigation [data-page="breakdown"]').click();

    // Verify month select is present with May 2026 and April 2026
    const select = page.locator("#analyticsMonthSelect");
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("2026-05");

    // Verify May 2026 Stat Cards
    const stats = page.locator("#analyticsStats");
    await expect(stats).toContainText("342.18");
    await expect(stats).toContainText("₱4,106.16");
    await expect(stats).toContainText("Living Room Aircon");
    await expect(stats).toContainText("+19.9%");
    await expect(stats).toContainText("vs April 2026 (285.50 kWh)");

    // Verify Canvases
    await expect(page.locator("#breakDonut")).toBeVisible();
    await expect(page.locator("#breakLine")).toBeVisible();

    // Verify Appliance Table for May
    const tableWrap = page.locator("#analyticsTableWrap");
    await expect(tableWrap).toContainText("Living Room Aircon");
    await expect(tableWrap).toContainText("Kitchen Refrigerator");
    await expect(tableWrap).toContainText("Other Household Usage");

    // Capture visual snapshot with populated data
    await page.screenshot({ path: "test-results/analytics-may2026-full.png", fullPage: true });

    // Switch Month to April 2026 (2026-04)
    await select.selectOption("2026-04");

    // Verify Stat Cards updated to April 2026 figures
    await expect(stats).toContainText("285.50");
    await expect(stats).toContainText("₱3,426.00");
    await expect(stats).toContainText("Not available"); // prior month (March) has no bill record
    await expect(stats).toContainText("Insufficient prior data");

    // Switch Month to a month with no bill (e.g. 2026-02)
    await select.selectOption("2026-02");
    await expect(stats).toContainText("Estimated appliance schedule");
    await expect(stats).not.toContainText("342.18");
    await expect(stats).not.toContainText("285.50");

    // Rapid switching test: switch quickly back and forth
    await select.selectOption("2026-05");
    await select.selectOption("2026-04");
    await select.selectOption("2026-05");

    // Final state must strictly reflect May 2026
    await expect(stats).toContainText("342.18");
    await expect(stats).toContainText("₱4,106.16");
    await expect(tableWrap).toContainText("Other Household Usage");
  });

  test("exported CSV report matches the currently selected month", async ({ page }) => {
    await page.goto("/dashboard");

    await page.evaluate(() => {
      const data = {
        bills: [
          {
            id: "bill-apr-2026",
            periodStart: "2026-03-15",
            periodEnd: "2026-04-14",
            kwh: 285.5,
            amountCentavos: 342600,
            source: "manual",
          },
          {
            id: "bill-may-2026",
            periodStart: "2026-04-15",
            periodEnd: "2026-05-14",
            kwh: 342.18,
            amountCentavos: 410616,
            source: "ocr",
          },
        ],
        appliances: [
          {
            id: "app-ac",
            name: "Aircon",
            category: "cooling",
            watts: 900,
            quantity: 1,
            hoursPerDay: 8,
            daysPerWeek: 7,
            scheduleNote: null,
          },
        ],
      };
      localStorage.setItem("smartwatts-personal-v1", JSON.stringify(data));
    });

    await page.reload();
    await page.locator('#navigation [data-page="breakdown"]').click();

    // Select April 2026
    const select = page.locator("#analyticsMonthSelect");
    await select.selectOption("2026-04");

    // Export report for April 2026
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator('#content [data-action="export"]').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^smartwatts-analytics-report-\d{4}-\d{2}-\d{2}\.csv$/);

    // Read the downloaded CSV content
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const csvContent = Buffer.concat(chunks).toString("utf-8");

    // Verify CSV matches April 2026
    expect(csvContent).toContain("Reporting Month,April 2026");
    expect(csvContent).toContain("Period Key,2026-04");
    expect(csvContent).toContain("Total Usage,285.50,kWh");
    expect(csvContent).toContain("285.50");
    expect(csvContent).toContain("3426.00");
    expect(csvContent).toContain("Aircon");
  });

  test("empty state renders cleanly when no records exist", async ({ page }) => {
    await page.goto("/dashboard");

    await page.evaluate(() => {
      localStorage.removeItem("smartwatts-personal-v1");
    });

    await page.reload();
    await page.locator('#navigation [data-page="breakdown"]').click();

    const stats = page.locator("#analyticsStats");
    await expect(stats).toContainText("—");
    await expect(stats).toContainText("No usage records for this month");
    await expect(stats).toContainText("No billing data");
    await expect(stats).toContainText("Not available");

    const tableWrap = page.locator("#analyticsTableWrap");
    await expect(tableWrap).toContainText("No appliance data for this month");
  });

  test("analytics toolbar and layout are responsive across viewports", async ({ page }) => {
    await page.goto("/dashboard");
    await page.locator('#navigation [data-page="breakdown"]').click();

    // 1. Desktop viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    const select = page.locator("#analyticsMonthSelect");
    const exportBtn = page.locator('#content [data-action="export"]');
    await expect(select).toBeVisible();
    await expect(exportBtn).toBeVisible();
    await page.screenshot({ path: "test-results/analytics-desktop.png", fullPage: false });

    // 2. Tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(select).toBeVisible();
    await expect(exportBtn).toBeVisible();
    await page.screenshot({ path: "test-results/analytics-tablet.png", fullPage: false });

    // 3. Mobile viewport
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(select).toBeVisible();
    await expect(exportBtn).toBeVisible();

    // Verify no horizontal overflow on mobile
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
    await page.screenshot({ path: "test-results/analytics-mobile.png", fullPage: false });
  });
});
