import { describe, expect, it } from "vitest";
import { escapeHtml, formatPeso, parsePesoToCentavos, whToKwh } from "./format";
import { extractBillFields, extractMeterReading } from "./ocr";

describe("format helpers", () => {
  it("escapes HTML from user-provided values", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe("&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;");
  });

  it("formats and parses peso amounts as integer centavos", () => {
    expect(formatPeso(29900)).toBe("₱299.00");
    expect(formatPeso(123456789)).toBe("₱1,234,567.89");
    expect(parsePesoToCentavos("₱1,234.5")).toBe(123450);
    expect(parsePesoToCentavos("0.07")).toBe(7);
    expect(parsePesoToCentavos("12.345")).toBeNull();
    expect(parsePesoToCentavos("-5")).toBeNull();
  });

  it("converts watt-hours to kWh text", () => {
    expect(whToKwh(150500)).toBe("150.5");
    expect(whToKwh(null)).toBe("—");
  });
});

describe("OCR parsers", () => {
  it("suggests kWh and amount due from bill text", () => {
    const text = "Billing Period Sep 1 - Sep 30\nTotal Consumption 1,210.5 kWh\nTotal Amount Due ₱ 14,321.75";
    expect(extractBillFields(text)).toMatchObject({ kwh: 1210.5, amountPesos: "14321.75" });
    expect(extractBillFields("nothing useful")).toMatchObject({ kwh: null, amountPesos: null, periodStart: null, components: {} });
  });

  it("suggests a meter register value from a photo", () => {
    expect(extractMeterReading("kWh 0 1 2 3 4\n 04521.3 \n 230V")).toBe(4521.3);
    expect(extractMeterReading("no digits")).toBeNull();
  });
});
