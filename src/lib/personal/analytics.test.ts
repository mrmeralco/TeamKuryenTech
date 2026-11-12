import { describe, expect, it } from "vitest";
import {
  categoryToIcon,
  categoryToLabel,
  computePersonalAnalytics,
  formatMonthLabel,
  generateAnalyticsCsv,
  getAvailableMonths,
  getRollingMonthKeys,
  parseMonthKey,
  previousMonthKey,
} from "./analytics";
import type { Appliance, PersonalBill } from "./store";

describe("Personal Analytics Date Helpers", () => {
  it("parses valid month keys and rejects invalid ones", () => {
    expect(parseMonthKey("2026-05")).toEqual({ year: 2026, month: 5 });
    expect(parseMonthKey("2025-12")).toEqual({ year: 2025, month: 12 });
    expect(parseMonthKey("invalid")).toBeNull();
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(parseMonthKey("2026-00")).toBeNull();
  });

  it("formats user-facing month labels in Asia/Manila", () => {
    expect(formatMonthLabel("2026-05", "long")).toBe("May 2026");
    expect(formatMonthLabel("2026-05", "short")).toBe("May");
    expect(formatMonthLabel("2026-04", "long")).toBe("April 2026");
    expect(formatMonthLabel("2026-04", "short")).toBe("Apr");
    expect(formatMonthLabel("2025-12", "short")).toBe("Dec");
  });

  it("calculates the immediately preceding month key correctly across years", () => {
    expect(previousMonthKey("2026-05")).toBe("2026-04");
    expect(previousMonthKey("2026-01")).toBe("2025-12");
    expect(previousMonthKey("2025-12")).toBe("2025-11");
  });

  it("builds a 6-month rolling window ending in the selected month", () => {
    const window = getRollingMonthKeys("2026-05", 6);
    expect(window).toEqual(["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);
  });

  it("collects available months from bills and default window descending", () => {
    const bills: PersonalBill[] = [
      { id: "b1", periodStart: "2026-03-15", periodEnd: "2026-04-14", kwh: 300, amountCentavos: 360000, source: "manual" },
      { id: "b2", periodStart: "2026-04-15", periodEnd: "2026-05-14", kwh: 340, amountCentavos: 400000, source: "ocr" },
    ];
    const months = getAvailableMonths(bills, "2026-05");
    expect(months.length).toBeGreaterThanOrEqual(6);
    expect(months[0].key).toBe("2026-05");
    expect(months[0].label).toBe("May 2026");
    expect(months.some((m) => m.key === "2026-04")).toBe(true);
  });
});

describe("Personal Analytics Category Helpers", () => {
  it("maps categories to valid icons in app.js iconPaths", () => {
    expect(categoryToIcon("cooling")).toBe("snowflake");
    expect(categoryToIcon("refrigeration")).toBe("refrigerator");
    expect(categoryToIcon("entertainment")).toBe("tv");
    expect(categoryToIcon("laundry")).toBe("washing-machine");
    expect(categoryToIcon("lighting")).toBe("zap");
    expect(categoryToIcon("computing")).toBe("zap");
    expect(categoryToIcon("other")).toBe("package");
    expect(categoryToIcon("custom_cat")).toBe("package");
  });

  it("formats user-friendly category display labels", () => {
    expect(categoryToLabel("cooling")).toBe("Air Conditioner / Cooling");
    expect(categoryToLabel("refrigeration")).toBe("Refrigerator");
    expect(categoryToLabel("other")).toBe("Others");
    expect(categoryToLabel("unattributed")).toBe("Other Household Usage");
  });
});

describe("computePersonalAnalytics", () => {
  const sampleAppliances: Appliance[] = [
    {
      id: "a1",
      name: "Inverter Air Conditioner",
      category: "cooling",
      watts: 900,
      quantity: 1,
      hoursPerDay: 8,
      daysPerWeek: 7,
      scheduleNote: null,
    },
    {
      id: "a2",
      name: "Two-Door Refrigerator",
      category: "refrigeration",
      watts: 150,
      quantity: 1,
      hoursPerDay: 24,
      daysPerWeek: 7,
      scheduleNote: null,
    },
  ];

  const sampleBills: PersonalBill[] = [
    {
      id: "b-apr",
      periodStart: "2026-03-15",
      periodEnd: "2026-04-14",
      kwh: 300,
      amountCentavos: 360000,
      source: "manual",
    },
    {
      id: "b-may",
      periodStart: "2026-04-15",
      periodEnd: "2026-05-14",
      kwh: 342.18,
      amountCentavos: 410616, // ~₱4,106.16 (₱12.00/kWh)
      source: "ocr",
    },
  ];

  it("calculates verified billed metrics and reconciles unattributed consumption for May 2026", () => {
    const result = computePersonalAnalytics({
      selectedMonth: "2026-05",
      bills: sampleBills,
      appliances: sampleAppliances,
    });

    expect(result.selectedMonth).toBe("2026-05");
    expect(result.monthLabel).toBe("May 2026");

    // Total Usage
    expect(result.totalUsage.kwh).toBe(342.18);
    expect(result.totalUsage.displayValue).toBe("342.18");
    expect(result.totalUsage.unit).toBe("kWh");
    expect(result.totalUsage.basis).toBe("billed");
    expect(result.totalUsage.foot).toContain("From bill: 2026-04-15 – 2026-05-14");

    // Estimated Cost
    expect(result.estimatedCost.amountPesos).toBeCloseTo(4106.16, 2);
    expect(result.estimatedCost.displayValue).toBe("₱4,106.16");
    expect(result.estimatedCost.basis).toBe("billed");
    expect(result.estimatedCost.foot).toBe("Billed amount");

    // Compared to Last Month (April had 300 kWh, May has 342.18 kWh -> +14.1%)
    expect(result.comparedToLastMonth.percentChange).toBeCloseTo(14.06, 1);
    expect(result.comparedToLastMonth.displayText).toBe("+14.1%");
    expect(result.comparedToLastMonth.trendDirection).toBe("up");
    expect(result.comparedToLastMonth.trendText).toBe("Consumption increase");
    expect(result.comparedToLastMonth.foot).toContain("vs April 2026 (300.00 kWh)");

    // Reconciled Breakdown & Unattributed usage
    // AC: 900W * 1 * 8h * (7/7) * (365.25/12) / 1000 = ~219.15 kWh
    // Fridge: 150W * 1 * 24h * 1 * (365.25/12) / 1000 = ~109.58 kWh
    // Appliance sum: ~328.73 kWh
    // Billed: 342.18 kWh -> Unattributed remainder: ~13.45 kWh
    expect(result.tableRows.length).toBe(3);
    const unattributed = result.tableRows.find((r) => r.category === "unattributed");
    expect(unattributed).toBeDefined();
    expect(unattributed?.name).toBe("Other Household Usage");
    expect(unattributed?.basis).toBe("Billed remainder");

    // Sum of table rows must equal billed kWh
    const sumTableKwh = result.tableRows.reduce((sum, r) => sum + r.kwh, 0);
    expect(sumTableKwh).toBeCloseTo(342.18, 1);

    // Sum of percentages must equal ~100%
    const sumPct = result.tableRows.reduce((sum, r) => sum + r.percent, 0);
    expect(sumPct).toBeCloseTo(100, 0);

    // Largest Consumer
    expect(result.largestConsumer.name).toBe("Inverter Air Conditioner");
    expect(result.largestConsumer.icon).toBe("snowflake");
    expect(result.largestConsumer.displayPercent).toContain("%");

    // 6-Month Rolling Trend
    expect(result.trend.labels).toEqual(["Dec", "Jan", "Feb", "Mar", "Apr", "May"]);
    expect(result.trend.points.find((p) => p.monthKey === "2026-05")?.kwh).toBe(342.18);
    expect(result.trend.points.find((p) => p.monthKey === "2026-04")?.kwh).toBe(300);
    expect(result.trend.points.find((p) => p.monthKey === "2026-03")?.isMissing).toBe(true);
    expect(result.trend.points.find((p) => p.monthKey === "2026-03")?.kwh).toBeNull();
  });

  it("handles month with appliances only (no bill) with modeled estimates", () => {
    const result = computePersonalAnalytics({
      selectedMonth: "2026-06",
      bills: sampleBills, // has May & Apr, none for June
      appliances: sampleAppliances,
      rateCentavosPerKwh: 1200, // ₱12.00/kWh
    });

    expect(result.selectedMonth).toBe("2026-06");
    expect(result.totalUsage.basis).toBe("modeled");
    expect(result.totalUsage.foot).toContain("Estimated appliance schedule");
    expect(result.totalUsage.kwh).toBeGreaterThan(0);

    expect(result.estimatedCost.basis).toBe("modeled");
    expect(result.estimatedCost.displayValue).toContain("₱");
    expect(result.estimatedCost.foot).toContain("Modeled at ₱12.00/kWh");

    // No unattributed remainder since there is no bill to exceed
    expect(result.tableRows.some((r) => r.category === "unattributed")).toBe(false);
  });

  it("handles completely empty state gracefully without crashing", () => {
    const result = computePersonalAnalytics({
      selectedMonth: "2026-05",
      bills: [],
      appliances: [],
    });

    expect(result.totalUsage.kwh).toBeNull();
    expect(result.totalUsage.displayValue).toBe("—");
    expect(result.totalUsage.basis).toBe("empty");
    expect(result.totalUsage.foot).toBe("No usage records for this month");

    expect(result.estimatedCost.amountPesos).toBeNull();
    expect(result.estimatedCost.displayValue).toBe("—");
    expect(result.estimatedCost.basis).toBe("empty");

    expect(result.largestConsumer.name).toBe("—");
    expect(result.largestConsumer.displayPercent).toBe("—");

    expect(result.comparedToLastMonth.displayText).toBe("Not available");
    expect(result.comparedToLastMonth.trendDirection).toBe("none");
    expect(result.comparedToLastMonth.foot).toBe("Insufficient prior data");

    expect(result.donut.hasData).toBe(false);
    expect(result.trend.hasData).toBe(false);
    expect(result.tableRows).toHaveLength(0);
  });

  it("reports 'Not available' when prior month has no data", () => {
    const singleBill: PersonalBill[] = [
      { id: "b1", periodStart: "2026-05-01", periodEnd: "2026-05-31", kwh: 250, amountCentavos: 300000, source: "ocr" },
    ];
    const result = computePersonalAnalytics({
      selectedMonth: "2026-05",
      bills: singleBill,
      appliances: [],
    });

    expect(result.comparedToLastMonth.displayText).toBe("Not available");
    expect(result.comparedToLastMonth.foot).toBe("Insufficient prior data");
  });

  it("handles negative consumption change (decrease) correctly", () => {
    const decreasingBills: PersonalBill[] = [
      { id: "b1", periodStart: "2026-03-15", periodEnd: "2026-04-14", kwh: 400, amountCentavos: 480000, source: "manual" },
      { id: "b2", periodStart: "2026-04-15", periodEnd: "2026-05-14", kwh: 360, amountCentavos: 432000, source: "ocr" },
    ];
    const result = computePersonalAnalytics({
      selectedMonth: "2026-05",
      bills: decreasingBills,
    });

    // ((360 - 400) / 400) * 100 = -10.0%
    expect(result.comparedToLastMonth.displayText).toBe("-10.0%");
    expect(result.comparedToLastMonth.trendDirection).toBe("down");
    expect(result.comparedToLastMonth.trendText).toBe("Consumption decrease");
  });
});

describe("generateAnalyticsCsv", () => {
  it("generates structured, valid CSV for the selected month", () => {
    const analytics = computePersonalAnalytics({
      selectedMonth: "2026-05",
      bills: [
        { id: "b1", periodStart: "2026-04-15", periodEnd: "2026-05-14", kwh: 342.18, amountCentavos: 410616, source: "ocr" },
      ],
      appliances: [
        { id: "a1", name: "Aircon", category: "cooling", watts: 900, quantity: 1, hoursPerDay: 8, daysPerWeek: 7, scheduleNote: null },
      ],
    });

    const csv = generateAnalyticsCsv(analytics);
    expect(csv).toContain("SmartWatts - Energy Analytics Report");
    expect(csv).toContain("Reporting Month,May 2026");
    expect(csv).toContain("Period Key,2026-05");
    expect(csv).toContain("Total Usage,342.18,kWh");
    expect(csv).toContain("Aircon");
    expect(csv).toContain("Other Household Usage");
    expect(csv).toContain("Privacy & Accuracy Notice");
  });
});
