// SmartWatts Rentals (Tier 2) screens for property owners/administrators and tenants.
// All data comes from the FastAPI backend, which enforces membership, role,
// and subscription checks. Nothing here can reach tenants' private data.
import QRCode from "qrcode";
import { apiGet, apiPost, apiPutFile } from "./src/lib/apiAuth.ts";
import { parsePesoToCentavos } from "./src/lib/format.ts";
import { extractBillFields, extractMeterReading, recognizeImage } from "./src/lib/ocr.ts";
import {
  errorMessage, field, fill, formatPeso, formValues, kindBadge, notice, slot, table, todayIso, user, whToKwh, LEGAL_NOTICE,
} from "./ui-kit.js";
import { getWorkspace, loadWorkspaces, setWorkspace } from "./workspace.js";
import { calendarSection } from "./calendar-view.js";

const METER_KINDS = {
  utility_individual: "Individual utility meter (Scenario A)",
  private_submeter: "Private submeter (Scenario B)",
  utility_shared: "Shared utility meter (Scenario C)",
};
const STATUS_LABELS = { draft: "Draft", finalized: "Finalized", superseded: "Superseded", void: "Void" };

const pid = () => encodeURIComponent(getWorkspace().propertyId ?? "");
const base = () => `/api/rentals/properties/${pid()}`;
const legal = () => notice("warning", LEGAL_NOTICE);

function entitlementBanner(property) {
  const e = property.entitlement;
  if (!e || e.active) return "";
  const label = e.status === "expired" ? "has expired" : "is not active";
  return notice("danger", `This property's SmartWatts Rentals subscription ${label}. Existing records stay readable, but changes are paused.
    <button class="text-link" data-page="rental-subscription">View subscription</button>`);
}

async function propertyHeader(root) {
  const property = await apiGet(base());
  fill(root, "entitlement", entitlementBanner(property));
  return property;
}

const options = (items, label, selected = "") =>
  items.map((item) => `<option value="${encodeURIComponent(item.id)}"${item.id === selected ? " selected" : ""}>${user(label(item))}</option>`).join("");

const idFrom = (value) => decodeURIComponent(String(value ?? ""));

function statementLines(statement) {
  return table(
    ["Charge", "Basis", "Consumption", "Amount"],
    statement.lines.map((line) => [
      `${user(line.description)}${line.reviewReason ? `<div class="muted-note">${user(line.reviewReason)}</div>` : ""}`,
      `${kindBadge(line.chargeBasis)} ${kindBadge(line.consumptionKind)}`,
      line.wh === null ? "Not individually measured" : `${whToKwh(line.wh)} kWh`,
      `<b>${formatPeso(line.amountCentavos)}</b>`,
    ]),
  );
}

function calculationDetails(statement) {
  return `<details class="calc-details"><summary>How this was calculated</summary>
    ${statement.lines.map((line) => `<pre translate="no">${user(JSON.stringify(line.calculation, null, 2))}</pre>`).join("")}
  </details>`;
}

// ------------------------------------------------------------ overview
function overviewPage(ctx) {
  return `${ctx.pageHead("Property overview", "Units, meters, bills, and statements at a glance.")}
    ${slot("entitlement", "")}${legal()}${slot("overview")}`;
}

async function loadOverview(ctx, root) {
  const [property, analytics] = await Promise.all([propertyHeader(root), apiGet(`${base()}/analytics`)]);
  const e = property.entitlement;
  fill(root, "overview", `
    <div class="grid stats">
      ${ctx.stat("layout-dashboard", "Units", analytics.unitCount, "", `${analytics.occupiedUnitCount} occupied`, "")}
      ${ctx.stat("gauge", "Meters", analytics.meterCount, "", "Registered", "")}
      ${ctx.stat("receipt", "Utility bills", analytics.bills.length, "", "Recent official bills", "")}
      ${ctx.stat("badge-dollar-sign", "Subscription", e.active ? "Active" : e.status, "", `${formatPeso(e.priceCentavos)} / month · up to ${e.unitLimit} units`, "")}
    </div>
    <div class="two-panels">
      ${ctx.panel(`Property <small translate="no">${ctx.escape(property.name)}</small>`, `<div class="detail-list">
        <div class="detail-row"><span>Address</span><b>${user(property.address)}</b></div>
        <div class="detail-row"><span>Your role</span><b>${property.role === "owner" ? "Owner" : "Administrator"}</b></div>
      </div>`)}
      ${ctx.panel("Recent official bills", table(
        ["Period", "kWh", "Amount"],
        analytics.bills.map((b) => [`${user(b.periodStart)} – ${user(b.periodEnd)}`, `${whToKwh(b.totalWh)} ${kindBadge("official_utility_bill")}`, formatPeso(b.amountCentavos)]),
        "No bills recorded yet.",
      ))}
    </div>
    <div style="margin-top:14px">${ctx.panel("Property billing calendar", calendarSection(ctx, `owner-${pid()}`, analytics.bills.map((b) => ({
      periodStart: b.periodStart, periodEnd: b.periodEnd, kwh: b.totalWh / 1000, amountCentavos: b.amountCentavos, kind: "recorded",
    }))))}</div>
    <div style="margin-top:14px">${ctx.panel("Finalized statements by unit", table(
      ["Unit", "Measured consumption", "Total billed"],
      analytics.finalizedByUnit.map((u) => [user(u.unitLabel), `${whToKwh(u.measuredWh)} kWh`, formatPeso(u.billedCentavos)]),
      "No finalized statements yet.",
    ))}</div>`);
}

