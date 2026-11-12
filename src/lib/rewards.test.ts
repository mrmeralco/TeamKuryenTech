import { afterEach, describe, expect, it, vi } from "vitest";
import { addCalendarMonths, addCoinBatch, awardMonthlyReduction, checkIn, coinBalanceCents, completeQuest, completedQuestsToday, forecastDailyCost, getCoinState, redeemCoinBatches, setGameUser } from "../../game.js";

describe("Watts Coins ledger", () => {
  afterEach(() => {
    localStorage.clear();
    setGameUser("guest");
    vi.useRealTimers();
  });

  it("expires each earned batch three calendar months later with month-end clamping", () => {
    expect(addCalendarMonths(new Date("2027-01-31T12:00:00.000Z")).toISOString())
      .toBe("2027-04-30T12:00:00.000Z");
  });

  it("awards only reduced kWh, caps each billing cycle, and prevents duplicate claims", () => {
    setGameUser("reward-test");
    expect(awardMonthlyReduction(100, 125, "2027-01")).toBe(500);
    expect(awardMonthlyReduction(90, 200, "2027-01")).toBe(0);
    expect(awardMonthlyReduction(201, 200, "2027-02")).toBe(0);
    expect(awardMonthlyReduction(100, 200, "2027-02")).toBe(1500);
    expect(coinBalanceCents()).toBe(2000);
  });

  it("locks check-in until a daily quest is done and awards exactly 5 coins across seven check-ins", () => {
    setGameUser("checkin-test");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T05:00:00.000Z"));
    expect(checkIn()).toBe(false);
    // Quest coins are tracked separately so the streak total stays exactly 5.00.
    const questCents = () => getCoinState().ledger.filter((item: { source: string }) => item.source.includes("Quest")).reduce((sum: number, item: { amountCents: number }) => sum + item.amountCents, 0);
    expect(completeQuest("tip")).toBe(true);
    expect(checkIn()).toBe(true);
    const duplicateResult = checkIn();
    for (let day = 1; day < 7; day += 1) {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(checkIn()).toBe(false); // new day: locked again until a quest is done
      completeQuest("forecast");
      expect(checkIn()).toBe(true);
    }
    expect(duplicateResult).toBe(false);
    expect(questCents()).toBe(35);
    expect(coinBalanceCents() - questCents()).toBe(500);
    expect(getCoinState().ledger.filter((item: { source: string }) => /Check-In|Streak/.test(item.source))).toHaveLength(7);
    expect(getCoinState().ledger.find((item: { source: string }) => item.source.includes("7-Day Streak"))).toBeTruthy();
  });

  it("awards each daily quest once per Manila day for +0.05 coins", () => {
    setGameUser("quest-test");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-03-01T15:30:00.000Z")); // 23:30 Manila
    expect(completeQuest("tip")).toBe(true);
    expect(completeQuest("tip")).toBe(false);
    expect(completeQuest("unknown")).toBe(false);
    expect(completedQuestsToday()).toEqual(["tip"]);
    vi.setSystemTime(new Date("2027-03-01T16:30:00.000Z")); // 00:30 Manila, next day
    expect(completedQuestsToday()).toEqual([]);
    expect(completeQuest("tip")).toBe(true);
    expect(completeQuest("forecast")).toBe(true);
    expect(coinBalanceCents()).toBe(15);
  });

  it("forecasts daily appliance cost from watts, hours, and rate", () => {
    expect(forecastDailyCost(1000, 8, 1225)).toEqual({ kwh: 8, costCentavos: 9800 });
    expect(() => forecastDailyCost(0, 8, 1225)).toThrow(/wattage/);
    expect(() => forecastDailyCost(1000, 25, 1225)).toThrow(/hours/);
    expect(() => forecastDailyCost(1000, 8, 0)).toThrow(/rate/);
  });

  it("deducts redemptions FIFO and refuses redemption outside the bill window", () => {
    setGameUser("fifo-test");
    addCoinBatch(100, "Daily Check-In", new Date("2027-01-01T00:00:00.000Z"));
    addCoinBatch(100, "Daily Check-In", new Date("2027-01-02T00:00:00.000Z"));
    expect(() => redeemCoinBatches(50, false)).toThrow(/only be redeemed during/i);
    redeemCoinBatches(150, true);
    const batches = getCoinState().batches;
    expect(batches.map((batch: { remainingCents: number }) => batch.remainingCents)).toEqual([0, 50]);
    expect(coinBalanceCents()).toBe(50);
  });

  it("moves expired unused value out of the balance and appends an expiration ledger entry", () => {
    setGameUser("expiry-test");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-05-01T00:00:00.000Z"));
    addCoinBatch(75, "Daily Check-In", new Date("2027-01-01T00:00:00.000Z"));
    expect(coinBalanceCents()).toBe(0);
    const expiration = getCoinState().ledger.find((item: { kind: string }) => item.kind === "expiration");
    if (!expiration) throw new Error("Expected an expiration ledger entry.");
    expect(expiration.source).toBe("Coins expiration (3-month validity ended)");
    expect(expiration.amountCents).toBe(-75);
  });

  it("queues the seven-day expiry warning only once per batch", () => {
    setGameUser("warning-test");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T12:00:00.000Z"));
    addCoinBatch(50, "Daily Check-In", new Date("2026-10-08T12:00:00.000Z"));
    const warning = vi.fn();
    window.addEventListener("smartwatts-coins-expiring", warning);
    getCoinState();
    getCoinState();
    expect(warning).toHaveBeenCalledTimes(1);
    expect((warning.mock.calls[0][0] as CustomEvent<{ amountCents: number }>).detail.amountCents).toBe(50);
    window.removeEventListener("smartwatts-coins-expiring", warning);
  });
});
