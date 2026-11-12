import { describe, expect, it } from "vitest";
import { STATIC_LANGUAGES, STATIC_DICTIONARIES, STATIC_KEYS } from "./i18n/dictionaries";

describe("audit verification: i18n traditional chinese dictionary", () => {
  it("includes zh-TW in STATIC_LANGUAGES", () => {
    const zhTW = STATIC_LANGUAGES.find((lang) => lang.code === "zh-TW");
    expect(zhTW).toBeDefined();
    expect(zhTW?.name).toContain("Traditional Chinese");
  });

  it("provides zh-TW translations for all static keys", () => {
    const dict = STATIC_DICTIONARIES["zh-TW"];
    expect(dict).toBeDefined();
    for (const key of STATIC_KEYS) {
      expect(dict[key], `Missing zh-TW translation for key: "${key}"`).toBeDefined();
      expect(dict[key].trim().length).toBeGreaterThan(0);
    }
  });

  it("translates key core concepts correctly in zh-TW", () => {
    const dict = STATIC_DICTIONARIES["zh-TW"];
    expect(dict["Dashboard"]).toBe("儀表板");
    expect(dict["Consumption Calendar"]).toBe("用電日曆");
    expect(dict["Analytics"]).toBe("用電分析");
    expect(dict["My Appliances"]).toBe("我的電器");
    expect(dict["Notifications"]).toBe("通知");
  });
});