// ------------------------------------------------------- units & tenants
function unitsPage(ctx) {
  return `${ctx.pageHead("Units & tenants", "Register units, invite tenants with a secure link or QR code, and record move-outs.")}
    ${slot("entitlement", "")}
    <div class="two-panels">
      ${ctx.panel("Add a unit", `<form class="form-grid" data-form="unit-create">
        ${field("Unit label", `<input name="label" required maxlength="60" placeholder="e.g. Unit 2B">`)}
        ${field("Notes (optional)", `<input name="notes" maxlength="500">`)}
        <div class="field full"><button class="btn btn-primary" type="submit">Add unit</button></div>
      </form>`)}
      ${ctx.panel("Invite someone", slot("invite-form"))}
    </div>
    <div data-slot="invite-result"></div>
    <div style="margin-top:14px">${ctx.panel("Units", slot("units"))}</div>
    <div style="margin-top:14px">${ctx.panel("Pending invitations", slot("invitations"))}</div>
    <div style="margin-top:14px">${ctx.panel("Members & occupancy history", slot("members"))}</div>`;
}

async function loadUnits(ctx, root) {
  const [property, units, invitations, members] = await Promise.all([
    propertyHeader(root), apiGet(`${base()}/units`), apiGet(`${base()}/invitations`), apiGet(`${base()}/members`),
  ]);
  const unitLabel = Object.fromEntries(units.map((u) => [u.id, u.label]));
  fill(root, "invite-form", `<form class="form-grid" data-form="invite-create">
    ${field("Role", `<select class="select" name="role">
      <option value="tenant">Tenant</option>
      ${property.role === "owner" ? `<option value="admin">Property administrator</option>` : ""}
    </select>`)}
    ${field("Unit (tenants)", `<select class="select" name="unitId"><option value="">—</option>${options(units.filter((u) => u.status === "active"), (u) => u.label)}</select>`)}
    ${field("Move-in date", `<input type="date" name="moveInDate" value="${todayIso()}">`)}
    ${field("Restrict to email (optional)", `<input type="email" name="email">`, { hint: "If set, the invitee must sign in with this verified email." })}
    <div class="field full"><button class="btn btn-primary" type="submit">Create invitation</button></div>
  </form>`);
  fill(root, "units", table(
    ["Unit", "Current tenant", "Since", "Status"],
    units.map((u) => [
      user(u.label),
      u.currentOccupancy ? user(u.currentOccupancy.tenantEmail ?? "Tenant") : "Vacant",
      u.currentOccupancy ? user(u.currentOccupancy.startDate) : "—",
      user(u.status),
    ]),
    "No units yet.",
  ));
  fill(root, "invitations", table(
    ["Role", "Unit", "Email", "Status", "Expires", ""],
    invitations.map((i) => [
      i.role === "tenant" ? "Tenant" : "Administrator",
      user(unitLabel[i.unitId] ?? "—"),
      user(i.email ?? "Anyone with the link"),
      user(i.status),
      user(new Date(i.expiresAt).toLocaleString()),
      i.status === "pending" ? `<button class="btn btn-outline btn-small" data-act="invite-revoke" data-id="${encodeURIComponent(i.id)}">Revoke</button>` : "",
    ]),
    "No invitations yet.",
  ));
  const activeMembers = members.members.filter((m) => m.status === "active" && m.role !== "owner");
  fill(root, "members", `
    ${table(["Member", "Role", "Unit", ""], activeMembers.map((m) => [
      user(m.email ?? m.uid), m.role === "tenant" ? "Tenant" : "Administrator", user(unitLabel[m.unitId] ?? "—"),
      `<button class="btn btn-outline btn-small" data-act="member-revoke" data-id="${encodeURIComponent(m.uid)}">Remove access</button>`,
    ]), "No tenants or administrators yet.")}
    <h4>Occupancy history</h4>
    ${table(["Unit", "Tenant", "Move-in", "Move-out", ""], members.occupancies.map((o) => [
      user(unitLabel[o.unitId] ?? o.unitId), user(o.tenantEmail ?? o.tenantUid), user(o.startDate), o.endDate ? user(o.endDate) : "Current",
      o.endDate ? "" : `<form class="inline-form" data-form="occupancy-end" data-id="${encodeURIComponent(o.id)}">
        <input type="date" name="endDate" required aria-label="Move-out date" value="${todayIso()}"><button class="btn btn-outline btn-small">Record move-out</button></form>`,
    ]), "No occupancy records yet.")}`);
}

// --------------------------------------------------------------- meters
function metersPage(ctx) {
  return `${ctx.pageHead("Meters & allocation", "Register meters, assign them to units with effective dates, and record written allocation agreements.")}
    ${slot("entitlement", "")}
    ${notice("info", `<b>Scenario A</b> — an individual utility meter's official bill belongs to one unit.
      <b>Scenario B</b> — private submeters under a shared meter measure each unit's kWh.
      <b>Scenario C</b> — a shared meter without submeters: SmartWatts never splits it automatically.
      Shared consumption is charged only through an explicit, lawful allocation agreement, and is labelled as an allocation, not a measurement.`)}
    ${slot("meters")}`;
}

