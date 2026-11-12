import { expect, test } from "@playwright/test";

test("Account Settings exposes one keyboard-accessible section and no sample customer values", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/dashboard");
  await page.locator("#navigation").getByRole("button", { name: "Account Settings", exact: true }).click();

  const tabs = page.getByRole("tab");
  const visiblePanels = page.locator("[data-account-panel]:visible");
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(visiblePanels).toHaveCount(1);

  await tabs.nth(0).press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(visiblePanels).toHaveCount(1);
  await tabs.nth(1).click();
  await tabs.nth(2).click();
  await expect(visiblePanels).toHaveCount(1);
  await tabs.nth(3).click();
  await expect(tabs.nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(visiblePanels).toHaveCount(1);

  const text = await page.locator("#content").innerText();
  for (const sample of ["Rean Justine", "Baulite", "rean.justine@example.com", "123 Main St.", "1234 5678 9012", "+63 9XX XXX XXXX"]) {
    expect(text).not.toContain(sample);
  }
  expect(pageErrors).toEqual([]);
});
