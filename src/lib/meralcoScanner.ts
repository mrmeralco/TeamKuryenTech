/**
 * Meralco bill scanner (ported from jrmph/MERALCO-SCANNER). Runs fully in the browser:
 *  - PDF e-bill -> pdf.js text layer (exact), or render + OCR for scanned PDFs
 *  - Photo      -> Tesseract.js, 2 OCR passes (PSM 3 + PSM 4) merged field by field
 * The Meralco template parser picks the reading/charges combination that matches the
 * printed totals, then validation checks are shown so the person can fix red fields.
 * Nothing is uploaded; results are only suggestions for the review form.
 */

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DATE_RE = /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/gi;
// Money at the end of a line, tolerating common OCR errors ("4,661 63", "7.444.43").
const MONEY_END_RE = /(-?\d{1,3}(?:[,.]\d{3})*|-?\d+)(?:[.\s,](\d{2}))\s*$/;

export type ChargeKey =
  | "generation" | "transmission" | "systemLoss" | "distribution" | "seniorCitizen"
  | "governmentTaxes" | "universalCharges" | "fitAll" | "geaAll" | "lifeline";

export interface ScannedBill {
  billing: { periodStart: string | null; periodEnd: string | null; billDate: string | null; dueDate: string | null; nextReadingDate: string | null };
  reading: { current: number | null; previous: number | null; kwh: number | null; ratePerKwh: number | null };
  charges: Record<ChargeKey, number | null>;
  totals: { previousBalance: number | null; chargesThisPeriod: number | null; totalAmountDue: number | null };
}

export interface ScanCheck { ok: boolean; label: string; detail: string }

export interface ScanResult {
  bill: ScannedBill;
  checks: ScanCheck[];
  /** All recognized text (for the redacted review drawer only; never stored). */
  text: string;
  method: "pdf-text" | "pdf-ocr" | "image-ocr";
  confidence: number | null;
  warnings: string[];
}

export function toMoney(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = String(raw).trim().match(MONEY_END_RE);
  if (!m) return null;
  const n = Number(`${m[1].replace(/[,.]/g, "")}.${m[2]}`);
  return Number.isFinite(n) ? n : null;
}

function cleanLine(s: string): string {
  return s
    .replace(/\b(\d{1,2}\s+)0(ct)\b/gi, "$1O$2")
    .replace(/\b(\d{1,2}\s+)N0v\b/gi, "$1Nov")
    .replace(/[|]/g, " ")
    .replace(/[₱]/g, "P ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(d: string, mon: string, y: string): Date | null {
  const dt = new Date(Date.UTC(Number(y), MONTHS[mon.slice(0, 3).toLowerCase()], Number(d)));
  return Number.isNaN(dt.getTime()) ? null : dt;
}
const iso = (dt: Date | null | undefined) => (dt ? dt.toISOString().slice(0, 10) : null);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000);

function allDates(text: string): Date[] {
  const out: Date[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const dt = parseDate(m[1], m[2], m[3]);
    if (dt) out.push(dt);
  }
  return out;
}

function moneyAfterLabel(lines: string[], labelRe: RegExp): number | null {
  for (const line of lines) {
    const idx = line.search(labelRe);
    if (idx === -1) continue;
    const v = toMoney(line.slice(idx).replace(labelRe, ""));
    if (v != null) return v;
  }
  return null;
}

// Layout with the label above and the value below (e.g. "Current Reading" / "8,896").
function readingNear(lines: string[], labelRe: RegExp): number | null {
  const i = lines.findIndex((l) => labelRe.test(l));
  if (i === -1) return null;
  for (const line of [lines[i].replace(/^.*?(reading)/i, ""), lines[i + 1] || "", lines[i + 2] || ""]) {
    const m = line.replace(DATE_RE, " ").match(/\b(\d{1,3}(?:,\d{3})+|\d{3,6})\b(?!\s*kwh)/i);
    if (m) return Number(m[1].replace(/,/g, ""));
  }
  return null;
}

const CHARGE_LABELS: [ChargeKey, RegExp][] = [
  ["generation", /\bGenera(?:tion|t[il1]on)\b/i],
  ["transmission", /\bTrans\w*ssion\b/i],
  ["systemLoss", /\bSystem\s*Loss\b/i],
  ["distribution", /\bDistribution\b/i],
  ["seniorCitizen", /\bSen\w{1,3}r\s*Citi\w*/i],
  ["governmentTaxes", /\bGovern\w*\s*Tax\w*/i],
  ["universalCharges", /\bUniver\w*\s*Charg\w*/i],
  ["fitAll", /\bF[il1]T[\s-]*A\S*\s*\(?Renew\w*\)?|\bF[il1]T[\s-]*All\b/i],
  ["geaAll", /\bGEA[\s-]*A\S*\s*\(?Renew\w*\)?|\bGEA[\s-]*All\b/i],
  ["lifeline", /\bLifeline\b/i],
];