async function loadMeters(ctx, root) {
  const [, data, units] = await Promise.all([propertyHeader(root), apiGet(`${base()}/meters`), apiGet(`${base()}/units`)]);
  const meterLabel = Object.fromEntries(data.meters.map((m) => [m.id, m.label]));
  const unitLabel = Object.fromEntries(units.map((u) => [u.id, u.label]));
  const shared = data.meters.filter((m) => m.kind === "utility_shared");
  const assignable = data.meters.filter((m) => m.kind !== "utility_shared");
  fill(root, "meters", `
    <div class="two-panels">
      ${ctx.panel("Register a meter", `<form class="form-grid" data-form="meter-create">
        ${field("Label", `<input name="label" required maxlength="60">`)}
        ${field("Type", `<select class="select" name="kind">${Object.entries(METER_KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>`)}
        ${field("Parent shared meter (submeters only)", `<select class="select" name="parentMeterId"><option value="">—</option>${options(shared, (m) => m.label)}</select>`)}
        ${field("Serial number (optional)", `<input name="serialNumber" maxlength="60">`)}
        ${field("Utility account no. (optional)", `<input name="utilityAccountNumber" maxlength="60">`)}
        <div class="field full"><button class="btn btn-primary" type="submit">Register meter</button></div>
      </form>`)}
      ${ctx.panel("Assign a meter to a unit", `<form class="form-grid" data-form="assignment-create">
        ${field("Meter", `<select class="select" name="meterId" required>${options(assignable, (m) => m.label)}</select>`)}
        ${field("Unit", `<select class="select" name="unitId" required>${options(units, (u) => u.label)}</select>`)}
        ${field("Effective from", `<input type="date" name="effectiveFrom" required>`)}
        ${field("Effective to (optional)", `<input type="date" name="effectiveTo">`)}
        <div class="field full"><button class="btn btn-primary" type="submit">Assign</button></div>
      </form>`)}
    </div>
    <div style="margin-top:14px">${ctx.panel("Meters", table(["Meter", "Type", "Parent", "Serial / account"], data.meters.map((m) => [
      user(m.label), METER_KINDS[m.kind], user(meterLabel[m.parentMeterId] ?? "—"), user([m.serialNumber, m.utilityAccountNumber].filter(Boolean).join(" · ") || "—"),
    ]), "No meters yet."))}</div>
    <div style="margin-top:14px">${ctx.panel("Meter-to-unit assignments", table(["Meter", "Unit", "From", "To", ""], data.assignments.map((a) => [
      user(meterLabel[a.meterId]), user(unitLabel[a.unitId]), user(a.effectiveFrom), a.effectiveTo ? user(a.effectiveTo) : "Ongoing",
      a.effectiveTo ? "" : `<form class="inline-form" data-form="assignment-end" data-id="${encodeURIComponent(a.id)}"><input type="date" name="effectiveTo" required aria-label="End date"><button class="btn btn-outline btn-small">End</button></form>`,
    ]), "No assignments yet."))}</div>
    <div style="margin-top:14px">${ctx.panel("Allocation agreements (shared meters)", `
      ${table(["Meter", "Agreement", "Shares", "Effective"], data.agreements.map((a) => [
        user(meterLabel[a.meterId]), user(a.description),
        a.shares.map((s) => `${user(unitLabel[s.unitId])}: ${user(s.weight)}`).join("<br>"),
        `${user(a.effectiveFrom)} – ${a.effectiveTo ? user(a.effectiveTo) : "ongoing"}`,
      ]), "No allocation agreements. Shared consumption stays with the owner and is not charged to tenants.")}
      ${shared.length && units.length ? `<form class="form-grid" data-form="agreement-create" style="margin-top:12px">
        ${field("Shared meter", `<select class="select" name="meterId" required>${options(shared, (m) => m.label)}</select>`)}
        ${field("Effective from", `<input type="date" name="effectiveFrom" required>`)}
        ${field("Describe the written agreement (lease clause, method)", `<textarea name="description" required minlength="20" maxlength="600" rows="2"></textarea>`, { full: true })}
        <div class="field full"><p class="muted-note">Enter each unit's share weight explicitly. Leave blank to exclude a unit. There is no default split.</p>
          <div class="share-grid">${units.map((u) => `<label>${user(u.label)}<input type="number" min="1" max="10000" step="1" name="share:${encodeURIComponent(u.id)}"></label>`).join("")}</div></div>
        <label class="field full check"><input type="checkbox" name="acknowledgeLegalReview" required> I confirm this allocation is lawful, written in the lease, agreed with the tenants, and will be shown to them as an allocation — not measured consumption.</label>
        <div class="field full"><button class="btn btn-primary" type="submit">Save agreement</button></div>
      </form>` : ""}`)}</div>`);
}

// ------------------------------------------------------------- readings
function readingsPage(ctx) {
  return `${ctx.pageHead("Meter readings", "Record verified readings manually or from a meter photo, and keep a full correction history.")}
    ${slot("entitlement", "")}${slot("readings")}`;
}

