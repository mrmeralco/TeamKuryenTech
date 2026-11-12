import { describe, expect, it } from "vitest";
import { parseBack, parseFront, parseFrontMulti, toDashboardComponents, toMoney, validateBill } from "./meralcoScanner";

// Text layer of a Meralco PDF e-bill (account and meter numbers replaced with fakes).
const PDF_TEXT = `Your electric bill
Billing Period 26 Sep 2026 to 25 Oct 2026 Bill Date 25 Oct 2026
Customer Account Number (CAN) 1000000001 Due Date 05 Nov 2026
Electric Meter Number 000AAA000000
Date of Next Meter Reading 25 Nov 2026
Current Reading 8,896
Previous Reading 8,439
Actual Consumption 457 kWh
Your rate this month P 16.29 per kWh
Customer Type Residential
Remaining Balance from previous bill 0.00
Charges for this billing period 7,444.43
Generation 4,661.63
Transmission 522.90
System Loss 425.06
Distribution (Meralco) 894.62
Senior Citizen 0.05
Government Taxes 606.14
Universal Charges 175.95
FiT-All (Renewable) 153.51
GEA-All (Renewable) 0.00
Lifeline 4.57
Total Amount Due P 7,444.43`;

describe("meralcoScanner", () => {
  it("reads money with common OCR mistakes", () => {
    expect(toMoney("4,661.63")).toBe(4661.63);
    expect(toMoney("4,661 63")).toBe(4661.63);
    expect(toMoney("7.444.43")).toBe(7444.43);
    expect(toMoney("no money")).toBeNull();
  });

  it("parses a Meralco e-bill and every check passes", () => {
    const bill = parseFront(PDF_TEXT);
    expect(bill.billing).toMatchObject({ periodStart: "2026-09-26", periodEnd: "2026-10-25", billDate: "2026-10-25", dueDate: "2026-11-05", nextReadingDate: "2026-11-25" });
    expect(bill.reading).toMatchObject({ current: 8896, previous: 8439, kwh: 457, ratePerKwh: 16.29 });
    expect(bill.totals).toMatchObject({ previousBalance: 0, chargesThisPeriod: 7444.43, totalAmountDue: 7444.43 });
    expect(bill.charges.generation).toBe(4661.63);
    expect(validateBill(bill).every((c) => c.ok)).toBe(true);
  });

  it("maps charges onto dashboard categories in centavos", () => {
    const components = toDashboardComponents(parseFront(PDF_TEXT).charges);
    expect(components).toMatchObject({ generation: 466163, taxes: 60614, subsidies: 462, geaAll: 0 });
    const total = Object.values(components).reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(744443);
  });

  it("merges OCR passes, picking the reading that matches the kWh", () => {
    const badPass = PDF_TEXT.replace("Current Reading 8,896", "Current Reading 8,898").replace("Generation 4,661.63", "Generation 4,561.63");
    const merged = parseFrontMulti([badPass, PDF_TEXT]);
    expect(merged.reading.current).toBe(8896);
    expect(merged.charges.generation).toBe(4661.63);
    expect(validateBill(merged).every((c) => c.ok)).toBe(true);
  });

  it("flags readings that do not add up", () => {
    const bill = parseFront(PDF_TEXT.replace("Actual Consumption 457 kWh", "Actual Consumption 450 kWh"));
    const meter = validateBill(bill).find((c) => c.label === "Meter reading");
    expect(meter?.ok).toBe(false);
  });

  it("reads payments and rate lines from the back page", () => {
    const back = parseBack(`What you've paid
Payment 20 Oct 2026 7,100.00
How your bill was computed
Generation Charge 457 kWh 10.2015 4,661.63
Transmission Charge 457 kWh 1.1442 522.90`);
    expect(back.payments).toEqual([{ date: "2026-10-20", amount: 7100 }]);
    expect(back.rateRows[0]).toMatchObject({ component: "Generation Charge", basisKwh: 457, rate: 10.2015, amount: 4661.63 });
    expect(back.rateRows).toHaveLength(2);
  });
});
