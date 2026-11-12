/**
 * Browser-only OCR helpers (Tesseract.js). Images never leave the device.
 * OCR output is only ever a SUGGESTION: people must review and confirm every
 * value before it is saved.
 */

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

export interface BillSuggestion {
  kwh: number | null;
  /** Total current charges when printed, otherwise the amount due. */
  amountPesos: string | null;
  amountDuePesos: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  previousReading: number | null;
  presentReading: number | null;
  /** Itemized charges in integer centavos (credits negative). */
  components: Partial<Record<string, number>>;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Dates in a line, in order. Supports 09/12/2026, 2026-09-12, Sep 12, 2026 and 12 Sep 2026. */
export function findDates(line: string): string[] {
  const found: { index: number; iso: string }[] = [];
  for (const m of line.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const iso = isoDate(Number(m[3]), Number(m[1]), Number(m[2]));
    if (iso) found.push({ index: m.index ?? 0, iso });
  }
  for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) found.push({ index: m.index ?? 0, iso });
  }
  for (const m of line.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    const iso = month ? isoDate(Number(m[3]), month, Number(m[2])) : null;
    if (iso) found.push({ index: m.index ?? 0, iso });
  }
  for (const m of line.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const iso = month ? isoDate(Number(m[3]), month, Number(m[1])) : null;
    if (iso) found.push({ index: m.index ?? 0, iso });
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.iso);
}