async function loadReadings(ctx, root) {
  const [, data, readings] = await Promise.all([propertyHeader(root), apiGet(`${base()}/meters`), apiGet(`${base()}/readings`)]);
  const meterLabel = Object.fromEntries(data.meters.map((m) => [m.id, m.label]));
  fill(root, "readings", `
    ${ctx.panel("Record a reading", `
      <label class="upload-drop"><input type="file" accept="image/*" class="sr-only" data-ocr="meter-photo"><span>Suggest value from a meter photo (OCR in your browser)</span></label>
      <p class="muted-note" data-slot="ocr-status"></p>
      <form class="form-grid" data-form="reading-create">
        <input type="hidden" name="source" value="manual"><input type="hidden" name="ocrSuggestedKwh" value="">
        ${field("Meter", `<select class="select" name="meterId" required>${options(data.meters, (m) => `${m.label} (${METER_KINDS[m.kind]})`)}</select>`)}
        ${field("Reading date", `<input type="date" name="readingDate" required max="${todayIso()}" value="${todayIso()}">`)}
        ${field("Register value (kWh)", `<input name="valueKwh" inputmode="decimal" required>`)}
        <label class="field full check"><input type="checkbox" name="confirmed" required> I checked this value against the physical meter.</label>
        <div class="field full"><button class="btn btn-primary" type="submit">Save verified reading</button></div>
      </form>`)}
    <div style="margin-top:14px">${ctx.panel("Reading history", table(
      ["Meter", "Date", "Value (kWh)", "Source", "Status", ""],
      readings.map((r) => [
        user(meterLabel[r.meterId]), user(r.readingDate), `${whToKwh(r.valueWh)}`,
        `${r.source === "photo_ocr" ? "Photo (OCR) · confirmed" : "Manual"}${r.correctionReason ? `<div class="muted-note">Correction: ${user(r.correctionReason)}</div>` : ""}`,
        r.status === "active" ? "Current" : "Superseded",
        r.status === "active" ? `<details><summary class="text-link">Correct</summary><form class="inline-form" data-form="reading-correct" data-id="${encodeURIComponent(r.id)}">
          <input name="valueKwh" inputmode="decimal" required aria-label="Corrected value (kWh)" placeholder="kWh">
          <input type="date" name="readingDate" value="${r.readingDate}" aria-label="Reading date">
          <input name="reason" required minlength="5" maxlength="300" aria-label="Reason" placeholder="Reason">
          <button class="btn btn-outline btn-small">Save correction</button></form></details>` : "",
      ]),
      "No readings yet.",
    ))}</div>`);
}

// ---------------------------------------------------------- utility bills
function billsPage(ctx) {
  return `${ctx.pageHead("Official utility bills", "Upload official bills, map them to meters, and generate tenant statements.")}
    ${slot("entitlement", "")}${legal()}${slot("rental-bills")}
    <div data-slot="reconciliation"></div>`;
}

async function loadBills(ctx, root) {
  const [, data, bills] = await Promise.all([propertyHeader(root), apiGet(`${base()}/meters`), apiGet(`${base()}/utility-bills`)]);
  const meterLabel = Object.fromEntries(data.meters.map((m) => [m.id, m.label]));
  const utilityMeters = data.meters.filter((m) => m.kind !== "private_submeter");
  fill(root, "rental-bills", `
    ${ctx.panel("Add an official bill", `
      <label class="upload-drop"><input type="file" accept="image/*" class="sr-only" data-ocr="rental-bill"><span>Suggest figures from a bill photo (OCR in your browser)</span></label>
      <p class="muted-note" data-slot="ocr-status"></p>
      <form class="form-grid" data-form="rental-bill-create">
        <input type="hidden" name="source" value="manual">
        ${field("Utility meter", `<select class="select" name="meterId" required>${options(utilityMeters, (m) => `${m.label} (${METER_KINDS[m.kind]})`)}</select>`)}
        ${field("Bill number (optional)", `<input name="billNumber" maxlength="60">`)}
        ${field("Period start", `<input type="date" name="periodStart" required>`)}
        ${field("Period end", `<input type="date" name="periodEnd" required max="${todayIso()}">`)}
        ${field("Total kWh", `<input name="totalKwh" inputmode="decimal" required>`)}
        ${field("Total amount (₱)", `<input name="amount" inputmode="decimal" required>`)}
        ${field("Bill document (PDF/JPEG/PNG, optional)", `<input type="file" name="document" accept="application/pdf,image/png,image/jpeg">`, { full: true })}
        <div class="field full"><button class="btn btn-primary" type="submit">Save official bill</button></div>
      </form>`)}
    <div style="margin-top:14px">${ctx.panel("Bills", table(
      ["Meter", "Period", "kWh", "Amount", "Document", ""],
      bills.map((b) => [
        user(meterLabel[b.meterId]), `${user(b.periodStart)} – ${user(b.periodEnd)}`,
        `${whToKwh(b.totalWh)} ${kindBadge("official_utility_bill")}`, formatPeso(b.amountCentavos),
        b.documentPath ? `<button class="text-link" data-act="bill-document" data-id="${encodeURIComponent(b.id)}">View</button>` : "—",
        `<div class="toolbar"><button class="btn btn-primary btn-small" data-act="statements-generate" data-id="${encodeURIComponent(b.id)}">Generate statements</button>
         <button class="btn btn-outline btn-small" data-act="reconciliation-show" data-id="${encodeURIComponent(b.id)}">Reconciliation</button></div>`,
      ]),
      "No official bills yet.",
    ))}</div>`);
}