export function parseFront(rawText: string): ScannedBill {
  const lines = rawText.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const text = lines.join("\n");
  const r: ScannedBill = {
    billing: { periodStart: null, periodEnd: null, billDate: null, dueDate: null, nextReadingDate: null },
    reading: { current: null, previous: null, kwh: null, ratePerKwh: null },
    charges: Object.fromEntries(CHARGE_LABELS.map(([k]) => [k, null])) as Record<ChargeKey, number | null>,
    totals: { previousBalance: null, chargesThisPeriod: null, totalAmountDue: null },
  };

  const period = text.match(new RegExp(`${DATE_RE.source}\\s*to\\s*${DATE_RE.source}`, "i"));
  let periodEnd: Date | null = null;
  if (period) {
    r.billing.periodStart = iso(parseDate(period[1], period[2], period[3]));
    periodEnd = parseDate(period[4], period[5], period[6]);
    r.billing.periodEnd = iso(periodEnd);
  }
  const dates = allDates(text);
  const billDate = periodEnd ?? dates[0] ?? null;
  r.billing.billDate = iso(billDate);
  if (billDate) {
    const sorted = [...new Set(dates.map((d) => d.getTime()))].map((t) => new Date(t)).sort((a, b) => a.getTime() - b.getTime());
    r.billing.dueDate = iso(sorted.find((d) => { const n = daysBetween(billDate, d); return n >= 5 && n <= 25; }));
    // Next meter reading: about a month after the bill date (printed as "Date of Next Meter Reading").
    r.billing.nextReadingDate = iso(sorted.find((d) => { const n = daysBetween(billDate, d); return n >= 26 && n <= 40; }));
  }

  r.reading.current = readingNear(lines, /Current\s*Reading/i) ?? readingNear(lines, /Present\s*Reading/i);
  r.reading.previous = readingNear(lines, /Previous\s*Reading/i);
  const kwhIdx = lines.findIndex((l) => /Actual\s*Consumption/i.test(l));
  const kwhZone = kwhIdx >= 0 ? lines.slice(kwhIdx, kwhIdx + 3).join(" ") : text;
  const kwh = kwhZone.match(/(\d[\d,]*)\s*kwh/i);
  r.reading.kwh = kwh ? Number(kwh[1].replace(/,/g, "")) : null;
  const rate = text.match(/(\d{1,3}[.,]\d{2})\s*per\s*kwh/i);
  r.reading.ratePerKwh = rate ? Number(rate[1].replace(",", ".")) : null;

  for (const [key, re] of CHARGE_LABELS) r.charges[key] = moneyAfterLabel(lines, re);
  r.totals.previousBalance = moneyAfterLabel(lines, /Remaining\s*Balance[^\d]*/i);
  r.totals.chargesThisPeriod = moneyAfterLabel(lines, /Charges\s*for\s*this\s*billing\s*period/i);
  r.totals.totalAmountDue = moneyAfterLabel(lines, /Total\s*Amount\s*Due\s*P?/i);
  return r;
}

function candidates<T>(vals: (T | null)[]): T[] {
  const present = vals.filter((v): v is T => v != null);
  const counts = new Map<T, number>();
  present.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  return [...new Set(present)].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}
const pickCommon = <T>(vals: (T | null)[]): T | null => candidates(vals)[0] ?? null;

