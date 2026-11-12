import { expect, test } from "@playwright/test";

test.describe("SmartWatts Official SVG Branding", () => {
  test("brand logo loads official SVGs in light and dark mode", async ({ page }) => {
    // 1. Light Mode Verification
    await page.goto("/dashboard");
    await expect(page.locator("#pageTitle")).toBeVisible();

    const brand = page.locator(".brand");
    await expect(brand).toBeVisible();

    const lightLogo = page.locator(".brand-logo-light");
    const darkLogo = page.locator(".brand-logo-dark");
    const tagline = page.locator(".brand-tagline");

    await expect(lightLogo).toBeVisible();
    await expect(darkLogo).toBeHidden();
    await expect(tagline).toHaveText("Monitor. Save. Smarter.");

    // Verify image source and natural size (ensures valid SVG decode)
    const lightSrc = await lightLogo.getAttribute("src");
    expect(lightSrc).toBe("/branding/smartwatts-logo-light.svg");

    const lightLoaded = await lightLogo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
    expect(lightLoaded).toBe(true);

    // Capture light mode screenshot
    await page.screenshot({ path: "/Users/Macbook/.gemini/antigravity-cli/brain/0004e8fc-64aa-404d-b2dd-b0a6e9fb308b/scratch/brand-light.png" });

    // 2. Dark Mode Verification
    const themeBtn = page.locator("#themeToggle");
    await themeBtn.click();
    await expect(page.locator("body")).toHaveClass(/theme-dark/);

    await expect(lightLogo).toBeHidden();
    await expect(darkLogo).toBeVisible();

    const darkSrc = await darkLogo.getAttribute("src");
    expect(darkSrc).toBe("/branding/smartwatts-logo-dark.svg");

    const darkLoaded = await darkLogo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
    expect(darkLoaded).toBe(true);

    // Capture dark mode screenshot
    await page.screenshot({ path: "/Users/Macbook/.gemini/antigravity-cli/brain/0004e8fc-64aa-404d-b2dd-b0a6e9fb308b/scratch/brand-dark.png" });
  });

  test("brand logo is displayed consistently in Rentals workspace", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("#pageTitle")).toBeVisible();

    // Navigate to rental workspace / overview
    await page.evaluate(() => {
      window.location.hash = "#rental-overview";
    });
    await page.waitForTimeout(300);

    const brand = page.locator(".brand");
    await expect(brand).toBeVisible();

    const lightLogo = page.locator(".brand-logo-light");
    await expect(lightLogo).toBeVisible();

    // Verify brand link navigation
    const brandLink = page.locator(".brand-link");
    await expect(brandLink).toHaveAttribute("data-page", "dashboard");

    // Capture rentals workspace screenshot
    await page.screenshot({ path: "/Users/Macbook/.gemini/antigravity-cli/brain/0004e8fc-64aa-404d-b2dd-b0a6e9fb308b/scratch/brand-rentals.png" });
  });

  test("brand logo renders cleanly on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/dashboard");

    const menuToggle = page.locator("#menuToggle");
    await expect(menuToggle).toBeVisible();
    await menuToggle.click();

    const sidebar = page.locator("#sidebar");
    await expect(sidebar).toHaveClass(/open/);
    await page.waitForTimeout(350);

    const logo = page.locator(".brand-logo-light");
    await expect(logo).toBeVisible();

    const box = await logo.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(40);
    expect(box!.height).toBeGreaterThan(40);

    await page.screenshot({ path: "/Users/Macbook/.gemini/antigravity-cli/brain/0004e8fc-64aa-404d-b2dd-b0a6e9fb308b/scratch/brand-mobile.png" });
  });
});
