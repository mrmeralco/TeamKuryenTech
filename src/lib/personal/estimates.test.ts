import { describe, expect, it } from "vitest";
import { effectiveRateCentavosPerKwh, estimateMonthlyKwh, simulateSavings } from "./estimates";

describe("appliance estimates", () => {
  it("estimates average-month kWh from wattage and schedule", () => {
    // 1,000 W x 1 h x 7/7 days x 30.4375 days = 30.44 kWh
    expect(estimateMonthlyKwh({ watts: 1000, quantity: 1, hoursPerDay: 1, daysPerWeek: 7 })).toBe(30.44);
    expect(estimateMonthlyKwh({ watts: 10, quantity: 4, hoursPerDay: 5, daysPerWeek: 3.5 })).toBe(3.04);
    expect(estimateMonthlyKwh({ watts: 500, quantity: 1, hoursPerDay: 0, daysPerWeek: 7 })).toBe(0);
  });

  it("calculates monthly kWh from energy efficiency label ratings when watts are not present", () => {
    // Direct monthly kWh (e.g. Philippine DOE energy label 26.10 kWh/month)
    expect(estimateMonthlyKwh({ watts: 0, quantity: 1, hoursPerDay: 24, daysPerWeek: 7, testedKwhMonth: 26.1 })).toBe(26.1);
    expect(estimateMonthlyKwh({ watts: 0, quantity: 2, hoursPerDay: 24, daysPerWeek: 7, testedKwhMonth: 26.1 })).toBe(52.2);

    // From 24h consumption (e.g. 0.87 kWh/24h x 30.4375 days = 26.48 kWh)
    expect(estimateMonthlyKwh({ watts: 0, quantity: 1, hoursPerDay: 24, daysPerWeek: 7, testedKwh24h: 0.87 })).toBe(26.48);

    // From annual kWh (e.g. 313.2 kWh/year / 12 = 26.10 kWh)
    expect(estimateMonthlyKwh({ watts: 0, quantity: 1, hoursPerDay: 24, daysPerWeek: 7, testedKwhYear: 313.2 })).toBe(26.1);

    // Rated watts take precedence when positive
    expect(estimateMonthlyKwh({ watts: 100, quantity: 1, hoursPerDay: 10, daysPerWeek: 7, testedKwhMonth: 26.1 })).toBe(30.44);
  });

  it("rejects impossible schedules", () => {
    expect(() => estimateMonthlyKwh({ watts: 100, quantity: 1, hoursPerDay: 25, daysPerWeek: 7 })).toThrow(RangeError);
    expect(() => estimateMonthlyKwh({ watts: 0, quantity: 1, hoursPerDay: 1, daysPerWeek: 7 })).toThrow(RangeError);
    expect(() => estimateMonthlyKwh({ watts: 100, quantity: 1.5, hoursPerDay: 1, daysPerWeek: 7 })).toThrow(RangeError);
    expect(() => estimateMonthlyKwh({ watts: 100, quantity: 1, hoursPerDay: 1, daysPerWeek: 8 })).toThrow(RangeError);
  });

  it("derives the rate from the person's own bill instead of a universal price", () => {
    expect(effectiveRateCentavosPerKwh({ kwh: 200, amountCentavos: 245000 })).toBe(1225);
    expect(effectiveRateCentavosPerKwh({ kwh: 0, amountCentavos: 1 })).toBeNull();
    expect(effectiveRateCentavosPerKwh(null)).toBeNull();
  });
});

describe("savings simulator", () => {
  const appliances = [
    { id: "ac", watts: 1000, quantity: 1, hoursPerDay: 8, daysPerWeek: 7 },
    { id: "tv", watts: 100, quantity: 1, hoursPerDay: 4, daysPerWeek: 7 },
  ];

  it("compares current and planned schedules using the supplied rate", () => {
    const result = simulateSavings(appliances, [{ applianceId: "ac", hoursPerDay: 6 }], 1200);
    expect(result.currentKwh).toBe(255.68);
    expect(result.plannedKwh).toBe(194.81);
    expect(result.savedKwh).toBe(60.87);
    expect(result.savedCentavos).toBe(73044);
    expect(result.rows.find((row) => row.applianceId === "tv")?.savedKwh).toBe(0);
  });

  it("requires a rate", () => {
    expect(() => simulateSavings(appliances, [], 0)).toThrow(RangeError);
  });
});
