import { describe, expect, it } from "vitest";
import { extractBillComponents, extractBillFields, redactBillText } from "../ocr";
import { compareScenario, deriveRateProfile, projectBill, reconcileBill } from "./meralco";

// Synthetic, Meralco-style bill text (not a real customer's bill).
const BILL = `MERALCO
Customer Name: JUAN DELA CRUZ
Service Address: 123 Mabini St, Brgy. 45, Quezon City
Customer Account No: 1234 5678 9012
Meter No: 98765432
Billing Period: 09/12/2026 to 10/11/2026
Previous Reading 12,045
Present Reading 12,245
Total Consumption 200 kWh
Generation Charge 1,402.50
Transmission Charge 172.30
System Loss Charge 120.10
Distribution Charge 260.00
Supply Charge 70.00
Metering Charge 10.00
Lifeline Discount (25.00)
Senior Citizen Subsidy 0.45
Universal Charges 32.40
FIT-All 16.82
Over/Under Recovery Adjustment -12.00
Value Added Tax 230.11
Local Franchise Tax 18.32
Total Current Charges 2,296.00
Previous Balance 0.00
Total Amount Due ₱ 2,296.00
Contact: 0917 123 4567 juan@example.com`;

describe("bill OCR extraction", () => {
  it("extracts period, readings, kWh, totals and every component exactly once", () => {
    const fields = extractBillFields(BILL);
    expect(fields).toMatchObject({
      kwh: 200, amountPesos: "2296.00", amountDuePesos: "2296.00",
      periodStart: "2026-09-12", periodEnd: "2026-10-11", previousReading: 12045, presentReading: 12245,
    });
    expect(fields.components).toEqual({
      generation: 140250, transmission: 17230, systemLoss: 12010, distribution: 26000, supply: 7000, metering: 1000,
      subsidies: -2455, universalCharges: 3240, fitAll: 1682, refundsAdjustments: -1200, taxes: 24843,
    });
    expect(reconcileBill(229600, fields.components)).toEqual({ componentsCentavos: 229600, totalCentavos: 229600, differenceCentavos: 0, balanced: true });
  });

  it("uses a printed tax subtotal instead of adding detail lines on top of it", () => {
    const text = "Government Taxes 248.43\nValue Added Tax 230.11\nLocal Franchise Tax 18.32";
    expect(extractBillComponents(text)).toEqual({ taxes: 24843 });
  });

  it("reads month-name billing periods", () => {
    expect(extractBillFields("Billing Period: Sep 12, 2026 - Oct 11, 2026").periodEnd).toBe("2026-10-11");
    expect(extractBillFields("Period 12 Sep 2026 to 11 Oct 2026").periodStart).toBe("2026-09-12");
  });

  it("redacts names, addresses, account/meter identifiers, phones and emails but keeps amounts", () => {
    const redacted = redactBillText(BILL);
    for (const secret of ["JUAN DELA CRUZ", "Mabini", "1234 5678 9012", "98765432", "0917 123 4567", "juan@example.com"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("Total Current Charges 2,296.00");
    expect(redacted).toContain("Present Reading 12,245");
  });
});

describe("deterministic billing engine", () => {
  const bill = {
    kwh: 200, amountCentavos: 229600, periodStart: "2026-09-12", periodEnd: "2026-10-11",
    components: extractBillFields(BILL).components,
  };

  it("projects each category from the person's own bill and sums rounded parts", () => {
    const profile = deriveRateProfile(bill);
    expect(profile.perKwh.generation).toBeCloseTo(701.25);
    const same = projectBill(200, profile);
    expect(same.totalCentavos).toBe(229600); // reproduces the source bill exactly
    const half = projectBill(100, profile);
    expect(half.byCategory.generation).toBe(70125);
    expect(half.totalCentavos).toBe(Object.values(half.byCategory).reduce((a, b) => a! + b!, 0));
  });

  it("compares scenarios with credits (subsidies, refunds) kept negative", () => {
    const result = compareScenario(200, 150, deriveRateProfile(bill));
    expect(result.savingsCentavos).toBe(result.current.totalCentavos - result.planned.totalCentavos);
    expect(result.savingsByCategory.subsidies).toBeGreaterThan(-700); // a credit shrinks with usage
    expect(result.savingsByCategory.subsidies).toBeLessThan(0);
    expect(result.assumptions.join(" ")).toMatch(/not modeled/);
  });

  it("falls back to one overall average when the bill has no itemized breakdown", () => {
    const profile = deriveRateProfile({ kwh: 200, amountCentavos: 245000 });
    expect(Object.keys(profile.perKwh)).toEqual(["average"]);
    expect(projectBill(26.1, profile).totalCentavos).toBe(31973); // 26.1 × ₱12.25 = ₱319.725 → ₱319.73
  });

  it("rejects invalid inputs instead of guessing", () => {
    expect(() => deriveRateProfile({ kwh: 0, amountCentavos: 1 })).toThrow(RangeError);
    expect(() => reconcileBill(100, { generation: 1.5 })).toThrow(RangeError);
    expect(() => reconcileBill(100, { madeUp: 1 } as never)).toThrow(RangeError);
    expect(reconcileBill(100, { generation: 90 })).toMatchObject({ balanced: false, differenceCentavos: 10 });
  });
});