/** Merge several OCR passes: most common value per field; readings and charges must match the printed totals. */
export function parseFrontMulti(texts: string[]): ScannedBill {
  const parsed = texts.filter((t) => t && t.trim()).map(parseFront);
  if (parsed.length <= 1) return parsed[0] ?? parseFront("");
  const out = structuredClone(parsed[0]);
  for (const group of ["billing", "reading", "totals"] as const) {
    for (const key of Object.keys(out[group]) as (keyof typeof out[typeof group])[]) {
      (out[group] as Record<string, unknown>)[key as string] = pickCommon(parsed.map((p) => (p[group] as Record<string, unknown>)[key as string] as never));
    }
  }
  const cur = candidates(parsed.map((p) => p.reading.current));
  const prev = candidates(parsed.map((p) => p.reading.previous));
  const kwh = candidates(parsed.map((p) => p.reading.kwh));
  outer: for (const c of cur) for (const p of prev) for (const k of kwh) {
    if (c - p === k) { Object.assign(out.reading, { current: c, previous: p, kwh: k }); break outer; }
  }

  const keys = Object.keys(out.charges) as ChargeKey[];
  const opts = keys.map((k) => candidates(parsed.map((p) => p.charges[k])));
  for (const k of keys) out.charges[k] = pickCommon(parsed.map((p) => p.charges[k]));
  const target = out.totals.chargesThisPeriod;
  const combos = opts.reduce((n, o) => n * Math.max(1, o.length), 1);
  if (target != null && opts.every((o) => o.length) && combos <= 4096) {
    const pick = new Array(keys.length).fill(0);
    for (let i = 0; i < combos; i++) {
      let rem = i;
      for (let j = 0; j < keys.length; j++) { pick[j] = rem % opts[j].length; rem = Math.floor(rem / opts[j].length); }
      const sum = pick.reduce((a, idx, j) => a + opts[j][idx], 0);
      if (Math.abs(sum - target) < 0.02) { keys.forEach((k, j) => (out.charges[k] = opts[j][pick[j]])); break; }
    }
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const peso = (n: number) => "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function validateBill(bill: ScannedBill): ScanCheck[] {
  const checks: ScanCheck[] = [];
  const { reading: rd, charges, totals, billing } = bill;

  if (rd.current != null && rd.previous != null && rd.kwh != null) {
    const diff = rd.current - rd.previous;
    checks.push({ ok: diff === rd.kwh, label: "Meter reading", detail: `${rd.current} − ${rd.previous} = ${diff} kWh (bill says ${rd.kwh} kWh)` });
  } else {
    checks.push({ ok: false, label: "Meter reading", detail: "Some readings could not be read — type them in." });
  }

  const values = Object.values(charges);
  if (totals.chargesThisPeriod != null && values.every((v) => v != null)) {
    const sum = round2((values as number[]).reduce((a, b) => a + b, 0));
    const gap = round2(totals.chargesThisPeriod - sum);
    const ok = Math.abs(gap) < 0.02;
    checks.push({ ok, label: "Charges add up", detail: `Breakdown ${peso(sum)} vs. ${peso(totals.chargesThisPeriod)}${ok ? "" : ` (off by ${peso(gap)})`}` });
  } else {
    checks.push({ ok: false, label: "Charges add up", detail: "Some charges could not be read — type them in." });
  }

  if (totals.totalAmountDue != null && totals.chargesThisPeriod != null) {
    const expect = round2((totals.previousBalance || 0) + totals.chargesThisPeriod);
    checks.push({ ok: Math.abs(expect - totals.totalAmountDue) < 0.02, label: "Total amount due", detail: `Previous balance + charges = ${peso(expect)} (bill says ${peso(totals.totalAmountDue)})` });
  }

  if (rd.kwh && rd.ratePerKwh && totals.chargesThisPeriod) {
    const est = rd.kwh * rd.ratePerKwh;
    checks.push({ ok: Math.abs(est - totals.chargesThisPeriod) / totals.chargesThisPeriod < 0.01, label: "kWh × rate", detail: `${rd.kwh} × ₱${rd.ratePerKwh} ≈ ${peso(round2(est))}` });
  }

  if (billing.periodStart && billing.periodEnd) {
    checks.push({ ok: billing.periodEnd > billing.periodStart, label: "Billing period", detail: `${billing.periodStart} → ${billing.periodEnd}` });
  } else {
    checks.push({ ok: false, label: "Billing period", detail: "Billing period not found — enter the dates." });
  }
  return checks;
}

/** Map the Meralco charge lines onto the dashboard's charge categories (integer centavos). */
export function toDashboardComponents(charges: ScannedBill["charges"]): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  const add = (id: string, value: number | null) => {
    if (value == null) return;
    out[id] = (out[id] ?? 0) + Math.round(value * 100);
  };
  add("generation", charges.generation);
  add("transmission", charges.transmission);
  add("systemLoss", charges.systemLoss);
  add("distribution", charges.distribution);
  add("subsidies", charges.seniorCitizen);
  add("subsidies", charges.lifeline);
  add("taxes", charges.governmentTaxes);
  add("universalCharges", charges.universalCharges);
  add("fitAll", charges.fitAll);
  add("geaAll", charges.geaAll);
  return out;
}

// ------------------------------------------------------------------ extraction (browser)
export type ScanProgress = (stage: string, pct: number | null) => void;

