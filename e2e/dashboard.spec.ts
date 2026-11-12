import { expect, test } from "@playwright/test";

test("dashboard loads and chat supports Tagalog selection", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/dashboard");
  await page.evaluate(() => {
    localStorage.removeItem("smartwatts-game");
    localStorage.removeItem("smartwatts-monthly-target");
    localStorage.removeItem("smartwatts-language");
    localStorage.removeItem("smartwatts-theme");
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Good morning, Rean Justine!" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Complete quest/ })).toBeVisible();
  await page.getByRole("button", { name: /Complete quest/ }).click();
  await expect(page.locator(".game-stats")).toContainText("140");
  await page.reload();
  await expect(page.locator(".game-stats")).toContainText("140");
  await page.getByRole("button", { name: "Energy Goals" }).click();
  await expect(page.getByLabel("Monthly target (kWh)")).toHaveValue("320");
  await page.getByLabel("Monthly target (kWh)").fill("300");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.locator(".goal-copy")).toContainText("42.18 kWh over your monthly target");
  await page.reload();
  await page.getByRole("button", { name: "Energy Goals" }).click();
  await expect(page.getByLabel("Monthly target (kWh)")).toHaveValue("300");
  await page.getByRole("button", { name: /Claim/ }).first().click();
  await expect(page.locator(".stats")).toContainText("170");
  await page.getByRole("button", { name: "Rewards & Badges" }).click();
  await expect(page.locator(".panel").filter({ hasText: "First Step" })).toContainText("✓ Unlocked");
  const coolOperatorBadge = page.locator(".panel").filter({ hasText: "Cool Operator" });
  await expect(coolOperatorBadge).toContainText("✓ Unlocked");
  await expect(coolOperatorBadge).toContainText("2/8 earned");
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
  await expect(page.getByRole("heading", { name: "Magandang umaga, Rean Justine!" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mga Layunin sa Enerhiya" })).toBeVisible();
  await expect(page.locator(".game-card")).toHaveAttribute("aria-label", "Progreso sa pagtitipid ng enerhiya");
  await expect(page.locator(".week .day small")).toHaveText(["L", "M", "M", "H", "B", "S", "L"]);
  const rangeOptions = await page.locator('[data-chart-range="dashboard"] option').allTextContents();
  expect(rangeOptions).toContain("Kada Tatlong Buwan");
  expect(rangeOptions).toContain("Taunan");

  await page.getByRole("button", { name: "Mga Gantimpala at Badge" }).click();
  await expect(page.getByRole("heading", { name: "Koleksiyon ng mga Badge" })).toBeVisible();
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