function reconciliationHtml(ctx, run) {
  const r = run.reconciliation;
  return ctx.panel(`Reconciliation · version ${run.version}`, `
    <div class="detail-list">
      <div class="detail-row"><span>Official bill</span><b>${formatPeso(r.billAmountCentavos)} (${whToKwh(r.billTotalWh)} kWh)</b></div>
      <div class="detail-row"><span>Charged to tenants (draft/final)</span><b>${formatPeso(r.tenantChargesCentavos)}</b></div>
      <div class="detail-row"><span>Needs owner review</span><b>${formatPeso(r.pendingReviewCentavos)}</b></div>
      <div class="detail-row"><span>Owner-borne (vacant, common, unallocated, rounding)</span><b>${formatPeso(r.ownerBorneCentavos)}</b></div>
      <div class="detail-row"><span>Balanced</span><b>${r.balanced ? "Yes — every centavo is accounted for" : "No"}</b></div>
    </div>
    ${table(["Owner-borne item", "kWh", "Amount"], run.ownerBorne.map((o) => [user(o.reason), o.wh === null ? "—" : whToKwh(o.wh), formatPeso(o.amountCentavos)]), "No owner-borne amounts.")}
    <button class="btn btn-outline" data-page="rental-statements">Review statements</button>`);
}

// ------------------------------------------------------------ statements
function statementsPage(ctx) {
  return `${ctx.pageHead("Tenant statements", "Review drafts, then finalize. Finalized statements are immutable; corrections create a new version.")}
    ${slot("entitlement", "")}${legal()}${slot("statements")}`;
}

async function loadStatements(ctx, root) {
  const [, statements, units, members] = await Promise.all([
    propertyHeader(root), apiGet(`${base()}/statements`), apiGet(`${base()}/units`), apiGet(`${base()}/members`),
  ]);
  const unitLabel = Object.fromEntries(units.map((u) => [u.id, u.label]));
  const tenantEmail = Object.fromEntries(members.members.map((m) => [m.uid, m.email]));
  fill(root, "statements", statements.length ? statements.map((s) => ctx.panel(
    `<span translate="no">${ctx.escape(unitLabel[s.unitId] ?? s.unitId)}</span> · ${ctx.escape(s.periodStart)} – ${ctx.escape(s.periodEnd)} <small>v${s.version} · ${STATUS_LABELS[s.status]}</small>`,
    `${s.needsReview ? notice("danger", `Needs review: ${ctx.escape(s.reviewReason ?? "")}`) : ""}
     <p class="stat-foot">Tenant: ${user(s.tenantUid ? tenantEmail[s.tenantUid] ?? s.tenantUid : "Not assigned")}</p>
     ${statementLines(s)}
     <div class="bill-amount">${formatPeso(s.totalCentavos)}</div>
     ${calculationDetails(s)}
     ${s.voidReason ? `<p class="muted-note">Voided: ${user(s.voidReason)}</p>` : ""}
     <div class="toolbar">
       ${s.status === "draft" && !s.needsReview ? `<button class="btn btn-primary btn-small" data-act="statement-finalize" data-id="${encodeURIComponent(s.id)}">Finalize</button>` : ""}
       ${s.status === "draft" || s.status === "finalized" ? `<button class="btn btn-outline btn-small" data-act="statement-void" data-id="${encodeURIComponent(s.id)}">Void</button>` : ""}
     </div>`,
  )).join("") : `<p class="muted-note">No statements yet. Generate them from an official bill.</p>`);
}

// --------------------------------------------------------- subscription
function subscriptionPage(ctx) {
  return `${ctx.pageHead("Subscription", "SmartWatts Rentals is billed per property. Tenants are never charged by SmartWatts.")}${slot("subscription")}`;
}

async function loadSubscription(ctx, root) {
  const sub = await apiGet(`${base()}/subscription`);
  const owner = getWorkspace().role === "owner";
  fill(root, "subscription", ctx.panel("SmartWatts Rentals", `
    <div class="detail-list">
      <div class="detail-row"><span>Status</span><b>${user(sub.status)}${sub.active ? "" : " — changes paused"}</b></div>
      <div class="detail-row"><span>Price</span><b>${formatPeso(sub.priceCentavos)} per property per month (proposed)</b></div>
      <div class="detail-row"><span>Unit limit</span><b>${user(sub.unitLimit)} units</b></div>
      <div class="detail-row"><span>Current period ends</span><b>${sub.currentPeriodEnd ? user(new Date(sub.currentPeriodEnd).toLocaleDateString()) : "—"}</b></div>
      <div class="detail-row"><span>Activation requested</span><b>${sub.activationRequestedAt ? user(new Date(sub.activationRequestedAt).toLocaleString()) : "No"}</b></div>
    </div>
    ${notice("info", "Online payment is not enabled. SmartWatts staff activate subscriptions manually after an approved payment process. No card or e-wallet details are collected here.")}
    ${owner && !sub.active ? `<button class="btn btn-primary" data-act="subscription-request">Request activation</button>` : ""}`));
}

// ---------------------------------------------------------------- audit
function auditPage(ctx) {
  return `${ctx.pageHead("Audit log", "Every privileged change on this property, newest first.")}${slot("audit")}`;
}