function fileToCanvas(source: ImageBitmap): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = source.width;
  c.height = source.height;
  c.getContext("2d")!.drawImage(source, 0, 0);
  return c;
}

/** Resolution + sharpness (variance of the Laplacian). Low sharpness = blurry. */
export function qualityWarnings(canvas: HTMLCanvasElement): string[] {
  const w = 600;
  const h = Math.max(1, Math.round((canvas.height / canvas.width) * w));
  const s = document.createElement("canvas");
  s.width = w;
  s.height = h;
  const ctx = s.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const blur = n ? sumSq / n - (sum / n) ** 2 : 0;
  const warnings: string[] = [];
  if (Math.max(canvas.width, canvas.height) < 1600) warnings.push(`Low resolution (${canvas.width}×${canvas.height}) — small numbers may be misread. Retake at full camera quality, or upload the PDF e-bill.`);
  if (blur < 60) warnings.push("The photo looks blurry. Hold the phone steady and make sure the bill is in focus.");
  return warnings;
}

function preprocess(src: HTMLCanvasElement): HTMLCanvasElement {
  const longSide = Math.max(src.width, src.height);
  if (longSide >= 1600) return src;
  const scale = Math.min(3, 2400 / longSide);
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = "grayscale(1) contrast(1.2)";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function ocrTwoPasses(canvas: HTMLCanvasElement, onProgress?: ScanProgress): Promise<{ passes: string[]; confidence: number }> {
  const { createWorker } = await import("tesseract.js");
  let label = "";
  const worker = await createWorker("eng", 1, {
    logger: (m: { status: string; progress: number }) => {
      onProgress?.(m.status === "recognizing text" ? `Reading bill (${label})…` : "Loading OCR…", m.progress);
    },
  });
  try {
    await worker.setParameters({ preserve_interword_spaces: "1" } as never);
    const input = preprocess(canvas);
    const passes: string[] = [];
    const confidences: number[] = [];
    for (const [psm, name] of [["3", "pass 1/2"], ["4", "pass 2/2"]] as const) {
      label = name;
      await worker.setParameters({ tessedit_pageseg_mode: psm } as never);
      const { data } = await worker.recognize(input);
      passes.push(data.text);
      confidences.push(data.confidence);
    }
    return { passes, confidence: Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) };
  } finally {
    await worker.terminate();
  }
}

// Join pdf.js text items with the same y into lines (like OCR output).
function itemsToLines(items: { str?: string; transform: number[] }[]): string {
  const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const [x, y] = [it.transform[4], it.transform[5]];
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, s: it.str });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" "))
    .join("\n");
}

async function extractPdf(file: File, onProgress?: ScanProgress): Promise<{ passes: string[]; method: ScanResult["method"]; confidence: number | null }> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const texts: string[] = [];
  let scanned = false;
  let confidence: number | null = 100;
  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress?.(`Reading PDF page ${p}/${pdf.numPages}…`, (p - 1) / pdf.numPages);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const text = itemsToLines(tc.items as { str?: string; transform: number[] }[]);
    if (text.replace(/\s/g, "").length > 100) {
      texts.push(text);
      continue;
    }
    // Scanned PDF: render the page and OCR it.
    scanned = true;
    const viewport = page.getViewport({ scale: 3 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport } as never).promise;
    const ocr = await ocrTwoPasses(canvas, onProgress);
    texts.push(...ocr.passes);
    confidence = ocr.confidence;
  }
  return { passes: scanned ? texts : [texts.join("\n")], method: scanned ? "pdf-ocr" : "pdf-text", confidence };
}

const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// ------------------------------------------------------------------ back page
export interface BackPage {
  payments: { date: string | null; amount: number }[];
  rateRows: { component: string; basisKwh: number | null; rate: number; amount: number | null }[];
}

