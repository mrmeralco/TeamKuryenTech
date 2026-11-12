/**
 * Appliance energy ESTIMATES for SmartWatts Personal (Tier 1).
 *
 * These numbers come from the wattage and schedule a person enters. They are
 * never meter measurements and must always be labelled as estimates.
 */

export const AVERAGE_DAYS_PER_MONTH = 365.25 / 12;

export interface ApplianceUsage {
  watts: number;
  quantity: number;
  hoursPerDay: number;
  daysPerWeek: number;
  testedKwhMonth?: number | null;
  testedKwh24h?: number | null;
  testedKwhYear?: number | null;
}

export function validateAppliance(appliance: ApplianceUsage): void {
  const { watts, quantity, hoursPerDay, daysPerWeek, testedKwhMonth, testedKwh24h, testedKwhYear } = appliance;
  const hasValidWatts = Number.isFinite(watts) && watts > 0 && watts <= 20000;
  const hasValidTested =
    (typeof testedKwhMonth === "number" && Number.isFinite(testedKwhMonth) && testedKwhMonth > 0 && testedKwhMonth < 5000) ||
    (typeof testedKwh24h === "number" && Number.isFinite(testedKwh24h) && testedKwh24h > 0 && testedKwh24h < 200) ||
    (typeof testedKwhYear === "number" && Number.isFinite(testedKwhYear) && testedKwhYear > 0 && testedKwhYear < 60000);

  if (!hasValidWatts && !hasValidTested) {
    throw new RangeError("Appliance must have either a valid wattage (1-20,000 W) or verified energy consumption.");
  }
  if (Number.isFinite(watts) && (watts < 0 || watts > 20000)) {
    throw new RangeError("Wattage must be between 1 and 20,000 W.");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new RangeError("Quantity must be a whole number from 1 to 50.");
  if (!Number.isFinite(hoursPerDay) || hoursPerDay < 0 || hoursPerDay > 24) throw new RangeError("Hours per day must be from 0 to 24.");
  if (!Number.isFinite(daysPerWeek) || daysPerWeek < 0 || daysPerWeek > 7) throw new RangeError("Days per week must be from 0 to 7.");
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Estimated kWh per average month for one appliance entry. */
export function estimateMonthlyKwh(appliance: ApplianceUsage): number {
  validateAppliance(appliance);
  const { watts, quantity, hoursPerDay, daysPerWeek, testedKwhMonth, testedKwh24h, testedKwhYear } = appliance;

  // 1. Wattage-based calculation (when rated watts are entered and > 0)
  if (Number.isFinite(watts) && watts > 0) {
    return round2((watts * quantity * hoursPerDay * (daysPerWeek / 7) * AVERAGE_DAYS_PER_MONTH) / 1000);
  }

  // 2. Verified tested energy consumption from energy efficiency labels
  if (typeof testedKwhMonth === "number" && testedKwhMonth > 0) {
    return round2(testedKwhMonth * quantity);
  }
  if (typeof testedKwh24h === "number" && testedKwh24h > 0) {
    return round2(testedKwh24h * quantity * AVERAGE_DAYS_PER_MONTH);
  }
  if (typeof testedKwhYear === "number" && testedKwhYear > 0) {
    return round2((testedKwhYear * quantity) / 12);
  }

  return 0;
}

/** Average cost per kWh of a specific bill, in centavos. Null when it cannot be derived. */
export function effectiveRateCentavosPerKwh(bill: { kwh: number; amountCentavos: number } | null | undefined): number | null {
  if (!bill || !Number.isFinite(bill.kwh) || bill.kwh <= 0 || !Number.isFinite(bill.amountCentavos) || bill.amountCentavos <= 0) {
    return null;
  }
  return round2(bill.amountCentavos / bill.kwh);
}

export interface SimulationChange {
  applianceId: string;
  hoursPerDay: number;
}

export interface SimulationResult {
  currentKwh: number;
  plannedKwh: number;
  savedKwh: number;
  savedCentavos: number;
  rows: { applianceId: string; currentKwh: number; plannedKwh: number; savedKwh: number }[];
}

/**
 * Compare current schedules with planned schedules. The rate is supplied by
 * the person (usually derived from their own bill) — there is no built-in
 * universal electricity price.
 */
export function simulateSavings(
  appliances: (ApplianceUsage & { id: string })[],
  changes: SimulationChange[],
  rateCentavosPerKwh: number,
): SimulationResult {
  if (!Number.isFinite(rateCentavosPerKwh) || rateCentavosPerKwh <= 0) throw new RangeError("Enter your electricity rate per kWh.");
  const planned = new Map(changes.map((change) => [change.applianceId, change.hoursPerDay]));
  const rows = appliances.map((appliance) => {
    const currentKwh = estimateMonthlyKwh(appliance);
    const plannedKwh = estimateMonthlyKwh({ ...appliance, hoursPerDay: planned.get(appliance.id) ?? appliance.hoursPerDay });
    return { applianceId: appliance.id, currentKwh, plannedKwh, savedKwh: round2(currentKwh - plannedKwh) };
  });
  const currentKwh = round2(rows.reduce((total, row) => total + row.currentKwh, 0));
  const plannedKwh = round2(rows.reduce((total, row) => total + row.plannedKwh, 0));
  const savedKwh = round2(currentKwh - plannedKwh);
  return { currentKwh, plannedKwh, savedKwh, savedCentavos: Math.round(savedKwh * rateCentavosPerKwh), rows };
}
