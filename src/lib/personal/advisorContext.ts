/**
 * Builds the AI advisor context from the signed-in user's OWN personal workspace only
 * (users/{uid}/** — Firestore rules make this unreadable to anyone else, including landlords).
 * Only the numeric fields the calculator needs are sent: no names beyond the appliance label,
 * no addresses, account numbers, meter numbers, schedules notes, or rental data.
 */
import { listAppliances, listBills } from "./store";

export interface AdvisorContext {
  appliances: {
    name: string;
    category: string;
    quantity: number;
    watts: number;
    hoursPerDay: number;
    daysPerWeek: number;
    testedKwhMonth: number | null;
  }[];
  latestBill: { periodStart: string; periodEnd: string; kwh: number; amountCentavos: number } | null;
}

export async function buildAdvisorContext(): Promise<AdvisorContext> {
  const [appliances, bills] = await Promise.all([listAppliances(), listBills()]);
  const latest = [...bills].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  return {
    appliances: appliances
      .filter((a) => a.watts > 0 || (a.testedKwhMonth ?? 0) > 0)
      .slice(0, 50)
      .map((a) => ({
        name: a.name.slice(0, 60),
        category: (a.category || "other").slice(0, 40),
        quantity: a.quantity,
        watts: a.watts > 0 ? a.watts : 0,
        hoursPerDay: a.hoursPerDay,
        daysPerWeek: a.daysPerWeek,
        testedKwhMonth: a.watts > 0 ? null : a.testedKwhMonth ?? null,
      })),
    latestBill: latest
      ? { periodStart: latest.periodStart, periodEnd: latest.periodEnd, kwh: latest.kwh, amountCentavos: latest.amountCentavos }
      : null,
  };
}
