import { describe, expect, it } from "vitest";
import { calculateEnergySummary, calculatePercentChange } from "./calculations";

describe("calculateEnergySummary", () => {
  it("sums usage and rounds the estimate to cents", () => {
    expect(calculateEnergySummary([{ kwh: 10.1 }, { kwh: 5.25 }], 3.67, 3)).toEqual({
      totalKwh: 15.35,
      estimatedCost: 56.33,
      averageDailyKwh: 15.35 / 3,
    });
  });

  it("rejects negative readings and invalid periods", () => {
    expect(() => calculateEnergySummary([{ kwh: -1 }], 3.67, 30)).toThrow(RangeError);
    expect(() => calculateEnergySummary([], 3.67, 0)).toThrow(RangeError);
  });
});

describe("calculatePercentChange", () => {
  it("handles positive baselines and zero-baseline edge cases", () => {
    expect(calculatePercentChange(12, 10)).toBe(20);
    expect(calculatePercentChange(0, 0)).toBe(0);
    expect(calculatePercentChange(1, 0)).toBeNull();
  });
});
