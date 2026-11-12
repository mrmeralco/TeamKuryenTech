import { describe, expect, it } from "vitest";
import { buildTimeline, monthGrid, periodDays, seasonalAverages, yearsCovered, type PeriodRecord } from "./calendar";

const bills: PeriodRecord[] = [
  { periodStart: "2026-08-12", periodEnd: "2026-09-11", kwh: 186, amountCentavos: 223200, kind: "recorded" },
  { periodStart: "2026-09-12", periodEnd: "2026-10-11", kwh: 200, amountCentavos: 240000, kind: "recorded" },
  { periodStart: "2025-12-12", periodEnd: "2026-01-11", kwh: 155, amountCentavos: 186000, kind: "recorded" },
];

describe("consumption calendar", () => {
  it("counts inclusive billing-period days and rejects inverted periods", () => {
    expect(periodDays("2026-09-12", "2026-10-11")).toBe(30);
    expect(periodDays("2026-08-12", "2026-09-11")).toBe(31);
    expect(() => periodDays("2026-10-11", "2026-09-12")).toThrow(RangeError);
  });

  it("compares periods per day, scales goals/estimates to period length, and labels nothing as daily data", () => {
    const timeline = buildTimeline(bills, { monthlyGoalKwh: 180, estimatedMonthlyKwh: 150 });
    expect(timeline.map((t) => t.periodEnd)).toEqual(["2026-01-11", "2026-09-11", "2026-10-11"]);
    const latest = timeline[2];
    expect(latest.averageKwhPerDay).toBe(6.67);
    // 186 kWh / 31 days = 6.0/day → 200 / 30 = 6.667/day: +11.11%
    expect(latest.changeVsPreviousPercent).toBe(11.11);
    expect(latest.goalForPeriodKwh).toBe(177.41); // 180 × 30 / 30.4375
    expect(latest.goalDifferenceKwh).toBe(22.59);
    expect(latest.estimatedForPeriodKwh).toBe(147.84);
    expect(timeline[0].changeVsPreviousPercent).toBeNull();
  });

  it("shows overlapping periods per month without splitting kWh", () => {
    const grid = monthGrid(bills, 2026);
    expect(grid).toHaveLength(12);
    const september = grid[8];
    expect(september.periods.map((p) => [p.periodStart, p.overlapDays, p.kwh])).toEqual([
      ["2026-08-12", 11, 186],
      ["2026-09-12", 19, 200],
    ]);
    expect(grid[0].periods.map((p) => p.overlapDays)).toEqual([11]); // Dec 12 – Jan 11 overlaps Jan 1–11
    expect(grid[11].periods).toEqual([]);
    expect(yearsCovered(bills)).toEqual([2026, 2025]);
  });

  it("computes seasonal averages by period-end month", () => {
    expect(seasonalAverages(bills)).toEqual([
      { month: 1, averageKwhPerDay: 5, periods: 1 },
      { month: 9, averageKwhPerDay: 6, periods: 1 },
      { month: 10, averageKwhPerDay: 6.67, periods: 1 },
    ]);
  });
});
