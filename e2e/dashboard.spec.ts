import { expect, test } from "@playwright/test";

test("notification bell opens, toggles closed, and closes on outside click", async ({ page }) => {
  await page.goto("/dashboard");
  const bell = page.locator("#notificationsBtn");
  const popover = page.locator("#notificationPopover");
  await bell.click();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Sample Usage Alert");
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  await bell.click();
  await expect(popover).toBeHidden();
  await bell.click();
  await page.locator("#pageTitle").click();
  await expect(popover).toBeHidden();
  await expect(bell).toHaveAttribute("aria-expanded", "false");
});

test("usage and analytics exports download CSV files and report a clear result", async ({ page }) => {
  await page.goto("/dashboard");
  await page.locator('#navigation [data-page="history"]').click();
  const [usageDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('#content [data-action="download"]').first().click(),
  ]);
  expect(usageDownload.suggestedFilename()).toMatch(/^smartwatts-usage-record-\d+\.csv$/);
  await expect(page.locator("#toast")).toContainText("Usage history downloaded successfully.");

  await page.locator('#navigation [data-page="breakdown"]').click();
  const [reportDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('#content [data-action="export"]').click(),
  ]);
  expect(reportDownload.suggestedFilename()).toMatch(/^smartwatts-analytics-report-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(page.locator("#exportNotice")).toContainText("Analytics report generated and downloaded.");
});

