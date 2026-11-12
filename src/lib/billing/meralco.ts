/**
 * Deterministic Meralco-style bill model.
 *
 * - Money is integer centavos. Negative amounts are credits (subsidies, refunds).
 * - There is NO built-in tariff: every rate comes from the person's own bill.
 *   SmartWatts does not ship current Meralco tariff tables; rates change monthly.
 * - Each charge belongs to exactly one category, so nothing is double-counted.
 * - Projections are ESTIMATES (linear in kWh). They do not model fixed customer
 *   charges, tiered lifeline discounts, or next month's rate changes.
 */

export const CHARGE_CATEGORIES = [
  { id: "generation", label: "Generation" },
  { id: "transmission", label: "Transmission" },
  { id: "systemLoss", label: "System Loss" },
  { id: "distribution", label: "Distribution" },
  { id: "supply", label: "Supply" },
  { id: "metering", label: "Metering" },
  { id: "subsidies", label: "Subsidies (lifeline / senior citizen)" },
  { id: "universalCharges", label: "Universal Charges" },
  { id: "fitAll", label: "FIT-All" },
  { id: "geaAll", label: "GEA-All" },
  { id: "refundsAdjustments", label: "ERC refunds & other adjustments" },
  { id: "taxes", label: "Taxes" },
  { id: "other", label: "Other charges" },
] as const;

export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number]["id"];
export type ChargeComponents = Partial<Record<ChargeCategory, number>>;
export const CATEGORY_IDS: readonly ChargeCategory[] = CHARGE_CATEGORIES.map((c) => c.id);

export function categoryLabel(id: string): string {
  return CHARGE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function validateComponents(components: ChargeComponents): void {
  for (const [key, value] of Object.entries(components)) {
    if (!CATEGORY_IDS.includes(key as ChargeCategory)) throw new RangeError(`Unknown charge category: ${key}`);
    if (!Number.isInteger(value) || Math.abs(value as number) >= 1e11) throw new RangeError(`${categoryLabel(key)} must be a whole number of centavos.`);
  }
}

export interface Reconciliation {
  componentsCentavos: number;
  totalCentavos: number;
  differenceCentavos: number;
  balanced: boolean;
}

/** Do the itemized charges add up to the bill's total current charges? */
export function reconcileBill(totalCentavos: number, components: ChargeComponents): Reconciliation {
  validateComponents(components);
  const componentsCentavos = Object.values(components).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const differenceCentavos = totalCentavos - componentsCentavos;
  return { componentsCentavos, totalCentavos, differenceCentavos, balanced: differenceCentavos === 0 };
}

export interface RateProfile {
  /** Where the rates come from, e.g. "2026-09-12 to 2026-10-11 bill". */
  source: string;
  kwh: number;
  /** Average centavos per kWh for each category on the source bill (unrounded). */
  perKwh: Partial<Record<ChargeCategory | "average", number>>;
}

/**
 * Derive average per-kWh rates from one of the person's own bills.
 * With an itemized breakdown each category gets its own average; otherwise one overall average.
 */
export function deriveRateProfile(bill: {
  kwh: number;
  amountCentavos: number;
  periodStart?: string;
  periodEnd?: string;
  components?: ChargeComponents | null;
}): RateProfile {
  if (!Number.isFinite(bill.kwh) || bill.kwh <= 0) throw new RangeError("The bill must have kWh greater than zero.");
  const period = bill.periodStart && bill.periodEnd ? `your ${bill.periodStart} to ${bill.periodEnd} bill` : "your bill";
  const source = `the average per-kWh charges from ${period} (${bill.kwh} kWh)`;
  const components = bill.components && Object.keys(bill.components).length ? bill.components : null;
  if (!components) return { source, kwh: bill.kwh, perKwh: { average: bill.amountCentavos / bill.kwh } };
  validateComponents(components);
  const perKwh: RateProfile["perKwh"] = {};
  for (const [category, centavos] of Object.entries(components)) perKwh[category as ChargeCategory] = (centavos as number) / bill.kwh;
  return { source, kwh: bill.kwh, perKwh };
}

export interface Projection {
  kwh: number;
  byCategory: Partial<Record<ChargeCategory | "average", number>>;
  totalCentavos: number;
}

/** Linear projection: each category's average rate × kWh, rounded per category; total = sum of rounded parts. */
export function projectBill(kwh: number, profile: RateProfile): Projection {
  if (!Number.isFinite(kwh) || kwh < 0) throw new RangeError("kWh must be zero or greater.");
  const byCategory: Projection["byCategory"] = {};
  let totalCentavos = 0;
  for (const [category, rate] of Object.entries(profile.perKwh)) {
    const centavos = Math.round((rate as number) * kwh);
    byCategory[category as ChargeCategory] = centavos;
    totalCentavos += centavos;
  }
  return { kwh, byCategory, totalCentavos };
}

export interface ScenarioComparison {
  current: Projection;
  planned: Projection;
  savingsByCategory: Partial<Record<ChargeCategory | "average", number>>;
  savingsCentavos: number;
  assumptions: string[];
}

/** A single rate the person typed in (centavos per kWh). */
export function enteredRateProfile(rateCentavosPerKwh: number): RateProfile {
  if (!Number.isFinite(rateCentavosPerKwh) || rateCentavosPerKwh <= 0) throw new RangeError("Enter your electricity rate per kWh.");
  return { source: `the rate you entered (${(rateCentavosPerKwh / 100).toFixed(2)} pesos per kWh)`, kwh: 0, perKwh: { average: rateCentavosPerKwh } };
}

export function compareScenario(currentKwh: number, plannedKwh: number, profile: RateProfile): ScenarioComparison {
  const current = projectBill(currentKwh, profile);
  const planned = projectBill(plannedKwh, profile);
  const savingsByCategory: ScenarioComparison["savingsByCategory"] = {};
  for (const key of Object.keys(current.byCategory) as (ChargeCategory | "average")[]) {
    savingsByCategory[key] = (current.byCategory[key] ?? 0) - (planned.byCategory[key] ?? 0);
  }
  return {
    current,
    planned,
    savingsByCategory,
    savingsCentavos: current.totalCentavos - planned.totalCentavos,
    assumptions: [
      `Rates are ${profile.source}.`,
      "Each charge is assumed to scale with kWh; fixed monthly charges, tiered subsidies, and future rate changes are not modeled.",
      "Appliance kWh are estimates from wattage/label data and your schedule, not meter readings.",
    ],
  };
}
