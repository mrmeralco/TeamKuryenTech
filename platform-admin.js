// SmartWatts platform administration (SmartWatts staff only).
// Visible only when the API reports the verified `platformAdmin` Firebase custom claim, and every
// action is re-checked by FastAPI. Hiding or showing this page is a convenience, never the security boundary.
import { apiGet, apiPost } from "./src/lib/apiAuth.ts";
import { confirmDialog, fill, formatPeso, formValues, lifecycleBadge, notice, slot, table, user } from "./ui-kit.js";

const ACTIONS = {
  approve: { label: "Approve", danger: false, period: "required", source: true, help: "Grant entitlement after verifying payment outside the app, or as an authorized grant." },
  reject: { label: "Reject", danger: true, reason: true, help: "The owner sees this reason and can request again." },
  suspend: { label: "Suspend", danger: true, reason: true, help: "Paid operations stop; records stay readable." },
  reactivate: { label: "Reactivate", danger: false, period: "optional", source: true, reason: true, help: "Leave the end date empty to keep a still-valid period." },
  extend: { label: "Extend period", danger: false, period: "required", source: true, reason: true, help: "Sets a later entitlement end date." },
  expire: { label: "Record expiration", danger: true, reason: true, help: "Ends the entitlement now." },
  disable: { label: "Disable", danger: true, reason: true, help: "Blocks the subscription until restored." },
  restore: { label: "Restore to draft", danger: false, reason: true, help: "The owner can request activation again." },
};
const STATUS_FILTERS = [["", "All"], ["pending_activation", "Pending activation"], ["active", "Active"], ["suspended", "Suspended"], ["expired", "Expired"], ["disabled", "Disabled"], ["inactive", "Draft"]];
let filter = "pending_activation";
let selected = null;

const when = (value) => (value ? user(new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })) : "—");
const day = (value) => (value ? user(new Date(value).toLocaleDateString("en-PH", { dateStyle: "medium" })) : "—");

function subscriptionsPage(ctx) {
  return `${ctx.pageHead("Platform · Rentals subscriptions", "Review activation requests and manage property entitlements. SmartWatts staff only.")}
    ${notice("warning", "No payment is processed in SmartWatts. Approve only after verifying a payment outside the app (record its reference) or for an explicitly authorized administrative grant.")}
    <div class="platform-filter" role="group" aria-label="Filter by status">${STATUS_FILTERS.map(([value, label]) => `<button class="btn btn-small ${value === filter ? "btn-primary" : "btn-outline"}" data-act="platform-filter" data-status="${value}">${label}</button>`).join("")}</div>
    ${slot("platform-list")}
    <div style="margin-top:14px">${slot("platform-detail", "")}</div>`;
}

async function loadSubscriptions(ctx, root) {
  const records = await apiGet(`/api/platform/subscriptions${filter ? `?status=${encodeURIComponent(filter)}` : ""}`);
  fill(root, "platform-list", ctx.panel(`Subscriptions <small>${records.length} shown</small>`, table(
    ["Property", "Owner", "Status", "Requested", "Period ends", ""],
    records.map((r) => [
      `<b translate="no">${user(r.propertyName ?? r.propertyId)}</b><div class="muted-note" translate="no">${user(r.propertyId)}</div>`,
      `${user(r.ownerEmail ?? "—")}<div class="muted-note" translate="no">${user(r.ownerUid ?? "")}</div>`,
      lifecycleBadge(r.lifecycle),
      r.status === "pending_activation" ? when(r.lastRequestedAt) : "—",
      day(r.currentPeriodEnd),
      `<button class="btn btn-outline btn-small" data-act="platform-open" data-id="${encodeURIComponent(r.propertyId)}">Review</button>`,
    ]),
    filter === "pending_activation" ? "No activation requests are waiting." : "No subscriptions match this filter.",
  )));
  if (selected) await renderDetail(ctx, root, selected);
}

function actionForm(record, action) {
  const spec = ACTIONS[action];
  return `<details class="platform-action"><summary class="btn btn-small ${spec.danger ? "btn-outline danger-link" : "btn-outline"}">${spec.label}</summary>
    <form class="form-grid" data-form="platform-action" data-id="${encodeURIComponent(record.propertyId)}" data-platform-action="${action}" data-version="${record.version}">
      <p class="muted-note full">${spec.help}</p>
      ${spec.source ? `<label class="field">Activation source<select class="select" name="activationSource" required>
          <option value="external_payment_verified">Payment verified outside the app</option>
          <option value="administrative_grant">Administrative grant</option></select></label>
        <label class="field">Payment reference (for verified payments)<input name="paymentReference" maxlength="120" placeholder="e.g. bank or GCash reference"></label>` : ""}
      ${spec.period ? `<label class="field">Entitlement end date<input type="date" name="periodEnd"${spec.period === "required" ? " required" : ""}></label>` : ""}
      <label class="field full">Reason${spec.reason ? "" : " (required for administrative grants)"}<textarea name="reason" rows="2" maxlength="500"${spec.reason ? " required minlength=\"10\"" : ""}></textarea></label>
      <div class="field full"><button class="btn ${spec.danger ? "btn-danger" : "btn-primary"}" type="submit">${spec.label}</button></div>
    </form></details>`;
}

