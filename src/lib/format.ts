const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape any user- or server-provided value before inserting it into HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

export function formatPeso(centavos: number | null | undefined): string {
  if (typeof centavos !== "number" || !Number.isFinite(centavos)) return "—";
  const sign = centavos < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(centavos));
  const pesos = Math.floor(absolute / 100).toLocaleString("en-PH");
  return `${sign}₱${pesos}.${String(absolute % 100).padStart(2, "0")}`;
}

/** Parse a peso amount typed by a person ("1,234.5", "₱ 99") into integer centavos without float errors. */
export function parsePesoToCentavos(input: string): number | null {
  const cleaned = input.replace(/[₱,\s]|PHP/gi, "");
  const match = cleaned.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function whToKwh(wh: number | null | undefined): string {
  if (typeof wh !== "number" || !Number.isFinite(wh)) return "—";
  return (wh / 1000).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

export function formatKwh(kwh: number): string {
  return kwh.toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
