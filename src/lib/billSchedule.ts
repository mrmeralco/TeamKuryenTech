/**
 * Bill calendar: dates read from scanned bills (bill date, due date, next meter reading)
 * plus a PREDICTION of the next bill and payment due date, based on the person's own history.
 * Predictions are labelled as estimates; nothing here is sent to Meralco.
 */

export interface BillDates {
  /** Billing period end (links the dates to a saved bill). */
  periodEnd: string;
  periodStart?: string | null;
  billDate?: string | null;
  dueDate?: string | null;
  nextReadingDate?: string | null;
  amountCentavos?: number | null;
}

export type CalendarEventKind = "bill" | "due" | "reading" | "predicted-bill" | "predicted-due";

export interface CalendarEvent {
  date: string; // YYYY-MM-DD
  kind: CalendarEventKind;
  title: string;
  amountCentavos?: number | null;
  predicted: boolean;
}

export interface Prediction {
  nextBillDate: string | null;
  nextDueDate: string | null;
  /** Average of the most recent bills (up to 3), in centavos. */
  estimatedAmountCentavos: number | null;
  /** How the dates were predicted, shown to the person. */
  basis: string;
}

const DAY = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => toIso(toTime(iso) + days * DAY);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(toTime(v));

/** Same day next month (clamped, e.g. Jan 31 -> Feb 28). */
export function addOneMonth(iso: string): string {
  const d = new Date(toTime(iso));
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(Date.UTC(y, m, Math.min(day, last)));
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

/**
 * Predict the next bill and due date from history.
 *  - Next bill: the printed "next meter reading" date when available, else last bill date + the
 *    person's usual cycle (median of their past cycles, 28–35 days), else + 1 month.
 *  - Next due: next bill date + the usual gap between bill date and due date (median), else 10 days.
 */
export function predictNext(history: BillDates[]): Prediction {
  const rows = history
    .filter((h) => isIso(h.periodEnd))
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (!rows.length) return { nextBillDate: null, nextDueDate: null, estimatedAmountCentavos: null, basis: "Scan or add a bill to start predicting." };
  const last = rows[rows.length - 1];
  const lastBill = isIso(last.billDate) ? last.billDate : last.periodEnd;

  const billDates = rows.map((r) => (isIso(r.billDate) ? r.billDate : r.periodEnd));
  const cycles = billDates.slice(1).map((d, i) => daysBetween(billDates[i], d)).filter((n) => n >= 25 && n <= 40);
  const cycle = median(cycles);
  const gaps = rows.filter((r) => isIso(r.dueDate)).map((r) => daysBetween(isIso(r.billDate) ? r.billDate : r.periodEnd, r.dueDate!)).filter((n) => n >= 3 && n <= 30);
  const gap = median(gaps);

  let nextBillDate: string;
  let basis: string;
  if (isIso(last.nextReadingDate) && last.nextReadingDate > lastBill) {
    nextBillDate = last.nextReadingDate;
    basis = "Next bill: the “next meter reading” date printed on your latest bill.";
  } else if (cycle != null) {
    nextBillDate = addDays(lastBill, cycle);
    basis = `Next bill: your usual ${cycle}-day billing cycle.`;
  } else {
    nextBillDate = addOneMonth(lastBill);
    basis = "Next bill: about one month after your latest bill.";
  }
  const dueGap = gap ?? (isIso(last.dueDate) ? daysBetween(lastBill, last.dueDate) : 10);
  const nextDueDate = addDays(nextBillDate, dueGap);
  basis += gap != null || isIso(last.dueDate) ? ` Due date: ${dueGap} days after the bill, like your past bills.` : " Due date: about 10 days after the bill (typical).";

  const amounts = rows.map((r) => r.amountCentavos).filter((a): a is number => typeof a === "number" && a > 0).slice(-3);
  const estimatedAmountCentavos = amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length) : null;
  return { nextBillDate, nextDueDate, estimatedAmountCentavos, basis };
}

/** All calendar events: recorded dates from scanned bills + the predicted next bill/payment. */
export function calendarEvents(history: BillDates[], prediction: Prediction = predictNext(history)): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const h of history) {
    if (isIso(h.billDate)) events.push({ date: h.billDate, kind: "bill", title: "Bill issued", amountCentavos: h.amountCentavos, predicted: false });
    if (isIso(h.dueDate)) events.push({ date: h.dueDate, kind: "due", title: "Payment due", amountCentavos: h.amountCentavos, predicted: false });
    if (isIso(h.nextReadingDate)) events.push({ date: h.nextReadingDate, kind: "reading", title: "Meter reading", predicted: false });
  }
  if (prediction.nextBillDate && !events.some((e) => e.date === prediction.nextBillDate && e.kind === "reading")) {
    events.push({ date: prediction.nextBillDate, kind: "predicted-bill", title: "Next bill (predicted)", amountCentavos: prediction.estimatedAmountCentavos, predicted: true });
  }
  if (prediction.nextDueDate) {
    events.push({ date: prediction.nextDueDate, kind: "predicted-due", title: "Next payment due (predicted)", amountCentavos: prediction.estimatedAmountCentavos, predicted: true });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/** Month grid (weeks × 7 days, Sunday first) for a YYYY-MM month. Days outside the month are null. */
export function monthMatrix(year: number, month1to12: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  const cells: (string | null)[] = Array(first.getUTCDay()).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(toIso(Date.UTC(year, month1to12 - 1, d)));
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

/** Google Calendar "add event" link for an all-day reminder. */
export function googleCalendarLink(date: string, title: string, details: string): string {
  const start = date.replace(/-/g, "");
  const end = addDays(date, 1).replace(/-/g, "");
  const params = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${start}/${end}`, details });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** iCalendar file with all-day events (works with Google, Apple and Outlook calendars). */
export function buildIcs(events: CalendarEvent[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  const body = events.map((e, i) => [
    "BEGIN:VEVENT",
    `UID:smartwatts-${e.kind}-${e.date}-${i}@smartwatts`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${addDays(e.date, 1).replace(/-/g, "")}`,
    `SUMMARY:${esc(`SmartWatts: ${e.title}`)}`,
    ...(e.kind === "due" || e.kind === "predicted-due" ? ["BEGIN:VALARM", "TRIGGER:-P2D", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, "END:VALARM"] : []),
    "END:VEVENT",
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SmartWatts//Bill calendar//EN", "CALSCALE:GREGORIAN", ...body, "END:VCALENDAR"].join("\r\n") + "\r\n";
}
