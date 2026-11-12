import { expect, test } from "@playwright/test";

test("chat launcher and panel stay within the viewport across SmartWatts screens", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === new URL(page.url() || "http://127.0.0.1:5176").origin) failures.push(`${request.method()} ${new URL(request.url()).pathname} failed`);
  });

  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 740 : 900 });
    await page.goto("/dashboard");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      const baselinePageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const launcher = page.getByRole("button", { name: "Chat with us" });
      await expect(launcher).toBeVisible();
      await launcher.click();
      const panel = page.getByRole("region", { name: "SmartWatts Assistant" });
      await expect(panel).toBeVisible();
      const geometry = await page.evaluate(() => {
        const widget = document.querySelector<HTMLElement>("#chat-root .smartwatts-chat-widget")!;
        const panel = document.querySelector<HTMLElement>("#chat-root .smartwatts-chat-panel")!;
        const log = document.querySelector<HTMLElement>("#chat-root [role=log]")!;
        const box = (element: HTMLElement) => element.getBoundingClientRect().toJSON();
        return { width: innerWidth, height: innerHeight, widget: box(widget), panel: box(panel), logOverflow: getComputedStyle(log).overflowY, pageWidth: document.documentElement.scrollWidth };
      });
      expect(geometry.widget.left).toBeGreaterThanOrEqual(0);
      expect(geometry.widget.right).toBeLessThanOrEqual(width);
      expect(geometry.panel.left).toBeGreaterThanOrEqual(0);
      expect(geometry.panel.right).toBeLessThanOrEqual(width);
      expect(geometry.panel.top).toBeGreaterThanOrEqual(0);
      expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.widget.bottom);
      expect(geometry.logOverflow).toBe("auto");
      expect(geometry.pageWidth).toBeLessThanOrEqual(baselinePageWidth);
      await page.getByRole("button", { name: "Close chat" }).click();
    }
  }
  expect(failures).toEqual([]);
});

test("chat remains available while navigating between dashboard sections", async ({ page }) => {
  await page.goto("/dashboard");
  for (const section of ["Savings Simulator", "Watts Coins", "SmartWatts Rentals", "Account Settings"]) {
    const nav = page.getByRole("button", { name: section, exact: true }).first();
    if (await nav.count()) await nav.click();
    else await page.locator(`[data-page="${section === "Savings Simulator" ? "simulator" : section === "Watts Coins" ? "rewards" : section === "SmartWatts Rentals" ? "rentals-start" : "account"}"]`).first().click();
    const launcher = page.getByRole("button", { name: "Chat with us" });
    await expect(launcher).toBeVisible();
    await launcher.click();
    await expect(page.getByRole("region", { name: "SmartWatts Assistant" })).toBeVisible();
    await page.getByRole("button", { name: "Close chat" }).click();
  }
});
