// Small HTML helpers shared by the Personal and Rentals screens.
// Every user- or server-provided value MUST go through esc() or user().
import { escapeHtml, formatPeso, whToKwh } from "./src/lib/format.ts";

export { formatPeso, whToKwh };
export const esc = escapeHtml;

/** User data: escaped and excluded from machine translation (privacy). */
export function user(value) {
  return `<span translate="no">${escapeHtml(value)}</span>`;
}

export function fill(root, slot, html) {
  const target = root.querySelector(`[data-slot="${slot}"]`);
  if (target) target.innerHTML = html;
}

export function slot(name, loading = "Loading…") {
  return `<div data-slot="${name}"><p class="muted-note">${loading}</p></div>`;
}

export function table(headers, rows, empty = "Nothing here yet.") {
  if (!rows.length) return `<p class="muted-note">${empty}</p>`;
  return `<div class="table-scroll"><table class="table">
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

export function field(label, input, { full = false, hint = "" } = {}) {
  return `<div class="field${full ? " full" : ""}"><label>${label}${input}</label>${hint ? `<small class="field-hint">${hint}</small>` : ""}</div>`;
}

export function notice(kind, html) {
  return `<div class="notice notice-${kind}" role="${kind === "danger" ? "alert" : "note"}">${html}</div>`;
}

const DATA_KINDS = {
  official_utility_bill: ["official", "Official utility bill"],
  verified_meter_consumption: ["measured", "Measured · utility meter"],
  private_submeter_consumption: ["measured", "Measured · private submeter"],
  not_individually_measured: ["allocation", "Not individually measured"],
  allocation_based_charge: ["allocation", "Allocation (agreed share)"],
  estimate: ["estimate", "Estimate"],
  sample: ["sample", "Sample data"],
};

export function kindBadge(kind) {
  const [tone, label] = DATA_KINDS[kind] ?? ["sample", kind];
  return `<span class="kind-badge kind-${tone}">${label}</span>`;
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export const LEGAL_NOTICE =
  "Tenant billing workflows require legal and regulatory review before production use. SmartWatts does not collect payments, disconnect service, or certify compliance.";

export const todayIso = () => new Date().toISOString().slice(0, 10);
