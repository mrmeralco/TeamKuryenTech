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
  owner_entered: ["official", "Utility bill · owner-entered"],
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

/**
 * Accessible confirmation dialog (native <dialog>: focus is trapped and Escape cancels).
 * Resolves to null when cancelled, true when confirmed, or the typed text when `input` is set.
 */
export function confirmDialog({ title, body = "", confirmLabel = "Confirm", danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "sw-dialog";
    dialog.setAttribute("aria-labelledby", "swDialogTitle");
    dialog.innerHTML = `<form method="dialog" class="sw-dialog-body">
      <h3 id="swDialogTitle">${escapeHtml(title)}</h3>
      ${body ? `<p>${escapeHtml(body)}</p>` : ""}
      ${input ? `<label class="field">${escapeHtml(input.label)}<textarea name="value" rows="3" minlength="${input.minLength ?? 1}" maxlength="${input.maxLength ?? 500}" required></textarea></label>` : ""}
      <div class="toolbar sw-dialog-actions">
        <button type="button" class="btn btn-outline" value="cancel">Cancel</button>
        <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}" value="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </form>`;
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.querySelector('button[value="cancel"]').addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!input) return finish(true);
      const value = String(new FormData(event.target).get("value") ?? "").trim();
      if (value.length < (input.minLength ?? 1)) return;
      finish(value);
    });
    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    (dialog.querySelector("textarea") ?? dialog.querySelector('button[value="confirm"]'))?.focus();
  });
}

/** Rentals property lifecycle, always derived from the server entitlement. */
export const LIFECYCLE_LABELS = {
  draft: ["Draft", "off"],
  pending_activation: ["Pending activation", "pending"],
  active: ["Active", ""],
  suspended: ["Suspended · read-only", "danger"],
  expired: ["Expired · read-only", "danger"],
  disabled: ["Disabled · read-only", "danger"],
  archived: ["Archived", "off"],
};
export function lifecycleBadge(lifecycle) {
  const [label, tone] = LIFECYCLE_LABELS[lifecycle] ?? LIFECYCLE_LABELS.draft;
  return `<span class="status lifecycle ${tone}">${label}</span>`;
}
