import { expect, test } from "@playwright/test";

// Runs WITHOUT VITE_MAPBOX_ACCESS_TOKEN: the directory must stay fully usable.
test("Business Center locator works without a Mapbox token", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator('[data-page="support"]').first().click();
  await page.getByRole("button", { name: "Find a Business Center" }).click();

  await expect(page.getByText("The interactive map is not configured")).toBeVisible();
  await expect(page.locator('[data-slot="center-count"]')).toHaveText("52 of 52 centers");

  await page.getByLabel("Branch, city, or province").fill("Makati");
  await expect(page.locator(".center-item")).toHaveCount(1);
  await page.locator(".center-item").click();
  const detail = page.locator('[data-slot="center-detail"]');
  await expect(detail).toContainText("Meralco Business Center - Makati Branch");
  await expect(detail).toContainText("9851 Kamagong St");
  await expect(detail.getByRole("link", { name: "1622 6584" })).toHaveAttribute("href", "tel:16226584");
  await expect(detail.locator(".detail-row", { hasText: "Operating hours" })).toContainText("Not published");
  const directions = detail.getByRole("link", { name: "Get directions" });
  await expect(directions).toHaveAttribute("href", /destination_place_id=ChIJYZdBqKDJlzMRG1CYNjrN-rQ/);
  await expect(directions).toHaveAttribute("rel", "noopener noreferrer");

  // Province filter and a branch whose number is not published.
  await page.getByLabel("Branch, city, or province").fill("");
  await page.getByLabel("Province / area").selectOption("Rizal");
  await expect(page.locator(".center-item")).toHaveCount(5);
  await page.getByLabel("Province / area").selectOption("");
  await page.getByLabel("Branch, city, or province").fill("karuhatan");
  await page.locator(".center-item").click();
  await expect(detail.locator(".detail-row", { hasText: "Branch contact" })).toContainText("Not published");

  // The general hotline is never presented as a branch line.
  await expect(page.getByText("This is a general line, not a direct branch number.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("locator is usable at phone width without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // The sidebar is collapsed at phone width; open it and choose Help & Support.
  await page.locator("#mobileMore").click();
  await page.locator('#navigation [data-page="support"]').click();
  await page.getByRole("button", { name: "Find a Business Center" }).click();
  await page.getByLabel("Branch, city, or province").fill("pasig");
  await expect(page.locator(".center-item")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