test("dashboard loads and chat supports Tagalog selection", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/dashboard");
  await page.evaluate(() => {
    localStorage.removeItem("smartwatts-game");
    localStorage.removeItem("smartwatts-coins-guest");
    localStorage.removeItem("smartwatts-monthly-target");
    localStorage.removeItem("smartwatts-language");
    localStorage.removeItem("smartwatts-theme");
  });
  await page.reload();
  await expect(page.locator("#pageTitle")).toContainText(/^Good (morning|noon|afternoon|evening)(, .+)?!$/);
  await expect(page.getByRole("button", { name: "Check in to get coins" })).toBeDisabled();
  await page.getByLabel("Wattage (W)").fill("1000");
  await page.getByLabel("Hours today").fill("8");
  await page.getByLabel("Rate (₱/kWh)").fill("12.25");
  await page.getByRole("button", { name: "Forecast cost" }).click();
  await expect(page.locator(".quest-forecast")).toContainText("✓ Done");
  await page.getByRole("button", { name: "Check in to get coins" }).click();
  await expect(page.locator(".coin-checkin-card")).toContainText("Checked in today");
  await page.reload();
  await expect(page.locator(".coin-checkin-card")).toContainText("Checked in today");
  await page.getByRole("button", { name: "Energy Goals" }).click();
  await expect(page.getByLabel("Monthly target (kWh)")).toHaveValue("320");
  await page.getByLabel("Monthly target (kWh)").fill("300");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.locator(".goal-copy")).toContainText("42.18 kWh over your monthly target");
  await page.reload();
  await page.getByRole("button", { name: "Energy Goals" }).click();
  await expect(page.getByLabel("Monthly target (kWh)")).toHaveValue("300");
  await page.getByRole("button", { name: "Watts Coins", exact: true }).click();
  await expect(page.locator("#pageTitle")).toHaveText("Watts Coins");
  await expect(page.locator(".coin-balance-card")).toContainText("0.55 Watts Coins (₱0.55)");
  await expect(page.locator(".coin-lock")).toContainText("Locked · Pending for Next Bill");
  await page.getByRole("button", { name: "SPENDING" }).click();
  await expect(page.locator(".coin-ledger")).toContainText("No coin transactions yet");
  await expect(page.getByRole("heading", { name: "Neighborhood leaderboard" })).toHaveCount(0);
  await page.getByRole("button", { name: "Chat with us" }).click();
  await page.getByLabel("Language", { exact: true }).selectOption("tl");
  await expect(page.getByRole("heading", { name: "Katulong ng SmartWatts" })).toBeVisible();
  await expect(page.getByText("Magtanong tungkol sa pagtitipid ng enerhiya")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("system language, usage ranges, and theme preferences work across pages", async ({ page }) => {
  await page.goto("/dashboard");
  await page.locator("#ui-language").selectOption("tl");
  await expect(page.locator("#pageTitle")).toContainText(/^Magandang (umaga|tanghali|hapon|gabi)(, .+)?!$/);
  await expect(page.getByRole("button", { name: "Mga Layunin sa Enerhiya" })).toBeVisible();
  await expect(page.locator(".game-card")).toHaveAttribute("aria-label", "Daily Watts Coins check-in");
  await expect(page.locator(".coin-day small").first()).toHaveText("Ngayong Araw");
  const rangeOptions = await page.locator('[data-chart-range="dashboard"] option').allTextContents();
  expect(rangeOptions).toContain("Kada Tatlong Buwan");
  expect(rangeOptions).toContain("Taunan");

  await page.getByRole("button", { name: "Watts Coins", exact: true }).click();
  await expect(page.locator("#pageTitle")).toHaveText("Watts Coins");
  await expect(page.getByRole("heading", { name: /Neighborhood leaderboard/ })).toHaveCount(0);

  await page.locator('[data-page="history"]').click();
  await expect(page.getByText("Marso 1 – Marso 31, 2026")).toBeVisible();
  await page.locator('[data-page="devices"]').click();
  await expect(page.getByText("Telebisyon")).toBeVisible();

  await page.locator("#themeToggle").click();
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect.poll(() => page.locator(".panel").first().evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe("rgb(36, 33, 28)");
  await expect(page.locator("#themeToggle")).toHaveAttribute("aria-label", "Lumipat sa light mode");
  await page.getByRole("button", { name: "Makipag-chat" }).click();
  await expect.poll(() => page.locator("#chat-root section").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe("rgb(36, 33, 28)");
  await expect.poll(() => page.locator("#chat-root [role='log']").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe("rgb(29, 27, 24)");
  await page.locator("#ui-language").selectOption("en");
  await expect(page.locator("#themeToggle")).toHaveAttribute("aria-label", "Switch to light mode");
  await page.locator("#ui-language").selectOption("tl");
  await expect(page.locator("#themeToggle")).toHaveAttribute("aria-label", "Lumipat sa light mode");
  await page.reload();
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect(page.locator("#ui-language")).toHaveValue("tl");
});

test("mobile top bar stays compact and dark surfaces remain dark", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");

  await expect(page.locator(".topbar")).toBeVisible();
  await expect.poll(() => page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(210);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.locator("#themeToggle").click();
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect.poll(() => page.locator(".topbar").evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgba(36, 33, 28, 0.94)");
  await expect.poll(() => page.locator(".stat-card").first().evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  )).toContain("rgb(36, 33, 28)");
});

test("support page provides MERALCO contact links", async ({ page }) => {
  await page.goto("/dashboard");
  await page.locator('[data-page="support"]').first().click();

  await expect(page.getByText("General Contact Information")).toBeVisible();
  await expect(page.getByText("Your feedback means a lot to us")).toBeVisible();
  const contacts = await page.locator(".contact-option").evaluateAll((links) => links.map((link) => [
    link.innerText.replace(/\s+/g, " ").trim(),
    link.getAttribute("href"),
    link.getAttribute("target"),
    link.getAttribute("rel"),
  ]));
  expect(contacts).toEqual([
    ["Hotline Dial (02) 16211", "tel:+63216211", null, null],
    ["Email customercare@meralco.com.ph", "mailto:customercare@meralco.com.ph", null, null],
    ["Mobile Dial (02) 16211 on Mobile", "tel:+63216211", null, null],
    ["Facebook @meralco", "https://www.facebook.com/meralco/", "_blank", "noopener noreferrer"],
    ["Twitter Meralco", "https://twitter.com/meralco", "_blank", "noopener noreferrer"],
    ["YouTube Meralco YouTube", "https://www.youtube.com/user/meralcoph", "_blank", "noopener noreferrer"],
    ["Instagram @meralco", "https://www.instagram.com/meralcoph/?hl=en", "_blank", "noopener noreferrer"],
    ["Meralco Messenger Message us", "https://m.me/147245968622316", "_blank", "noopener noreferrer"],
  ]);
});

test("energy tip quest needs a 15-second read and unlocks check-in", async ({ page }) => {
  await page.clock.install();
  await page.goto("/dashboard");
  await page.evaluate(() => localStorage.removeItem("smartwatts-coins-guest"));
  await page.reload();
  const checkIn = page.getByRole("button", { name: "Check in to get coins" });
  await expect(checkIn).toBeDisabled();
  await page.getByRole("button", { name: "Read today's tip" }).click();
  await expect(page.locator(".quest-tip-text")).toBeVisible();
  const claim = page.locator('[data-action="quest-tip-claim"]');
  await expect(claim).toBeDisabled();
  await page.clock.runFor(15_500);
  await expect(claim).toBeEnabled();
  await claim.click();
  await expect(page.locator(".quest-tip")).toContainText("✓ Done");
  await expect(checkIn).toBeEnabled();
  await page.screenshot({ path: "test-results/daily-quests.png", fullPage: false });
});

test("support FAQ groups questions into five expandable categories", async ({ page }) => {
  await page.goto("/dashboard");
  await page.locator('[data-page="support"]').first().click();
  await expect(page.locator(".faq-category > summary")).toHaveCount(5);
  await expect(page.locator(".faq-item")).toHaveCount(26);
  await page.locator(".faq-category > summary", { hasText: "Electricity Consumption" }).click();
  await page.getByText("How can I calculate my electricity consumption?").click();
  await expect(page.getByText("kWh = (Watts × Hours Used) ÷ 1,000")).toBeVisible();
  await expect(page.locator(".faq-refs a")).toHaveCount(4);
});