async function loadAudit(_ctx, root) {
  const logs = await apiGet(`${base()}/audit-logs`);
  fill(root, "audit", table(["When", "Action", "Target", "By"], logs.map((log) => [
    user(new Date(log.at).toLocaleString()), user(log.action), user(`${log.targetType} ${log.targetId}`), user(log.actorUid),
  ]), "No activity yet."));
}

// ---------------------------------------------------------------- tenant
function tenantStatementsPage(ctx) {
  return `${ctx.pageHead("My electricity statements", "Official statements your landlord has finalized for your unit.")}
    ${legal()}${slot("tenant-unit")}${slot("tenant-statements")}`;
}

async function loadTenantStatements(ctx, root) {
  const [unit, statements] = await Promise.all([apiGet(`${base()}/me/unit`), apiGet(`${base()}/me/statements`)]);
  fill(root, "tenant-unit", ctx.panel(`<span translate="no">${ctx.escape(unit.propertyName)}</span> · <span translate="no">${ctx.escape(unit.unitLabel)}</span>`, `
    ${table(["Meter", "Type", "Assigned"], unit.meters.map((m) => [user(m.label), METER_KINDS[m.kind], `${user(m.effectiveFrom)} – ${m.effectiveTo ? user(m.effectiveTo) : "ongoing"}`]), "No meter is assigned to your unit.")}
    <p class="stat-foot">You do not pay SmartWatts. Your appliances, schedules, savings plans, and AI chats are private — your landlord cannot see them.</p>`));
  const finalized = statements.filter((s) => s.status === "finalized");
  const calendarRecords = finalized.map((s) => {
    const measured = s.lines.filter((line) => line.consumptionKind !== "not_individually_measured" && line.wh !== null);
    return {
      periodStart: s.periodStart, periodEnd: s.periodEnd, amountCentavos: s.totalCentavos, kind: "recorded",
      // Allocation-only statements have no measured kWh for this unit; never invent one.
      kwh: measured.length ? measured.reduce((sum, line) => sum + line.wh, 0) / 1000 : null,
    };
  });
  const calendarHtml = finalized.length
    ? ctx.panel("My statement calendar", calendarSection(ctx, `tenant-${pid()}`, calendarRecords, { recordedKind: "official_utility_bill" }))
    : "";
  fill(root, "tenant-statements", calendarHtml + (statements.length ? statements.map((s) => ctx.panel(
    `${ctx.escape(s.periodStart)} – ${ctx.escape(s.periodEnd)} <small>${STATUS_LABELS[s.status]}${s.version > 1 ? ` · version ${s.version}` : ""}</small>`,
    `${s.status !== "finalized" ? notice("warning", s.status === "void" ? "This statement was voided by your landlord." : "This statement was replaced by a corrected version.") : ""}
     ${statementLines(s)}
     <div class="bill-amount">${formatPeso(s.totalCentavos)}</div>
     <p class="stat-foot">Parent official bill: ${user(s.utilityBill.periodStart)} – ${user(s.utilityBill.periodEnd)},
       ${whToKwh(s.utilityBill.totalWh)} kWh, ${formatPeso(s.utilityBill.amountCentavos)}${s.utilityBill.billNumber ? `, bill no. ${user(s.utilityBill.billNumber)}` : ""}.</p>
     ${calculationDetails(s)}
     <p class="muted-note">${ctx.escape(s.legalReviewNotice)}</p>`,
  )).join("") : `<p class="muted-note">No finalized statements yet.</p>`));
}

function tenantMetersPage(ctx) {
  return `${ctx.pageHead("My meter history", "Verified readings from meters that measure your unit only.")}${slot("tenant-meters")}`;
}

async function loadTenantMeters(_ctx, root) {
  const history = await apiGet(`${base()}/me/meter-history`);
  fill(root, "tenant-meters", `${notice("info", `${kindBadge("verified_meter_consumption")} Readings recorded and confirmed by your landlord. Shared-meter readings are not shown because they are not your individual consumption.`)}
    ${table(["Meter", "Date", "Register (kWh)", "Note"], history.map((r) => [
      user(r.meterLabel), user(r.readingDate), whToKwh(r.valueWh), r.corrected ? "Corrected reading" : "",
    ]), "No individual meter readings are available for your unit.")}`);
}

// ------------------------------------------------------------ registries
export const rentalPages = {
  "rental-overview": { title: "Property Overview", subtitle: "SmartWatts Rentals", render: overviewPage, load: loadOverview },
  "rental-units": { title: "Units & Tenants", subtitle: "SmartWatts Rentals", render: unitsPage, load: loadUnits },
  "rental-meters": { title: "Meters & Allocation", subtitle: "SmartWatts Rentals", render: metersPage, load: loadMeters },
  "rental-readings": { title: "Meter Readings", subtitle: "SmartWatts Rentals", render: readingsPage, load: loadReadings },
  "rental-bills": { title: "Utility Bills", subtitle: "SmartWatts Rentals", render: billsPage, load: loadBills },
  "rental-statements": { title: "Tenant Statements", subtitle: "SmartWatts Rentals", render: statementsPage, load: loadStatements },
  "rental-subscription": { title: "Subscription", subtitle: "SmartWatts Rentals", render: subscriptionPage, load: loadSubscription },
  "rental-audit": { title: "Audit Log", subtitle: "SmartWatts Rentals", render: auditPage, load: loadAudit },
  "tenant-statements": { title: "My Statements", subtitle: "SmartWatts Rentals · Tenant", render: tenantStatementsPage, load: loadTenantStatements },
  "tenant-meters": { title: "My Meter History", subtitle: "SmartWatts Rentals · Tenant", render: tenantMetersPage, load: loadTenantMeters },
};

