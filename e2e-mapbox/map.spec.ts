import { expect, test } from "@playwright/test";

test("Mapbox map renders markers and syncs list and marker selection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dashboard");
  await page.locator('[data-page="support"]').first().click();
  await page.getByRole("button", { name: "Find a Business Center" }).click();

  const map = page.getByRole("region", { name: "Map of Meralco Business Centers" });
  await expect(map.locator("canvas.mapboxgl-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The interactive map is not configured")).toHaveCount(0);

  // Published coordinates (San Miguel) render immediately; others appear as they are geocoded.
  await expect(map.locator(".center-marker").first()).toBeVisible();
  await expect.poll(() => map.locator(".center-marker").count(), { timeout: 60_000 }).toBeGreaterThan(40);

  // List → map: selecting a branch focuses its marker and shows details.
  await page.getByLabel("Branch, city, or province").fill("San Miguel");
  await page.locator(".center-item").click();
  await expect(map.locator(".center-marker.active")).toHaveCount(1);
  await expect(page.locator('[data-slot="center-detail"]')).toContainText("Published by Meralco (approximate)");

  // Map → list: clicking a marker selects that branch.
  await page.getByLabel("Branch, city, or province").fill("");
  // The map is zoomed in on San Miguel, so the Makati marker is outside the visible area;
  // dispatch the click on the marker element itself (same handler as a real click).
  const makati = map.locator('.center-marker[aria-label="Meralco Business Center - Makati Branch"]');
  await expect(makati).toHaveCount(1, { timeout: 60_000 });
  await makati.dispatchEvent("click");
  await expect(page.locator('[data-slot="center-detail"]')).toContainText("9851 Kamagong St");
  await expect(page.locator('[data-slot="center-detail"]')).toContainText("Approximate — geocoded from the published address");
  expect(errors).toEqual([]);
});
