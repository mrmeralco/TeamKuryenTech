import { describe, expect, it } from "vitest";
import { addOneMonth, buildIcs, calendarEvents, googleCalendarLink, monthMatrix, predictNext } from "./billSchedule";

describe("bill schedule", () => {
  it("uses the printed next meter reading date and the bill-to-due gap", () => {
    const p = predictNext([{ periodEnd: "2026-10-25", billDate: "2026-10-25", dueDate: "2026-11-05", nextReadingDate: "2026-11-25", amountCentavos: 744443 }]);
    expect(p.nextBillDate).toBe("2026-11-25");
    expect(p.nextDueDate).toBe("2026-12-06"); // 11 days after the bill, like the last one
    expect(p.estimatedAmountCentavos).toBe(744443);
  });

  it("learns the usual cycle from history when no reading date is printed", () => {
    const p = predictNext([
      { periodEnd: "2026-08-26", billDate: "2026-08-26", dueDate: "2026-09-06", amountCentavos: 600000 },
      { periodEnd: "2026-09-25", billDate: "2026-09-25", dueDate: "2026-10-06", amountCentavos: 700000 },
      { periodEnd: "2026-10-25", billDate: "2026-10-25", dueDate: "2026-11-05", amountCentavos: 800000 },
    ]);
    expect(p.nextBillDate).toBe("2026-11-24"); // median 30-day cycle
    expect(p.nextDueDate).toBe("2026-12-05");
    expect(p.estimatedAmountCentavos).toBe(700000);
  });

  it("falls back to one month and handles month ends", () => {
    expect(addOneMonth("2026-01-31")).toBe("2026-02-28");
    const p = predictNext([{ periodEnd: "2026-10-25" }]);
    expect(p.nextBillDate).toBe("2026-11-25");
    expect(p.nextDueDate).toBe("2026-12-05");
    expect(predictNext([]).nextBillDate).toBeNull();
  });

  it("builds events, a month grid, and calendar exports", () => {
    const events = calendarEvents([{ periodEnd: "2026-10-25", billDate: "2026-10-25", dueDate: "2026-11-05", nextReadingDate: "2026-11-25" }]);
    expect(events.map((e) => e.kind)).toEqual(["bill", "due", "reading", "predicted-due"]);
    const grid = monthMatrix(2026, 11);
    expect(grid.flat().filter(Boolean)).toHaveLength(30);
    expect(grid.every((week) => week.length === 7)).toBe(true);
    expect(googleCalendarLink("2026-12-06", "Pay Meralco bill", "x")).toContain("dates=20261206%2F20261207");
    const ics = buildIcs(events, new Date("2026-11-13T00:00:00Z"));
    expect(ics).toContain("DTSTART;VALUE=DATE:20261105");
    expect(ics).toContain("TRIGGER:-P2D");
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
  });
});
