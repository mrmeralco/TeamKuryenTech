import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({
  listAppliances: async () => [
    { id: "a1", name: "Aircon", category: "cooling", watts: 1000, quantity: 1, hoursPerDay: 8, daysPerWeek: 7, scheduleNote: "Bedroom of Juan", brand: "X", model: "Y" },
    { id: "a2", name: "LG Refrigerator", category: "refrigeration", watts: 0, quantity: 1, hoursPerDay: 8, daysPerWeek: 7, testedKwhMonth: 26.1, scheduleNote: null },
  ],
  listBills: async () => [
    { id: "b1", periodStart: "2026-08-12", periodEnd: "2026-09-11", kwh: 180, amountCentavos: 200000, source: "manual" },
    { id: "b2", periodStart: "2026-09-12", periodEnd: "2026-10-11", kwh: 200, amountCentavos: 240000, source: "ocr", components: { generation: 1 }, presentReading: 12245 },
  ],
}));

import { buildAdvisorContext } from "./advisorContext";

describe("AI advisor context (data minimization)", () => {
  it("sends only calculator inputs from the user's own data", async () => {
    const context = await buildAdvisorContext();
    expect(context).toEqual({
      appliances: [
        { name: "Aircon", category: "cooling", quantity: 1, watts: 1000, hoursPerDay: 8, daysPerWeek: 7, testedKwhMonth: null },
        { name: "LG Refrigerator", category: "refrigeration", quantity: 1, watts: 0, hoursPerDay: 8, daysPerWeek: 7, testedKwhMonth: 26.1 },
      ],
      latestBill: { periodStart: "2026-09-12", periodEnd: "2026-10-11", kwh: 200, amountCentavos: 240000 },
    });
    expect(JSON.stringify(context)).not.toMatch(/Juan|scheduleNote|presentReading|"id"/);
  });
});