export const rentalForms = {
  async "unit-create"(form, ctx) {
    await apiPost(`${base()}/units`, formValues(form));
    ctx.toast("Unit added.");
    ctx.render();
  },
  async "invite-create"(form, ctx) {
    const v = formValues(form);
    if (v.role === "tenant" && !v.unitId) throw new Error("Choose the unit for this tenant.");
    const invite = await apiPost(`${base()}/invitations`, {
      role: v.role, unitId: v.role === "tenant" ? idFrom(v.unitId) : undefined, moveInDate: v.moveInDate || undefined, email: v.email || undefined,
    });
    const link = `${window.location.origin}${window.location.pathname}#join=${invite.token}`;
    const svg = await QRCode.toString(link, { type: "svg", margin: 1, width: 200 });
    const root = document.querySelector("#content");
    fill(root, "invite-result", ctx.panel("Invitation ready", `
      <div class="invite-result">
        <div class="qr" aria-label="Invitation QR code">${svg}</div>
        <div>
          <p class="stat-foot">Share this link or QR code privately. It works once and expires ${ctx.escape(new Date(invite.expiresAt).toLocaleString())}. It will not be shown again.</p>
          <input class="invite-link" readonly translate="no" value="${ctx.escape(link)}" aria-label="Invitation link">
          <div class="toolbar">
            <button class="btn btn-outline btn-small" data-act="copy-invite">Copy link</button>
            ${"NDEFReader" in window
              ? `<button class="btn btn-outline btn-small" data-act="write-nfc">Write to NFC tag</button>`
              : `<small class="muted-note">NFC writing needs Chrome on Android. Use the QR code or link instead.</small>`}
          </div>
          <p class="muted-note">The QR code and NFC tag contain only this one-time link — no names, units, or billing data.</p>
        </div>
      </div>`));
    ctx.translate(root);
    ctx.toast("Invitation created.");
  },
  async "occupancy-end"(form, ctx) {
    await apiPost(`${base()}/occupancies/${form.dataset.id}/end`, formValues(form));
    ctx.toast("Move-out recorded.");
    ctx.render();
  },
  async "meter-create"(form, ctx) {
    const v = formValues(form);
    await apiPost(`${base()}/meters`, { ...v, parentMeterId: v.parentMeterId ? idFrom(v.parentMeterId) : null });
    ctx.toast("Meter registered.");
    ctx.render();
  },
  async "assignment-create"(form, ctx) {
    const v = formValues(form);
    await apiPost(`${base()}/meter-assignments`, {
      meterId: idFrom(v.meterId), unitId: idFrom(v.unitId), effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo || null,
    });
    ctx.toast("Meter assigned.");
    ctx.render();
  },
  async "assignment-end"(form, ctx) {
    await apiPost(`${base()}/meter-assignments/${form.dataset.id}/end`, formValues(form));
    ctx.toast("Assignment ended.");
    ctx.render();
  },
  async "agreement-create"(form, ctx) {
    const data = new FormData(form);
    const shares = [...data.entries()]
      .filter(([key, value]) => key.startsWith("share:") && String(value).trim())
      .map(([key, value]) => ({ unitId: decodeURIComponent(key.slice(6)), weight: Number(value) }));
    await apiPost(`${base()}/allocation-agreements`, {
      meterId: idFrom(data.get("meterId")), description: data.get("description"), effectiveFrom: data.get("effectiveFrom"),
      shares, acknowledgeLegalReview: data.get("acknowledgeLegalReview") === "on",
    });
    ctx.toast("Allocation agreement saved.");
    ctx.render();
  },
  async "reading-create"(form, ctx) {
    const v = formValues(form);
    await apiPost(`${base()}/readings`, {
      meterId: idFrom(v.meterId), readingDate: v.readingDate, valueKwh: String(v.valueKwh).replace(/,/g, ""),
      source: v.source, ocrSuggestedKwh: v.ocrSuggestedKwh || null, confirmed: v.confirmed === "on",
    });
    ctx.toast("Reading saved.");
    ctx.render();
  },
  async "reading-correct"(form, ctx) {
    const v = formValues(form);
    const result = await apiPost(`${base()}/readings/${form.dataset.id}/corrections`, { ...v, valueKwh: String(v.valueKwh).replace(/,/g, "") });
    ctx.toast(result.affectedStatementIds.length
      ? `Correction saved. ${result.affectedStatementIds.length} statement(s) used the old value — regenerate statements for that bill.`
      : "Correction saved.");
    ctx.render();
  },
  async "rental-bill-create"(form, ctx) {
    const v = formValues(form);
    const amountCentavos = parsePesoToCentavos(String(v.amount));
    if (amountCentavos === null) throw new Error("Enter the bill amount in pesos, e.g. 14,321.75.");
    const bill = await apiPost(`${base()}/utility-bills`, {
      meterId: idFrom(v.meterId), periodStart: v.periodStart, periodEnd: v.periodEnd, totalKwh: String(v.totalKwh).replace(/,/g, ""),
      amountCentavos, billNumber: v.billNumber || null, source: v.source,
    });
    const file = form.elements.document.files?.[0];
    if (file) {
      try {
        await apiPutFile(`${base()}/utility-bills/${encodeURIComponent(bill.id)}/document`, file);
      } catch (error) {
        ctx.toast(`Bill saved, but the document upload failed: ${errorMessage(error)}`);
        ctx.render();
        return;
      }
    }
    ctx.toast("Official bill saved.");
    ctx.render();
  },
};

