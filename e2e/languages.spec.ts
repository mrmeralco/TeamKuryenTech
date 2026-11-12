import { expect, test } from "@playwright/test";

// Local-dictionary languages: these must work without Google Cloud Translation.
const LANGUAGES = [
  { code: "hi", appliances: "मेरे उपकरण", centers: "मेराल्को बिज़नेस सेंटर", estimate: "अनुमान", chat: "SmartWatts सहायक" },
  { code: "vi", appliances: "Thiết bị của tôi", centers: "Trung tâm Giao dịch Meralco", estimate: "Ước tính", chat: "Trợ lý SmartWatts" },
  { code: "ko", appliances: "내 가전제품", centers: "메랄코 비즈니스 센터", estimate: "추정치", chat: "SmartWatts 도우미" },
  { code: "id", appliances: "Peralatan Saya", centers: "Pusat Layanan Meralco", estimate: "Perkiraan", chat: "Asisten SmartWatts" },
  { code: "ja", appliances: "マイ家電", centers: "メラルコ ビジネスセンター", estimate: "推定", chat: "SmartWatts アシスタント" },
  { code: "ms", appliances: "Peralatan Saya", centers: "Pusat Perniagaan Meralco", estimate: "Anggaran", chat: "Pembantu SmartWatts" },
  { code: "zh-CN", appliances: "我的电器", centers: "Meralco 营业厅", estimate: "估算", chat: "SmartWatts 助手" },
  { code: "tl-taglish", appliances: "Mga Appliance Ko", centers: "Meralco Business Centers", estimate: "Estimate lang", chat: "SmartWatts Assistant" },
];

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // Register one appliance in English so a numeric value can be checked in every language.
  await page.locator("#navigation [data-page=devices]").click();
  const form = page.locator('[data-form="appliance-save"]');
  await form.locator('input[name="name"]').fill("Aircon GR-B202");
  await form.locator('input[name="watts"]').fill("1000");
  await form.locator('input[name="hoursPerDay"]').fill("8");
  await form.getByRole("button", { name: "Save appliance" }).click();
  await expect(page.locator('[data-slot="appliances"]')).toContainText("243.5");
});

for (const language of LANGUAGES) {
  test(`${language.code}: navigation, labels, chat, and numbers work offline`, async ({ page }) => {
    await expect(page.locator(`#ui-language option[value="${language.code}"]`)).toHaveCount(1);
    await page.locator("#ui-language").selectOption(language.code);
    await expect(page.locator("#navigation [data-page=devices]")).toHaveText(language.appliances);
    await expect(page.locator("html")).toHaveAttribute("lang", language.code);
    // Numbers, units, and model-like names are preserved exactly.
    const list = page.locator('[data-slot="appliances"]');
    await expect(list).toContainText("243.5");
    await expect(list).toContainText("Aircon GR-B202");
    await expect(list).toContainText("1000 W");
    await expect(list.locator(".kind-estimate").first()).toHaveText(language.estimate);

    await page.locator('[data-page="support"]').first().click();
    await page.locator('[data-page="business-centers"]').click();
    await expect(page.locator("#navigation, #content").getByText(language.centers).first()).toBeVisible();
    await expect(page.locator(".center-item")).toHaveCount(52);

    await page.locator("#chat-root button[aria-expanded]").click();
    await expect(page.locator("#chat-root h2")).toHaveText(language.chat);
  });
}

test("switching language keeps unsaved form input", async ({ page }) => {
  const form = page.locator('[data-form="appliance-save"]');
  await form.locator('input[name="name"]').fill("Electric kettle");
  await form.locator('input[name="watts"]').fill("1850");
  await page.locator("#ui-language").selectOption("ja");
  await expect(page.locator("#navigation [data-page=devices]")).toHaveText("マイ家電");
  await expect(form.locator('input[name="name"]')).toHaveValue("Electric kettle");
  await expect(form.locator('input[name="watts"]')).toHaveValue("1850");
  await page.reload();
  await expect(page.locator("#ui-language")).toHaveValue("ja");
});