/** Last money-like value on a line, in centavos. "(12.34)" and "-12.34" are credits. */
function lineAmountCentavos(line: string): number | null {
  const matches = [...line.matchAll(/(\(?-?)\s*(?:₱|php)?\s*(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\)?/gi)];
  const last = matches.at(-1);
  if (!last) return null;
  const centavos = Number(last[2].replace(/,/g, "")) * 100 + Number(last[3]);
  return last[1].includes("(") || last[1].includes("-") ? -centavos : centavos;
}

// Each category: an optional SUBTOTAL label and DETAIL labels. If a subtotal is printed it is
// used alone, so detail lines are never added on top of it (no double counting).
const COMPONENT_RULES: { id: string; subtotal?: RegExp; detail: RegExp }[] = [
  { id: "generation", detail: /\bgeneration\b/i },
  { id: "transmission", detail: /\btransmission\b/i },
  { id: "systemLoss", detail: /\bsystem\s*loss\b/i },
  { id: "distribution", detail: /\bdistribution\b/i },
  { id: "supply", detail: /\bsupply\s*(?:charge|system)/i },
  { id: "metering", detail: /\bmetering\b/i },
  { id: "subsidies", subtotal: /^\s*(?:total\s+)?subsidies\b/i, detail: /\b(?:lifeline|senior\s*citizen)/i },
  { id: "universalCharges", detail: /\buniversal\s*charge/i },
  { id: "fitAll", detail: /\bfit[\s-]*all\b/i },
  { id: "geaAll", detail: /\bgea[\s-]*all\b/i },
  { id: "refundsAdjustments", detail: /\b(?:refund|adjustment|erc\s*order|over\/under|differential)/i },
  { id: "taxes", subtotal: /^\s*(?:government|total)\s+taxes\b/i, detail: /\b(?:vat|value\s*added\s*tax|franchise\s*tax|local\s*tax|real\s*property\s*tax)\b/i },
];
const TOTAL_LINE = /\b(?:total\s+current\s+charges|total\s+amount\s+due|amount\s+due|total\s+due|previous\s+balance)\b/i;

export function extractBillComponents(text: string): Partial<Record<string, number>> {
  const lines = text.split("\n").filter((line) => !TOTAL_LINE.test(line));
  const result: Partial<Record<string, number>> = {};
  const used = new Set<number>();
  for (const rule of COMPONENT_RULES) {
    const subtotalIndex = rule.subtotal ? lines.findIndex((line, i) => !used.has(i) && rule.subtotal!.test(line) && lineAmountCentavos(line) !== null) : -1;
    if (subtotalIndex >= 0) {
      result[rule.id] = lineAmountCentavos(lines[subtotalIndex])!;
      used.add(subtotalIndex);
      lines.forEach((line, i) => { if (rule.detail.test(line)) used.add(i); });
      continue;
    }
    let sum: number | null = null;
    lines.forEach((line, i) => {
      if (used.has(i) || !rule.detail.test(line)) return;
      const amount = lineAmountCentavos(line);
      if (amount === null) return;
      sum = (sum ?? 0) + amount;
      used.add(i);
    });
    if (sum !== null) result[rule.id] = sum;
  }
  return result;
}

/** Find kWh, totals, billing period, meter readings and itemized charges in OCR text from a bill. */
export function extractBillFields(text: string): BillSuggestion {
  const lines = text.split("\n");
  const kwhMatch =
    text.match(new RegExp(`(?:total\\s+)?(?:consumption|kwh\\s+used|energy\\s+used)[^\\d\\n]{0,20}${NUMBER}\\s*kwh`, "i")) ??
    text.match(new RegExp(`${NUMBER}\\s*kwh`, "i"));
  const currentMatch = text.match(new RegExp(`total\\s+current\\s+charges[^\\d₱\\n]{0,20}(?:₱|php)?\\s*${NUMBER}`, "i"));
  const dueMatch =
    text.match(new RegExp(`(?:total\\s+amount\\s+due|amount\\s+due|total\\s+due)[^\\d₱\\n]{0,20}(?:₱|php|p)?\\s*${NUMBER}`, "i")) ??
    text.match(new RegExp(`(?:₱|php)\\s*${NUMBER}`, "i"));
  const kwh = kwhMatch ? toNumber(kwhMatch[1]) : null;
  const money = (match: RegExpMatchArray | null) => {
    const value = match ? toNumber(match[1]) : null;
    return value !== null && Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
  };
  const periodLine = lines.find((line) => /\b(?:billing\s+period|period\s+covered|service\s+period|period)\b/i.test(line) && findDates(line).length >= 2);
  const periodDates = periodLine ? findDates(periodLine) : [];
  const reading = (pattern: RegExp) => {
    const line = lines.find((l) => pattern.test(l));
    const match = line?.replace(pattern, "").match(/(\d{1,3}(?:,\d{3})+|\d{3,7})(?:\.\d+)?/);
    return match ? toNumber(match[0]) : null;
  };
  return {
    kwh: kwh !== null && Number.isFinite(kwh) && kwh > 0 ? kwh : null,
    amountPesos: money(currentMatch) ?? money(dueMatch),
    amountDuePesos: money(dueMatch),
    periodStart: periodDates[0] ?? null,
    periodEnd: periodDates[1] ?? null,
    previousReading: reading(/\bprevious\s+reading\b[^\d]*/i),
    presentReading: reading(/\b(?:present|current)\s+reading\b[^\d]*/i),
    components: extractBillComponents(text),
  };
}

const REDACTED = "[redacted]";

/**
 * Data minimization for anything shown or kept from OCR text: removes names, addresses,
 * account/contract/service/meter identifiers, emails, and phone numbers. Raw OCR text is
 * never stored; only reviewed numeric billing fields are saved.
 */
export function redactBillText(text: string): string {
  const labelled = /^(\s*(?:customer\s*name|account\s*name|name|service\s*address|billing\s*address|address|account\s*(?:no|number|#)|customer\s*account\s*(?:no|number)|can|contract\s*(?:account\s*)?(?:no|number)|service\s*id(?:\s*no)?|sin|meter\s*(?:no|number|serial)|serial\s*(?:no|number)|reference\s*(?:no|number)|tin)\b\.?\s*[:#-]?)(.*)$/i;
  return text
    .split("\n")
    .map((line) => {
      const match = line.match(labelled);
      if (match && match[2].trim()) return `${match[1]} ${REDACTED}`;
      return line
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED)
        .replace(/(?:\+?63|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}/g, REDACTED)
        .replace(/\b\d(?:[\s-]?\d){7,}\b/g, (value) => (/\.\d{2}$/.test(value) ? value : REDACTED));
    })
    .join("\n");
}

/** Suggest a register value from a meter photo: the longest run of digits (optionally with a decimal). */
export function extractMeterReading(text: string): number | null {
  const candidates = [...text.replace(/[Oo]/g, "0").matchAll(/\d{3,7}(?:[.,]\d{1,3})?/g)].map((match) => match[0].replace(",", "."));
  if (!candidates.length) return null;
  const best = candidates.sort((a, b) => b.replace(".", "").length - a.replace(".", "").length)[0];
  const value = Number(best);
  return Number.isFinite(value) ? value : null;
}

export async function recognizeImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file, or enter the values manually.");
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