async function renderDetail(ctx, root, pid) {
  const record = await apiGet(`/api/platform/subscriptions/${encodeURIComponent(pid)}`);
  fill(root, "platform-detail", ctx.panel(`<span translate="no">${user(record.propertyName ?? pid)}</span> ${lifecycleBadge(record.lifecycle)}`, `
    <div class="detail-list">
      <div class="detail-row"><span>Property ID</span><b translate="no">${user(record.propertyId)}</b></div>
      <div class="detail-row"><span>Owner</span><b>${user(record.ownerEmail ?? "—")} · <span translate="no">${user(record.ownerUid ?? "")}</span></b></div>
      <div class="detail-row"><span>Plan</span><b>${user(record.plan)} · ${formatPeso(record.priceCentavos)}/month (proposed) · ${user(record.unitLimit)} units</b></div>
      <div class="detail-row"><span>Activation requested</span><b>${when(record.lastRequestedAt)}</b></div>
      <div class="detail-row"><span>Last decision</span><b>${when(record.decidedAt)}${record.decidedBy ? ` · <span translate="no">${user(record.decidedBy)}</span>` : ""}</b></div>
      <div class="detail-row"><span>Activation source</span><b>${user(record.activationSource ?? "—")}${record.paymentReference ? ` · ref ${user(record.paymentReference)}` : ""}</b></div>
      <div class="detail-row"><span>Entitlement</span><b>${day(record.currentPeriodStart)} – ${day(record.currentPeriodEnd)}</b></div>
      <div class="detail-row"><span>Status reason</span><b>${user(record.statusReason ?? "—")}</b></div>
      <div class="detail-row"><span>Last updated</span><b>${when(record.updatedAt)} · version ${user(record.version)}</b></div>
    </div>
    <div class="platform-actions">${record.allowedActions.length ? record.allowedActions.map((action) => actionForm(record, action)).join("") : `<p class="muted-note">No actions are available for this status.</p>`}</div>
    <h4>Change history</h4>
    ${table(["When", "Action", "From → To", "Actor", "Details"], record.events.map((e) => [
      when(e.at), user(e.action), `${user(e.fromStatus)} → ${user(e.toStatus)}`,
      `${user(e.actorRole)} · <span translate="no">${user(e.actorUid)}</span>`,
      [e.activationSource, e.paymentReference ? `ref ${e.paymentReference}` : "", e.periodEnd ? `until ${new Date(e.periodEnd).toLocaleDateString()}` : "", e.reason]
        .filter(Boolean).map((part) => user(part)).join(" · ") || "—",
    ]), "No changes recorded yet.")}`));
  ctx.translate?.(root.querySelector ? document.querySelector("#content") : root);
}

export const platformPages = {
  "platform-subscriptions": { title: "Rentals Subscriptions", subtitle: "SmartWatts platform administration", render: subscriptionsPage, load: loadSubscriptions },
};

export const platformActions = {
  "platform-filter"(button, ctx) {
    filter = button.dataset.status ?? "";
    selected = null;
    ctx.render();
  },
  async "platform-open"(button, ctx) {
    selected = decodeURIComponent(button.dataset.id);
    await renderDetail(ctx, document.querySelector("#content"), selected);
    document.querySelector('[data-slot="platform-detail"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  },
};

export const platformForms = {
  async "platform-action"(form, ctx) {
    const action = form.dataset.platformAction;
    const spec = ACTIONS[action];
    const v = formValues(form);
    const ok = await confirmDialog({
      title: `${spec.label} this subscription?`, danger: spec.danger, confirmLabel: spec.label,
      body: "This is recorded in the subscription history and the property's audit log, and the owner is notified.",
    });
    if (!ok) return;
    const pid = decodeURIComponent(form.dataset.id);
    await apiPost(`/api/platform/subscriptions/${encodeURIComponent(pid)}/${action}`, {
      confirm: true,
      expectedVersion: Number(form.dataset.version),
      ...(spec.source ? { activationSource: v.activationSource, paymentReference: v.paymentReference || null } : {}),
      ...(spec.period && v.periodEnd ? { periodEnd: v.periodEnd } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
    });
    selected = pid;
    ctx.toast(`Subscription updated: ${spec.label.toLowerCase()}.`);
    ctx.render();
  },
};