export const rentalActions = {
  async "invite-revoke"(button, ctx) {
    await apiPost(`${base()}/invitations/${button.dataset.id}/revoke`);
    ctx.toast("Invitation revoked.");
    ctx.render();
  },
  async "member-revoke"(button, ctx) {
    if (!window.confirm("Remove this person's access? Any current occupancy ends today.")) return;
    await apiPost(`${base()}/members/${button.dataset.id}/revoke`);
    ctx.toast("Access removed.");
    ctx.render();
  },
  async "write-nfc"(_button, ctx) {
    // Web NFC writes the same protected, single-use, time-limited link that the QR code holds.
    const link = document.querySelector(".invite-link")?.value;
    if (!link || !("NDEFReader" in window)) throw new Error("NFC is not available on this device. Use the QR code or link.");
    ctx.toast("Hold an NFC tag near your phone…");
    await new window.NDEFReader().write({ records: [{ recordType: "url", data: link }] });
    ctx.toast("Invitation link written to the NFC tag.");
  },
  async "copy-invite"(_button, ctx) {
    const input = document.querySelector(".invite-link");
    await navigator.clipboard.writeText(input.value);
    ctx.toast("Link copied.");
  },
  async "statements-generate"(button, ctx) {
    const run = await apiPost(`${base()}/utility-bills/${button.dataset.id}/statements`);
    const root = document.querySelector("#content");
    fill(root, "reconciliation", reconciliationHtml(ctx, run));
    ctx.translate(root);
    ctx.toast(`${run.statementIds.length} draft statement(s) created.`);
  },
  async "reconciliation-show"(button, ctx) {
    const run = await apiGet(`${base()}/utility-bills/${button.dataset.id}/reconciliation`);
    const root = document.querySelector("#content");
    fill(root, "reconciliation", reconciliationHtml(ctx, run));
    ctx.translate(root);
  },
  async "bill-document"(button) {
    const { getIdToken } = await import("./src/lib/apiAuth.ts");
    const response = await fetch(`${base()}/utility-bills/${button.dataset.id}/document`, { headers: { Authorization: `Bearer ${await getIdToken()}` } });
    if (!response.ok) throw new Error("Could not open the bill document.");
    const url = URL.createObjectURL(await response.blob());
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  async "statement-finalize"(button, ctx) {
    if (!window.confirm("Finalize this statement? It cannot be edited afterwards; corrections create a new version.")) return;
    await apiPost(`${base()}/statements/${button.dataset.id}/finalize`);
    ctx.toast("Statement finalized and visible to the tenant.");
    ctx.render();
  },
  async "statement-void"(button, ctx) {
    const reason = window.prompt("Reason for voiding this statement (shown in the audit log):");
    if (!reason) return;
    await apiPost(`${base()}/statements/${button.dataset.id}/void`, { reason });
    ctx.toast("Statement voided.");
    ctx.render();
  },
  async "subscription-request"(_button, ctx) {
    await apiPost(`${base()}/subscription/request-activation`);
    ctx.toast("Activation requested. SmartWatts staff will contact you; no payment was taken.");
    ctx.render();
  },
};

export async function handleRentalOcr(kind, input, ctx) {
  const file = input.files?.[0];
  if (!file) return;
  const root = document.querySelector("#content");
  fill(root, "ocr-status", "Reading image in your browser…");
  try {
    const text = await recognizeImage(file);
    if (kind === "meter-photo") {
      const value = extractMeterReading(text);
      const form = root.querySelector('[data-form="reading-create"]');
      if (value !== null) {
        form.elements.valueKwh.value = value;
        form.elements.source.value = "photo_ocr";
        form.elements.ocrSuggestedKwh.value = value;
      }
      fill(root, "ocr-status", value !== null ? "Suggested value filled in. Compare it with the meter before confirming." : "No reading found. Enter it manually.");
    } else {
      const { kwh, amountPesos } = extractBillFields(text);
      const form = root.querySelector('[data-form="rental-bill-create"]');
      if (kwh) form.elements.totalKwh.value = kwh;
      if (amountPesos) form.elements.amount.value = amountPesos;
      if (kwh || amountPesos) form.elements.source.value = "photo_ocr";
      fill(root, "ocr-status", kwh || amountPesos ? "Suggested figures filled in. Verify every value against the official bill." : "No figures found. Enter them manually.");
    }
  } catch (error) {
    fill(root, "ocr-status", `${ctx.escape(errorMessage(error))} Enter the values manually.`);
  } finally {
    input.value = "";
    ctx.translate(root);
  }
}

export { loadWorkspaces, setWorkspace };
