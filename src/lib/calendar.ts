/**
 * Consumption calendar: billing-period history without fabricating daily data.
 *
 * Billing periods rarely match calendar months, so periods keep their exact dates. The month
 * grid only shows which periods OVERLAP each month (with the overlapping day count); it never
 * splits a bill's kWh into invented daily or monthly values. Per-day figures are labelled as
 * period averages. Goals and appliance estimates are scaled to the period length and labelled.
 */

export const AVERAGE_DAYS_PER_MONTH = 365.25 / 12;
const DAY_MS = 86_400_000;

export interface PeriodRecord {
  periodStart: string;
  periodEnd: string;
  /** null when the period has no measured kWh (e.g. allocation-only tenant statements). */
  kwh: number | null;
  amountCentavos: number | null;
  /** "recorded" = from an official bill or finalized statement. */
  kind: "recorded";
  label?: string;
}

export interface TimelineEntry extends PeriodRecord {
  days: number;
  averageKwhPerDay: number | null;
  changeVsPreviousPercent: number | null;
  goalForPeriodKwh: number | null;
  goalDifferenceKwh: number | null;
  estimatedForPeriodKwh: number | null;
}

const parse = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Inclusive day count of a billing period. */
export function periodDays(start: string, end: string): number {
  const days = Math.round((parse(end) - parse(start)) / DAY_MS) + 1;
  if (!Number.isFinite(days) || days < 1) throw new RangeError("A billing period must end on or after its start.");
  return days;
}

export function buildTimeline(
  records: readonly PeriodRecord[],
  options: { monthlyGoalKwh?: number | null; estimatedMonthlyKwh?: number | null } = {},
): TimelineEntry[] {
  const sorted = [...records].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  return sorted.map((record, index) => {
    const days = periodDays(record.periodStart, record.periodEnd);
    const averageKwhPerDay = record.kwh === null ? null : record.kwh / days;
    const previous = index > 0 ? sorted[index - 1] : null;
    // Compare per-day averages so periods of different lengths are comparable.
    const previousPerDay = previous && previous.kwh !== null ? previous.kwh / periodDays(previous.periodStart, previous.periodEnd) : null;
    const scale = days / AVERAGE_DAYS_PER_MONTH;
    const goalForPeriodKwh = options.monthlyGoalKwh ? round2(options.monthlyGoalKwh * scale) : null;
    return {
      ...record,
      days,
      averageKwhPerDay: averageKwhPerDay === null ? null : round2(averageKwhPerDay),
      changeVsPreviousPercent: previousPerDay && averageKwhPerDay !== null ? round2(((averageKwhPerDay - previousPerDay) / previousPerDay) * 100) : null,
      goalForPeriodKwh,
      goalDifferenceKwh: goalForPeriodKwh === null || record.kwh === null ? null : round2(record.kwh - goalForPeriodKwh),
      estimatedForPeriodKwh: options.estimatedMonthlyKwh ? round2(options.estimatedMonthlyKwh * scale) : null,
    };
  });
}

export interface MonthCell {
  month: number; // 1-12
  periods: { periodStart: string; periodEnd: string; overlapDays: number; kwh: number | null; amountCentavos: number | null; label?: string }[];
}

/** Which billing periods overlap each month of a year (kWh are the whole period's, never split). */
export function monthGrid(records: readonly PeriodRecord[], year: number): MonthCell[] {
  return Array.from({ length: 12 }, (_, i) => {
    const monthStart = Date.UTC(year, i, 1);
    const monthEnd = Date.UTC(year, i + 1, 0);
    const periods = records
      .map((record) => {
        const start = Math.max(parse(record.periodStart), monthStart);
        const end = Math.min(parse(record.periodEnd), monthEnd);
        const overlapDays = end >= start ? Math.round((end - start) / DAY_MS) + 1 : 0;
        return { periodStart: record.periodStart, periodEnd: record.periodEnd, overlapDays, kwh: record.kwh, amountCentavos: record.amountCentavos, label: record.label };
      })
      .filter((cell) => cell.overlapDays > 0)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    return { month: i + 1, periods };
  });
}

export function yearsCovered(records: readonly PeriodRecord[]): number[] {
  const years = new Set<number>();
  for (const record of records) {
    for (let y = Number(record.periodStart.slice(0, 4)); y <= Number(record.periodEnd.slice(0, 4)); y += 1) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

/** Average kWh per day by the calendar month in which each period ends (seasonal pattern). */
export function seasonalAverages(records: readonly PeriodRecord[]): { month: number; averageKwhPerDay: number; periods: number }[] {
  const groups = new Map<number, { kwh: number; days: number; periods: number }>();
  for (const record of records) {
    if (record.kwh === null) continue;
    const month = Number(record.periodEnd.slice(5, 7));
    const group = groups.get(month) ?? { kwh: 0, days: 0, periods: 0 };
    group.kwh += record.kwh;
    group.days += periodDays(record.periodStart, record.periodEnd);
    group.periods += 1;
    groups.set(month, group);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([month, group]) => ({ month, averageKwhPerDay: round2(group.kwh / group.days), periods: group.periods }));
}