/** Back page: payment history ("What you've paid") and the "How your bill was computed" rows. */
export function parseBack(rawText: string): BackPage {
  const lines = rawText.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const payments: BackPage["payments"] = [];
  const rateRows: BackPage["rateRows"] = [];
  let section: string | null = null;
  for (const line of lines) {
    if (/What\s*you.?ve\s*paid/i.test(line)) { section = "paid"; continue; }
    if (/What\s*remains\s*unpaid/i.test(line)) { section = "unpaid"; continue; }
    if (/How\s*your\s*bill\s*was\s*computed/i.test(line)) { section = "computed"; continue; }
    if (section === "paid") {
      const ds = allDates(line);
      const amt = toMoney(line);
      if (ds.length && amt != null) payments.push({ date: iso(ds[ds.length - 1]), amount: amt });
      continue;
    }
    // "Generation Charge  457 kWh  10.2015  4,661.63"
    const m = line.match(/^([A-Za-z][A-Za-z0-9 .()&/'-]{2,}?)\s+(?:(\d[\d,]*)\s*kWh\s+)?(-?\d+\.\d{2,6})\s+(-?\d[\d,]*[.\s]\d{2})$/i);
    if (m) rateRows.push({ component: m[1].trim(), basisKwh: m[2] ? Number(m[2].replace(/,/g, "")) : null, rate: Number(m[3]), amount: toMoney(m[4]) });
  }
  return { payments, rateRows };
}

export interface MultiScanResult extends ScanResult { back: BackPage | null }

async function extractAny(file: File, onProgress?: ScanProgress) {
  if (isPdf(file)) return { ...(await extractPdf(file, onProgress)), warnings: [] as string[] };
  if (!file.type.startsWith("image/")) throw new Error(`"${file.name}" is not a photo or PDF.`);
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = fileToCanvas(bitmap);
  bitmap.close();
  const warnings = qualityWarnings(canvas);
  const ocr = await ocrTwoPasses(canvas, onProgress);
  return { passes: ocr.passes, method: "image-ocr" as const, confidence: ocr.confidence, warnings };
}

/** Quality warnings for one photo (resolution + blur), shown as a badge before scanning. */
export async function photoQuality(file: File): Promise<string[]> {
  if (isPdf(file) || !file.type.startsWith("image/")) return [];
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = fileToCanvas(bitmap);
  bitmap.close();
  return qualityWarnings(canvas);
}

/**
 * Scan the FRONT (required, up to several shots) and BACK (optional) of a Meralco bill.
 * Every front shot/pass is merged into one bill; the back page with the most rows wins.
 * A 2-page PDF e-bill can be uploaded as the front: page 2 is read as the back page.
 */
export async function scanMeralcoBillPages(
  pages: { front: File[]; back: File[] },
  onProgress?: (side: string, stage: string, pct: number | null) => void,
): Promise<MultiScanResult> {
  if (!pages.front.length) throw new Error("Add a photo or PDF of the front of your bill.");
  const frontPasses: string[] = [];
  const backTexts: string[] = [];
  const warnings: string[] = [];
  let method: ScanResult["method"] = "image-ocr";
  const confidences: number[] = [];

  for (const side of ["front", "back"] as const) {
    const list = pages[side];
    for (let i = 0; i < list.length; i++) {
      const label = `${side === "front" ? "Front" : "Back"}${list.length > 1 ? ` ${i + 1}/${list.length}` : ""}`;
      const r = await extractAny(list[i], (stage, pct) => onProgress?.(label, stage, pct));
      warnings.push(...r.warnings.map((w) => `${label}: ${w}`));
      if (r.confidence != null) confidences.push(r.confidence);
      if (side === "front") {
        method = r.method;
        frontPasses.push(...r.passes);
        // A multi-page PDF e-bill also contains the back page.
        if (r.method === "pdf-text") backTexts.push(r.passes.join("\n"));
      } else {
        backTexts.push(r.passes.join("\n"));
      }
    }
  }

  const bill = parseFrontMulti(frontPasses);
  const backs = backTexts.map(parseBack);
  const score = (b: BackPage) => b.payments.length + b.rateRows.length;
  const back = backs.reduce<BackPage | null>((best, b) => (score(b) && (!best || score(b) > score(best)) ? b : best), null);
  return {
    bill,
    back,
    checks: validateBill(bill),
    text: [...frontPasses, ...backTexts].join("\n"),
    method,
    confidence: confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null,
    warnings,
  };
}

/** Scan a Meralco bill photo or PDF e-bill in the browser. */
export async function scanMeralcoBill(file: File, onProgress?: ScanProgress): Promise<ScanResult> {
  let passes: string[];
  let method: ScanResult["method"];
  let confidence: number | null;
  let warnings: string[] = [];
  if (isPdf(file)) {
    ({ passes, method, confidence } = await extractPdf(file, onProgress));
  } else if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const canvas = fileToCanvas(bitmap);
    bitmap.close();
    warnings = qualityWarnings(canvas);
    ({ passes, confidence } = await ocrTwoPasses(canvas, onProgress));
    method = "image-ocr";
  } else {
    throw new Error("Choose a photo of your bill or the PDF e-bill.");
  }
  const bill = parseFrontMulti(passes);
  return { bill, checks: validateBill(bill), text: passes.join("\n"), method, confidence, warnings };
}
