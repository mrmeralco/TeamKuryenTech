// SmartWatts Rentals (Tier 2) screens for property owners/administrators and tenants.
// All data comes from the FastAPI backend, which enforces membership, role,
// and subscription checks. Nothing here can reach tenants' private data.
import QRCode from "qrcode";
import { apiGet, apiPatch, apiPost, apiPutFile } from "./src/lib/apiAuth.ts";
import { parsePesoToCentavos } from "./src/lib/format.ts";
import { extractBillFields, extractMeterReading, recognizeImage } from "./src/lib/ocr.ts";
import {
  confirmDialog, errorMessage, field, fill, formatPeso, formValues, kindBadge, lifecycleBadge, LIFECYCLE_LABELS, notice, slot, table, todayIso, user, whToKwh, LEGAL_NOTICE,
} from "./ui-kit.js";
import { getWorkspace, loadWorkspaces, setWorkspace } from "./workspace.js";
import { calendarSection } from "./calendar-view.js";

const METER_KINDS = {
  utility_individual: "Individual utility meter (Scenario A)",
  private_submeter: "Private submeter (Scenario B)",
  utility_shared: "Shared utility meter (Scenario C)",
};
const STATUS_LABELS = { draft: "Draft", reviewed: "Reviewed", finalized: "Published", superseded: "Superseded", void: "Void" };
const statementStage = (s) => (s.status === "draft" && s.reviewedAt ? "reviewed" : s.status);
const OCCUPANCY_LABELS = { vacant: "Vacant", occupied: "Occupied (tenant not on SmartWatts)", maintenance: "Under maintenance" };

const pid = () => encodeURIComponent(getWorkspace().propertyId ?? "");
const base = () => `/api/rentals/properties/${pid()}`;
const legal = () => notice("warning", LEGAL_NOTICE);

function entitlementBanner(property) {
  const e = property.entitlement;
  if (!e || e.active) return "";
  const link = `<button class="text-link" data-page="rental-subscription">View subscription</button>`;
  if (e.lifecycle === "archived") return notice("warning", "This property is archived. All records stay readable; nothing can be changed.");
  if (e.lifecycle === "draft" || e.lifecycle === "pending_activation") {
    return notice("info", `${lifecycleBadge(e.lifecycle)} Analytics requires an active property subscription. You can set up units, meters, and billing arrangements now. Existing historical records are preserved. ${e.lifecycle === "pending_activation" ? "Your activation request is waiting for SmartWatts staff review. Check Subscription for the decision and any reason provided; contact staff if you need an update." : "Request activation from Subscription when setup is ready."} Tenant invitations and new readings, bills, and statements unlock after activation. Bills saved in your Personal workspace remain separate from this property's Rentals records. ${link}`);
  }
  return notice("danger", `This property's SmartWatts Rentals subscription ${e.status === "expired" ? "has expired" : "is not active"}. Existing records stay readable, but changes are paused. ${link}`);
}

/** Disables a paid operational form with a visible explanation instead of failing on submit. */
function operational(property, html) {
  const e = property.entitlement;
  if (e?.active) return html;
  const why = e?.lifecycle === "archived" ? "This property is archived." : "Available after this property's subscription is activated.";
  return `<p class="muted-note locked-note">🔒 ${why}</p><fieldset class="locked-fieldset" disabled>${html}</fieldset>`;
}

/** Setup forms work on drafts but not on suspended, expired, disabled, or archived properties. */
function setupForm(property, html) {
  const lifecycle = property.entitlement?.lifecycle;
  if (["draft", "pending_activation", "active"].includes(lifecycle)) return html;
  return `<p class="muted-note locked-note">🔒 ${lifecycle === "archived" ? "This property is archived." : "Changes are paused until the subscription is renewed."}</p><fieldset class="locked-fieldset" disabled>${html}</fieldset>`;
}

async function notificationsPanel(ctx, propertyId) {
  let items = [];
  try {
    items = (await apiGet("/api/rentals/notifications")).filter((n) => n.propertyId === propertyId).slice(0, 8);
  } catch {
    return "";
  }
  return ctx.panel("Property notifications", items.length ? `<div class="rental-notifications">${items.map((n) => `
    <div class="alert ${n.readAt ? "read" : "unread"}"><div><strong>${ctx.escape(n.title)}</strong>
      <small class="notification-time">${ctx.escape(new Date(n.createdAt).toLocaleString())}</small><p>${user(n.body)}</p>
      <div class="toolbar">${n.page ? `<button class="text-link" data-page="${ctx.escape(n.page)}">Open</button>` : ""}
      ${n.readAt ? "" : `<button class="text-link" data-act="rental-notification-read" data-id="${encodeURIComponent(n.id)}">Mark read</button>`}</div></div></div>`).join("")}</div>`
    : `<p class="muted-note">No property notifications yet.</p>`);
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

function statementMeta(statement) {
  const config = statement.meterConfiguration ? METER_KINDS[statement.meterConfiguration] ?? statement.meterConfiguration : null;
  return `<div class="detail-list statement-meta">
    ${config ? `<div class="detail-row"><span>Meter configuration</span><b>${user(statement.meterLabel ?? "")} · ${config}</b></div>` : ""}
    <div class="detail-row"><span>Statement version</span><b>v${user(statement.version)} · ${STATUS_LABELS[statementStage(statement)] ?? user(statement.status)}</b></div>
  </div>`;
}

function calculationDetails(statement) {
  return `<details class="calc-details"><summary>How this was calculated</summary>
    ${statement.lines.map((line) => `<pre translate="no">${user(JSON.stringify(line.calculation, null, 2))}</pre>`).join("")}
  </details>`;
}

// ------------------------------------------------------------ overview
function overviewPage(ctx) {
  return `${ctx.pageHead("Property overview", "Setup progress, operations, and recent activity for this property.")}
    ${slot("entitlement", "")}${slot("overview")}<div style="margin-top:14px">${slot("overview-notifications", "")}</div>`;
}

function setupChecklist(ctx, property) {
  const setup = property.setup;
  const e = property.entitlement;
  const steps = [
    ["Property details", true, "rental-overview", `${user(property.name)} · ${user(property.address)}`],
    ["Units", setup.unitCount > 0, "rental-units", `${setup.unitCount} of ${e.unitLimit} units`],
    ["Meters", setup.meterCount > 0, "rental-meters", `${setup.meterCount} meter(s) registered`],
    ["Billing arrangement for every unit", setup.unitCount > 0 && !setup.unitsWithoutBillingArrangement.length, "rental-meters",
      setup.unitsWithoutBillingArrangement.length ? `Missing: ${setup.unitsWithoutBillingArrangement.map((label) => user(label)).join(", ")}` : "Each unit has a meter or an allocation agreement"],
    ["Subscription / activation", e.active, "rental-subscription", e.active ? "Active" : LIFECYCLE_LABELS[e.lifecycle]?.[0] ?? "Draft"],
    ["Tenants & invitations", setup.memberCount > 1, "rental-units", e.active ? `${setup.memberCount - 1} member(s) besides you` : "Unlocks after activation"],
  ];
  const done = steps.filter(([, complete]) => complete).length;
  return ctx.panel(`Property setup <small>${done} of ${steps.length} complete</small>`, `
    <div class="setup-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}" aria-label="Setup progress"><span style="width:${Math.round((done / steps.length) * 100)}%"></span></div>
    <ol class="setup-steps">${steps.map(([label, complete, page, detail]) => `
      <li class="${complete ? "done" : ""}"><span class="setup-check" aria-hidden="true">${complete ? "✓" : ""}</span>
        <div><b>${label}</b><small>${detail}</small></div>
        <button class="btn btn-outline btn-small" data-page="${page}">${complete ? "Review" : "Set up"}</button></li>`).join("")}</ol>`);
}

/**
 * One calendar record per exact billing period: the property total across its utility meters.
 * Without this, bills of different meters for the same month were compared with each other.
 */
function propertyPeriodTotals(bills) {
  const totals = new Map();
  for (const b of bills) {
    const key = `${b.periodStart}|${b.periodEnd}`;
    const t = totals.get(key) ?? { periodStart: b.periodStart, periodEnd: b.periodEnd, wh: 0, amountCentavos: 0, kind: "recorded" };
    t.wh += b.totalWh;
    t.amountCentavos += b.amountCentavos;
    totals.set(key, t);
  }
  return [...totals.values()].map(({ wh, ...t }) => ({ ...t, kwh: wh / 1000 }));
}

async function loadOverview(ctx, root) {
  const property = await propertyHeader(root);
  const e = property.entitlement;
  const header = `<div class="property-title"><h3 translate="no">${ctx.escape(property.name)}</h3>${lifecycleBadge(e.lifecycle)}
    <p class="muted-note">${user(property.address)} · You are the ${property.role === "owner" ? "owner" : "administrator"}</p></div>`;
  fill(root, "overview-notifications", await notificationsPanel(ctx, getWorkspace().propertyId));

  if (!e.active) {
    fill(root, "overview", `${header}
      <div class="two-panels">
        ${setupChecklist(ctx, property)}
        ${ctx.panel("Activate SmartWatts Rentals", `
          <p class="stat-foot">${formatPeso(e.priceCentavos)} per property per month (proposed) · up to ${user(e.unitLimit)} units · tenants join free.</p>
          <p class="muted-note">Activation unlocks tenant invitations, meter readings, bill records, statements, and Property Analytics. Online payment is not enabled; SmartWatts staff activate subscriptions manually.</p>
          ${e.lifecycle === "pending_activation" ? notice("info", "Activation requested. SmartWatts staff will contact you. No payment was taken.") : ""}
          <button class="btn btn-primary" data-page="rental-subscription">${e.lifecycle === "pending_activation" ? "View activation request" : "Request activation"}</button>`)}
      </div>`);
    return;
  }

  let analytics = null;
  try {
    analytics = await apiGet(`${base()}/analytics`);
  } catch (error) {
    fill(root, "overview", `${header}${notice("danger", `Could not load property data: ${ctx.escape(errorMessage(error))}`)}`);
    return;
  }
  const latest = analytics.bills.at(-1);
  const reviewRequests = await apiGet(`${base()}/review-requests`).catch(() => []);
  const openRequests = reviewRequests.filter((r) => r.status === "open").length;
  const unreviewed = analytics.statementsSummary.draftCount;
  fill(root, "overview", `${header}
    <div class="grid stats">
      ${ctx.stat("layout-dashboard", "Active units", analytics.unitCount, `/ ${e.unitLimit}`, `${analytics.occupiedUnitCount} occupied · ${analytics.occupancyRate}%`, "")}
      ${ctx.stat("gauge", "Meters", analytics.meterCount, "", `${analytics.missingReadingsAlerts.length} need a reading`, "")}
      ${ctx.stat("receipt", "Latest billing period", latest ? `${whToKwh(latest.totalWh)}` : "—", latest ? "kWh" : "", latest ? `${latest.periodStart} – ${latest.periodEnd}` : "No bills recorded yet", "")}
      ${ctx.stat("receipt-text", "Statements to review", unreviewed, "", `${analytics.statementsSummary.needsReviewCount} need fixes · ${openRequests} tenant request(s)`, "")}
    </div>
    <div class="two-panels">
      ${ctx.panel("Needs attention", `<ul class="attention-list">
        ${analytics.missingReadingsAlerts.map((a) => `<li><b>${user(a.meterLabel)}</b> — ${user(a.issue)} <button class="text-link" data-page="rental-readings">Record reading</button></li>`).join("")}
        ${unreviewed ? `<li><b>${unreviewed} draft statement(s)</b> waiting for review. <button class="text-link" data-page="rental-statements">Review</button></li>` : ""}
        ${openRequests ? `<li><b>${openRequests} tenant review request(s)</b> open. <button class="text-link" data-page="rental-statements">Respond</button></li>` : ""}
        ${property.setup.unitsWithoutBillingArrangement.length ? `<li>Units without a meter or allocation: ${property.setup.unitsWithoutBillingArrangement.map((l) => user(l)).join(", ")} <button class="text-link" data-page="rental-meters">Configure</button></li>` : ""}
      </ul>${analytics.missingReadingsAlerts.length || unreviewed || openRequests || property.setup.unitsWithoutBillingArrangement.length ? "" : `<p class="muted-note">Nothing needs attention right now.</p>`}`)}
      ${ctx.panel("Recent utility bills", table(
        ["Period", "kWh", "Amount"],
        analytics.bills.slice(-6).reverse().map((b) => [`${user(b.periodStart)} – ${user(b.periodEnd)}`, `${whToKwh(b.totalWh)} ${kindBadge("owner_entered")}`, formatPeso(b.amountCentavos)]),
        "No bills recorded yet. Add one on the Utility Bills page.",
      ))}
    </div>
    <div style="margin-top:14px">${ctx.panel("Property billing calendar", calendarSection(ctx, `owner-${pid()}`, propertyPeriodTotals(analytics.bills)))}</div>`);
}

// ------------------------------------------------------------ analytics
let currentAnalyticsData = null;
let currentPortfolioData = null;
let currentAnalyticsState = {
  viewMode: "property",
  unitId: "all",
  period: "all",
};

let currentAnalyticsFilter = { from: "", to: "" };
let analyticsCtx = null;

// One delegated listener (page loaders get a guarded root without addEventListener,
// and #content outlives each render, so per-load listeners would pile up).
document.addEventListener("change", (event) => {
  const id = event.target?.id;
  if (id !== "rentalAnalyticsPeriodSelect" && id !== "rentalAnalyticsUnitSelect") return;
  const root = document.querySelector("#content");
  if (!root || !analyticsCtx || !currentAnalyticsData) return;
  if (id === "rentalAnalyticsPeriodSelect") currentAnalyticsState.period = event.target.value;
  else currentAnalyticsState.unitId = event.target.value;
  renderAnalyticsView(analyticsCtx, root);
});

function analyticsPage(ctx) {
  return `${ctx.pageHead("Property Analytics", "Unit-level electricity usage, official billing totals, and tenant statements.",
    `<button class="btn btn-outline" data-act="analytics-print">Print / Save as PDF</button>`)}
    ${slot("entitlement", "")}${legal()}
    <form class="analytics-filter" data-form="analytics-filter" aria-label="Analytics date filter">
      <label>From<input type="date" name="from" value="${ctx.escape(currentAnalyticsFilter.from)}"></label>
      <label>To<input type="date" name="to" value="${ctx.escape(currentAnalyticsFilter.to)}"></label>
      <button class="btn btn-outline btn-small" type="submit">Apply</button>
      <button class="btn btn-outline btn-small" type="button" data-act="analytics-filter-clear">Clear</button>
      <small class="muted-note">Billing periods overlapping these dates are included.</small>
    </form>
    ${slot("analytics-content")}`;
}

async function loadAnalytics(ctx, root) {
  const property = await propertyHeader(root);
  const e = property.entitlement;
  if (!e?.active) {
    fill(root, "analytics-content", `
      <div class="panel" style="text-align: center; padding: 48px 24px;">
        <div style="font-size: 42px; margin-bottom: 12px;">🔒</div>
        <h3 style="font-size: 20px; margin-bottom: 8px;">Property Analytics Requires an Active Subscription</h3>
        <p class="muted-note" style="max-width: 560px; margin: 0 auto 20px; line-height: 1.6;">
          Property Analytics provides unit-level electricity usage, official billing totals, period-over-period trend comparisons, shared meter reconciliations, and tenant statement breakdowns. Your property records remain preserved.
        </p>
        <button class="btn btn-primary" data-page="rental-subscription">View Subscription (₱299 / property / month)</button>
      </div>`);
    return;
  }

  try {
    const query = new URLSearchParams(Object.entries(currentAnalyticsFilter).filter(([, v]) => v)).toString();
    const [analytics, portfolio] = await Promise.all([
      apiGet(`${base()}/analytics${query ? `?${query}` : ""}`),
      apiGet("/api/rentals/portfolio/analytics").catch(() => null),
    ]);
    currentAnalyticsData = analytics;
    currentPortfolioData = portfolio;
    currentAnalyticsState = { viewMode: "property", unitId: "all", period: "all" };
    analyticsCtx = ctx;
    renderAnalyticsView(ctx, root);
  } catch (error) {
    fill(root, "analytics-content", notice("danger", `Could not load analytics: ${ctx.escape(errorMessage(error))}`));
  }
}

function renderAnalyticsView(ctx, root) {
  const a = currentAnalyticsData;
  const portfolio = currentPortfolioData;
  const state = currentAnalyticsState;
  if (!a) return;

  const hasMultipleProps = Boolean(portfolio && portfolio.totalProperties > 1);

  if (state.viewMode === "portfolio" && portfolio && portfolio.portfolioTotals) {
    const pt = portfolio.portfolioTotals;
    const viewSwitch = hasMultipleProps ? `
      <div class="toolbar" style="margin-bottom: 14px; justify-content: space-between;">
        <div style="display:flex; gap: 8px;">
          <button class="btn btn-outline" data-act="analytics-switch-view" data-view="property">This Property (${ctx.escape(a.propertyName)})</button>
          <button class="btn btn-primary" data-act="analytics-switch-view" data-view="portfolio">Portfolio View (${portfolio.activePropertiesCount} active)</button>
        </div>
      </div>` : "";

    fill(root, "analytics-content", `
      ${viewSwitch}
      <div class="grid stats">
        ${ctx.stat("building-2", "Managed properties", portfolio.totalProperties, "", `${portfolio.activePropertiesCount} active · ${portfolio.totalProperties - portfolio.activePropertiesCount} inactive`, "")}
        ${ctx.stat("layout-dashboard", "Portfolio units", pt.totalUnits, "", `${pt.totalOccupiedUnits} occupied · ${pt.occupancyRate}% rate`, "")}
        ${ctx.stat("activity", "Portfolio energy", `${pt.portfolioConsumptionKwh} kWh`, "", "Measured & official utility usage", "")}
        ${ctx.stat("receipt", "Official utility bills", formatPeso(pt.portfolioUtilityBilledCentavos), "", `Tenant billed: ${formatPeso(pt.portfolioTenantBilledCentavos)}`, "")}
      </div>
      <div style="margin-top: 14px;">
        ${ctx.panel("Properties in your portfolio", table(
          ["Property", "Role", "Units", "Occupancy", "Utility Billed", "Tenant Billed", "Subscription Status"],
          portfolio.properties.map((p) => [
            `<b>${user(p.propertyName)}</b><div class="muted-note">${user(p.address || "No address")}</div>`,
            p.role === "owner" ? "Owner" : "Administrator",
            p.unlocked ? `${p.analytics.unitCount} units` : `Up to ${p.entitlement.unitLimit} units`,
            p.unlocked ? `${p.analytics.occupancyRate}% (${p.analytics.occupiedUnitCount}/${p.analytics.unitCount})` : "—",
            p.unlocked ? formatPeso(p.analytics.totalOfficialBilledCentavos) : "🔒 Locked",
            p.unlocked ? formatPeso(p.analytics.totalTenantBilledCentavos) : "🔒 Locked",
            p.unlocked ? `<span class="status">Active</span>` : `<span class="status off">${user(p.entitlement.status)}</span>`,
          ]),
          "No properties in portfolio.",
        ))}
      </div>`);
    return;
  }

  let displayedUnits = a.unitsAnalytics;
  if (state.unitId !== "all") {
    displayedUnits = a.unitsAnalytics.filter((u) => u.unitId === state.unitId);
  }
  const selectedUnit = state.unitId !== "all" ? a.unitsAnalytics.find((u) => u.unitId === state.unitId) : null;

  const viewSwitch = hasMultipleProps ? `
    <div style="display:flex; gap: 8px;">
      <button class="btn btn-primary" data-act="analytics-switch-view" data-view="property">This Property (${ctx.escape(a.propertyName)})</button>
      <button class="btn btn-outline" data-act="analytics-switch-view" data-view="portfolio">Portfolio View (${portfolio.activePropertiesCount} active)</button>
    </div>` : `<div></div>`;

  const periodOptions = `<option value="all">All Billing Periods (${a.billingPeriods.length})</option>` +
    a.billingPeriods.map((p) => `<option value="${p.billId}"${state.period === p.billId ? " selected" : ""}>${p.periodStart} – ${p.periodEnd} (${p.utilityKwh} kWh)</option>`).join("");

  const unitOptions = `<option value="all">All Units (${a.unitsAnalytics.length})</option>` +
    a.unitsAnalytics.map((u) => `<option value="${u.unitId}"${state.unitId === u.unitId ? " selected" : ""}>${user(u.unitLabel)} (${u.isOccupied ? "Occupied" : "Vacant"})</option>`).join("");

  let popHtml = "";
  if (a.periodOverPeriod) {
    const pop = a.periodOverPeriod;
    const kwhTone = pop.kwhChange <= 0 ? "style='color:#10b981;'" : "style='color:#f59e0b;'";
    const costTone = pop.costChangeCentavos <= 0 ? "style='color:#10b981;'" : "style='color:#f59e0b;'";
    popHtml = `
      <div class="panel" style="margin-bottom: 14px;">
        <div class="panel-head">
          <h3>Period-over-Period Electricity Trends</h3>
          <span class="kind-badge kind-official">Official Utility Trend</span>
        </div>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 10px;">
          <div style="padding: 12px; background: var(--bg); border-radius: 8px;">
            <small class="muted-note">Billing Periods Compared</small>
            <div style="font-weight: 600; margin-top: 4px; font-size: 13px;">${pop.currentPeriod} <br><span class="muted-note">vs</span> ${pop.previousPeriod}</div>
          </div>
          <div style="padding: 12px; background: var(--bg); border-radius: 8px;">
            <small class="muted-note">Consumption Change</small>
            <div style="font-weight: 700; font-size: 18px; margin-top: 4px;" ${kwhTone}>
              ${pop.kwhChange >= 0 ? "+" : ""}${pop.kwhChange} kWh (${pop.kwhChangePercent ?? 0}%)
            </div>
          </div>
          <div style="padding: 12px; background: var(--bg); border-radius: 8px;">
            <small class="muted-note">Utility Cost Change</small>
            <div style="font-weight: 700; font-size: 18px; margin-top: 4px;" ${costTone}>
              ${pop.costChangeCentavos >= 0 ? "+" : ""}${formatPeso(pop.costChangeCentavos)} (${pop.costChangePercent ?? 0}%)
            </div>
          </div>
        </div>
      </div>`;
  }

  let missingReadingsHtml = "";
  if (a.missingReadingsAlerts && a.missingReadingsAlerts.length > 0) {
    missingReadingsHtml = `
      <div style="margin-bottom: 14px;">
        ${notice("warning", `<b>Missing Meter Readings Detected:</b> ${a.missingReadingsAlerts.length} meter(s) require readings for billing periods.
          <ul style="margin: 6px 0 0 16px; padding: 0;">
            ${a.missingReadingsAlerts.map((m) => `<li><b>${user(m.meterLabel)}</b> (${user(m.kind)}): ${user(m.issue)}</li>`).join("")}
          </ul>`)}
      </div>`;
  }

  let sharedMeterHtml = "";
  if (a.sharedMeters && a.sharedMeters.length > 0) {
    sharedMeterHtml = `
      <div style="margin-bottom: 14px;">
        ${notice("info", `<b>Shared Meter Allocation Methodology:</b> ${a.sharedMeters.map((sm) => `<b>${user(sm.meterLabel)}</b>: Submeter deduction with ${sm.agreementsCount} explicit agreement(s)`).join("; ")}. <div class="muted-note">${user(a.legalNotice)}</div>`)}
      </div>`;
  }

  const meterTrendHtml = a.meterTrends?.length ? ctx.panel("Meter-level comparison", `
      <p class="muted-note">Billed kWh per utility meter for each recorded bill period. Shared meters show the building total only; SmartWatts never invents per-unit kWh for them.</p>
      ${table(["Meter", "Type", ...[...new Set(a.meterTrends.flatMap((t) => t.points.map((p) => p.periodStart.slice(0, 7))))].sort().map((m) => user(m))],
        (() => {
          const months = [...new Set(a.meterTrends.flatMap((t) => t.points.map((p) => p.periodStart.slice(0, 7))))].sort();
          return a.meterTrends.map((t) => [
            user(t.meterLabel), METER_KINDS[t.kind] ?? user(t.kind),
            ...months.map((month) => {
              const point = t.points.find((p) => p.periodStart.startsWith(month));
              return point ? `${user(point.kwh)} kWh<div class="muted-note">${formatPeso(point.amountCentavos)}</div>` : "—";
            }),
          ]);
        })())}`) : "";

  const maxUnitWh = Math.max(...a.unitsAnalytics.map((u) => u.totalMeasuredWh + u.totalAllocatedWh), 1000);
  const unitBarsHtml = `
    <div class="panel" style="margin-bottom: 14px;">
      <div class="panel-head">
        <h3>Unit Consumption Comparison</h3>
        <span class="kind-badge kind-measured">Measured</span><span class="kind-badge kind-allocation">Allocated</span>
      </div>
      <p class="muted-note" style="margin-top: 4px;">Measured vs allocated electricity consumption per unit across billing periods.</p>
      <div style="display: grid; gap: 10px; margin-top: 14px;">
        ${a.unitsAnalytics.map((u) => {
          const totalWh = u.totalMeasuredWh + u.totalAllocatedWh;
          const pct = Math.min(100, Math.round((totalWh / maxUnitWh) * 100));
          return `
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 3px;">
                <span><b>${user(u.unitLabel)}</b> ${u.isOccupied ? `<small class="muted-note">(Occupied)</small>` : `<small class="muted-note">(Vacant)</small>`}</span>
                <span><b>${whToKwh(u.totalMeasuredWh)} kWh</b> measured ${u.totalAllocatedWh > 0 ? `<small class="muted-note">(+${whToKwh(u.totalAllocatedWh)} kWh allocated)</small>` : ""}</span>
              </div>
              <div class="progress" style="height: 10px; border-radius: 5px; background: var(--line);">
                <span style="width: ${Math.max(4, pct)}%; background: ${u.totalAllocatedWh > 0 ? 'linear-gradient(90deg, var(--orange), #f59e0b)' : 'var(--orange)'}; border-radius: 5px;"></span>
              </div>
            </div>`;
        }).join("")}
      </div>
    </div>`;

  const st = a.statementsSummary;
  const totalStatements = st.finalizedCount + st.draftCount;
  const finPct = totalStatements > 0 ? Math.round((st.finalizedCount / totalStatements) * 100) : 0;
  const draftPct = totalStatements > 0 ? Math.round((st.draftCount / totalStatements) * 100) : 0;
  const statusBreakdownHtml = `
    <div class="panel" style="margin-bottom: 14px;">
      <div class="panel-head">
        <h3>Tenant Statement Status</h3>
        <span class="kind-badge kind-official">${totalStatements} Total Statements</span>
      </div>
      <div style="display: flex; gap: 14px; margin: 12px 0 8px;">
        <div style="flex: 1;">
          <div style="display: flex; justify-content: space-between; font-size: 13px;">
            <span><b>Published (Finalized)</b></span>
            <span><b>${st.finalizedCount}</b> (${formatPeso(st.finalizedCentavos)})</span>
          </div>
          <div class="progress" style="height: 8px; margin-top: 4px; background: var(--line);">
            <span style="width: ${finPct}%; background: #10b981;"></span>
          </div>
        </div>
        <div style="flex: 1;">
          <div style="display: flex; justify-content: space-between; font-size: 13px;">
            <span><b>Pending (Draft)</b></span>
            <span><b>${st.draftCount}</b> (${formatPeso(st.draftCentavos)})</span>
          </div>
          <div class="progress" style="height: 8px; margin-top: 4px; background: var(--line);">
            <span style="width: ${draftPct}%; background: #f59e0b;"></span>
          </div>
        </div>
      </div>
      ${st.needsReviewCount > 0 ? `<div class="muted-note" style="color: #dc2626;">⚠️ ${st.needsReviewCount} statement(s) require owner review due to meter reading changes or unassigned meters.</div>` : ""}
    </div>`;

  let unitDetailHtml = "";
  if (selectedUnit) {
    unitDetailHtml = `
      <div class="panel" style="margin-bottom: 14px; border: 2px solid var(--orange);">
        <div class="panel-head">
          <h3>Unit Details: <span translate="no">${ctx.escape(selectedUnit.unitLabel)}</span></h3>
          <button class="btn btn-outline" data-act="clear-unit-details">Close Details</button>
        </div>
        <div class="detail-list" style="margin: 10px 0;">
          <div class="detail-row"><span>Status</span><b>${selectedUnit.isOccupied ? "Occupied" : "Vacant"}</b></div>
          <div class="detail-row"><span>Assigned meters</span><b>${selectedUnit.meters.map((m) => user(m.meterLabel)).join(", ") || "None"}</b></div>
          <div class="detail-row"><span>Total measured usage</span><b>${whToKwh(selectedUnit.totalMeasuredWh)} kWh</b></div>
          <div class="detail-row"><span>Total allocated usage</span><b>${whToKwh(selectedUnit.totalAllocatedWh)} kWh</b></div>
          <div class="detail-row"><span>Total billed to tenant</span><b>${formatPeso(selectedUnit.totalBilledCentavos)}</b></div>
        </div>
        <h4>Historical Statements for this Unit</h4>
        ${table(
          ["Period", "Measured", "Allocated", "Total Billed", "Status", "Review Notes"],
          selectedUnit.statements.map((s) => [
            `${user(s.periodStart)} – ${user(s.periodEnd)}`,
            `${whToKwh(s.measuredWh)} kWh`,
            `${whToKwh(s.allocatedWh)} kWh`,
            formatPeso(s.totalCentavos),
            s.status === "finalized" ? `<span class="status">Finalized</span>` : `<span class="status off">Draft</span>`,
            s.needsReview ? `<span style="color:#dc2626;">${user(s.reviewReason || "Needs Review")}</span>` : "—",
          ]),
          "No statements generated for this unit yet.",
        )}
      </div>`;
  }

  fill(root, "analytics-content", `
    <div class="toolbar" style="margin-bottom: 14px; justify-content: space-between; flex-wrap: wrap;">
      ${viewSwitch}
      <button class="btn btn-outline" data-act="export-property-analytics">
        📥 Export Analytics (.csv)
      </button>
    </div>
    <div class="panel" style="margin-bottom: 14px; padding: 12px 18px;">
      <div style="display: flex; gap: 14px; flex-wrap: wrap; align-items: center;">
        <div style="display:flex; align-items:center; gap: 8px;">
          <label for="rentalAnalyticsPeriodSelect" style="font-weight: 600; font-size: 13px;">Billing period:</label>
          <select id="rentalAnalyticsPeriodSelect" class="select" style="min-width: 220px;">
            ${periodOptions}
          </select>
        </div>
        <div style="display:flex; align-items:center; gap: 8px;">
          <label for="rentalAnalyticsUnitSelect" style="font-weight: 600; font-size: 13px;">Unit filter:</label>
          <select id="rentalAnalyticsUnitSelect" class="select" style="min-width: 180px;">
            ${unitOptions}
          </select>
        </div>
      </div>
    </div>
    <div class="grid stats">
      ${ctx.stat("activity", "Measured electricity", `${whToKwh(a.totalTenantMeasuredWh)} kWh`, "", `${a.meterCount} meters registered`, "")}
      ${ctx.stat("receipt", "Official utility bills", formatPeso(a.totalOfficialBilledCentavos), "", `${a.bills.length} bills · ${whToKwh(a.totalOfficialBilledWh)} kWh`, "")}
      ${ctx.stat("users-round", "Unit occupancy", `${a.occupiedUnitCount} / ${a.unitCount}`, "", `${a.occupancyRate}% occupied · ${a.vacantUnitCount} available`, "")}
      ${ctx.stat("badge-dollar-sign", "Tenant statements", formatPeso(a.totalTenantBilledCentavos), "", `${a.statementsSummary.finalizedCount} published · ${a.statementsSummary.draftCount} draft`, "")}
    </div>
    ${popHtml}
    ${missingReadingsHtml}
    ${sharedMeterHtml}
    ${meterTrendHtml ? `<div style="margin-bottom:14px">${meterTrendHtml}</div>` : ""}
    <div class="two-panels">
      ${unitBarsHtml}
      ${statusBreakdownHtml}
    </div>
    ${unitDetailHtml}
    <div style="margin-top: 14px;">
      ${ctx.panel("Unit-Level Electricity Analytics", table(
        ["Unit", "Occupancy", "Assigned Meters", "Measured Usage", "Allocated Share", "Total Billed", "Trend", "Statements", "Action"],
        displayedUnits.map((u) => [
          `<b>${user(u.unitLabel)}</b>`,
          u.isOccupied ? `<span class="status">Occupied</span>` : `<span class="status off">Vacant</span>`,
          u.meters.map((m) => user(m.meterLabel)).join(", ") || `<span class="muted-note">None</span>`,
          `${whToKwh(u.totalMeasuredWh)} kWh`,
          `${whToKwh(u.totalAllocatedWh)} kWh`,
          formatPeso(u.totalBilledCentavos),
          u.consumptionChangePercent !== null ? `<span style="font-weight:600; color: ${u.consumptionChangePercent <= 0 ? '#10b981' : '#f59e0b'};">${u.consumptionChangePercent >= 0 ? '+' : ''}${u.consumptionChangePercent}%</span>` : `—`,
          `${u.finalizedStatementsCount} published · ${u.draftStatementsCount} draft`,
          `<button class="btn btn-outline" data-act="view-unit-details" data-unit-id="${u.unitId}">Details</button>`,
        ]),
        "No units match the filter.",
      ))}
    </div>`);
}

// ------------------------------------------------------- units & tenants
function unitsPage(ctx) {
  return `${ctx.pageHead("Units & tenants", "Register units, invite tenants with a secure link or QR code, and record move-outs.")}
    ${slot("entitlement", "")}
    <div class="two-panels">
      ${ctx.panel("Add a unit", slot("unit-form"))}
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
  const activeUnits = units.filter((u) => u.status === "active");
  const limit = property.entitlement.unitLimit;
  const atCap = activeUnits.length >= limit;
  fill(root, "unit-form", `<p class="muted-note">${activeUnits.length} of ${limit} units used on this property.</p>${atCap
    ? notice("info", `This property has reached its ${limit}-unit limit. Archive an unused unit to add another.`)
    : setupForm(property, `<form class="form-grid" data-form="unit-create">
        ${field("Unit label", `<input name="label" required maxlength="60" placeholder="e.g. Unit 2B">`)}
        ${field("Occupancy status", `<select class="select" name="occupancyStatus">${Object.entries(OCCUPANCY_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>`)}
        ${field("Notes (optional)", `<input name="notes" maxlength="500">`, { full: true })}
        <div class="field full"><button class="btn btn-primary" type="submit">Add unit</button></div>
      </form>`)}`);
  fill(root, "invite-form", operational(property, `<form class="form-grid" data-form="invite-create">
    ${field("Role", `<select class="select" name="role">
      <option value="tenant">Tenant</option>
      ${property.role === "owner" ? `<option value="admin">Property administrator</option>` : ""}
    </select>`)}
    ${field("Unit (tenants)", `<select class="select" name="unitId"><option value="">—</option>${options(activeUnits.filter((u) => !u.currentOccupancy), (u) => u.label)}</select>`, { hint: "Only units without a current tenant are listed." })}
    ${field("Move-in date", `<input type="date" name="moveInDate" value="${todayIso()}">`)}
    ${field("Restrict to email (optional)", `<input type="email" name="email">`, { hint: "If set, the invitee must sign in with this verified email." })}
    <div class="field full"><button class="btn btn-primary" type="submit">Create invitation</button></div>
  </form>`));
  const canSetup = ["draft", "pending_activation", "active"].includes(property.entitlement.lifecycle);
  fill(root, "units", table(
    ["Unit", "Tenant on SmartWatts", "Occupancy", "Notes", ""],
    units.map((u) => [
      `${user(u.label)}${u.status === "archived" ? ` <span class="status off">Archived</span>` : ""}`,
      u.currentOccupancy ? `${user(u.currentOccupancy.tenantEmail ?? "Tenant")}<div class="muted-note">since ${user(u.currentOccupancy.startDate)}</div>` : "—",
      u.currentOccupancy ? "Occupied (member)" : OCCUPANCY_LABELS[u.occupancyStatus ?? "vacant"],
      user(u.notes ?? ""),
      u.status === "active" && canSetup ? `<details class="row-actions"><summary class="text-link">Edit</summary>
        <form class="inline-form" data-form="unit-update" data-id="${encodeURIComponent(u.id)}">
          <input name="label" required maxlength="60" value="${ctx.escape(u.label)}" aria-label="Unit label">
          <select class="select" name="occupancyStatus" aria-label="Occupancy status">${Object.entries(OCCUPANCY_LABELS).map(([k, l]) => `<option value="${k}"${(u.occupancyStatus ?? "vacant") === k ? " selected" : ""}>${l}</option>`).join("")}</select>
          <input name="notes" maxlength="500" value="${ctx.escape(u.notes ?? "")}" aria-label="Notes" placeholder="Notes">
          <button class="btn btn-outline btn-small">Save</button>
        </form>
        <button class="btn btn-outline btn-small danger-link" data-act="unit-archive" data-id="${encodeURIComponent(u.id)}" data-label="${ctx.escape(u.label)}"${u.currentOccupancy ? ' disabled title="Record the move-out first"' : ""}>Archive unit</button>
      </details>` : "",
    ]),
    "No units yet. Add your first unit above.",
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
  const [property, data, allUnits] = await Promise.all([propertyHeader(root), apiGet(`${base()}/meters`), apiGet(`${base()}/units`)]);
  const units = allUnits.filter((u) => u.status === "active");
  const retired = data.meters.filter((m) => m.status === "retired");
  const canSetup = ["draft", "pending_activation", "active"].includes(property.entitlement.lifecycle);
  const meterLabel = Object.fromEntries(data.meters.map((m) => [m.id, m.label]));
  const unitLabel = Object.fromEntries(allUnits.map((u) => [u.id, u.label]));
  const activeMeters = data.meters.filter((m) => m.status !== "retired");
  const shared = activeMeters.filter((m) => m.kind === "utility_shared");
  const assignable = activeMeters.filter((m) => m.kind !== "utility_shared");
  fill(root, "meters", `
    <div class="two-panels">
      ${ctx.panel("Register a meter", setupForm(property, `<form class="form-grid" data-form="meter-create">
        ${field("Label", `<input name="label" required maxlength="60">`)}
        ${field("Type", `<select class="select" name="kind">${Object.entries(METER_KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>`)}
        ${field("Parent shared meter (submeters only)", `<select class="select" name="parentMeterId"><option value="">—</option>${options(shared, (m) => m.label)}</select>`)}
        ${field("Serial number (optional)", `<input name="serialNumber" maxlength="60">`)}
        ${field("Utility account no. (optional)", `<input name="utilityAccountNumber" maxlength="60">`)}
        ${retired.length ? field("Replaces retired meter (optional)", `<select class="select" name="replacesMeterId"><option value="">—</option>${options(retired, (m) => m.label)}</select>`, { full: true, hint: "Use this after a meter replacement. The new meter starts a fresh register; the old meter keeps its history." }) : ""}
        <div class="field full"><button class="btn btn-primary" type="submit">Register meter</button></div>
      </form>`))}
      ${ctx.panel("Assign a meter to a unit (individual meters)", setupForm(property, `<form class="form-grid" data-form="assignment-create">
        ${field("Meter", `<select class="select" name="meterId" required>${options(assignable, (m) => m.label)}</select>`)}
        ${field("Unit", `<select class="select" name="unitId" required>${options(units, (u) => u.label)}</select>`)}
        ${field("Effective from", `<input type="date" name="effectiveFrom" required>`)}
        ${field("Effective to (optional)", `<input type="date" name="effectiveTo">`)}
        <div class="field full"><button class="btn btn-primary" type="submit">Assign</button></div>
      </form>`))}
    </div>
    <div style="margin-top:14px">${ctx.panel("Meters", table(["Meter", "Type", "Parent", "Serial / account", "Status"], data.meters.map((m) => [
      user(m.label), METER_KINDS[m.kind], user(meterLabel[m.parentMeterId] ?? "—"), user([m.serialNumber, m.utilityAccountNumber].filter(Boolean).join(" · ") || "—"),
      m.status === "retired"
        ? `<span class="status off">Retired ${user(m.retiredOn)}</span><div class="muted-note">${user(m.retiredReason ?? "")}</div>`
        : `<span class="status">In service</span>${m.replacesMeterId ? `<div class="muted-note">Replaced ${user(meterLabel[m.replacesMeterId] ?? "")}</div>` : ""}${canSetup ? `
          <details class="row-actions"><summary class="text-link">Retire / replace</summary>
            <form class="inline-form" data-form="meter-retire" data-id="${encodeURIComponent(m.id)}">
              <input type="date" name="retiredOn" required max="${todayIso()}" aria-label="Date of final reading">
              <input name="reason" required minlength="5" maxlength="300" placeholder="Reason, e.g. utility replaced meter" aria-label="Reason">
              <button class="btn btn-outline btn-small">Retire meter</button>
            </form><p class="muted-note">Record the final reading first. Assignments end on this date.</p></details>` : ""}`,
    ]), "No meters yet. Register the utility meter(s) for this property."))}</div>
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
      ${shared.length && units.length && canSetup ? `<form class="form-grid" data-form="agreement-create" style="margin-top:12px">
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
  const [property, data, readings] = await Promise.all([propertyHeader(root), apiGet(`${base()}/meters`), apiGet(`${base()}/readings`)]);
  const meterLabel = Object.fromEntries(data.meters.map((m) => [m.id, m.label]));
  const inService = data.meters.filter((m) => m.status !== "retired");
  const flagged = readings.filter((r) => r.anomalies?.length).length;
  fill(root, "readings", `
    ${ctx.panel("Record a reading", operational(property, `
      <label class="upload-drop"><input type="file" accept="image/*" class="sr-only" data-ocr="meter-photo"><span>Suggest value from a meter photo (OCR in your browser)</span></label>
      <p class="muted-note" data-slot="ocr-status"></p>
      <form class="form-grid" data-form="reading-create">
        <input type="hidden" name="source" value="manual"><input type="hidden" name="ocrSuggestedKwh" value="">
        ${field("Meter", `<select class="select" name="meterId" required>${options(inService, (m) => `${m.label} (${METER_KINDS[m.kind]})`)}</select>`)}
        ${field("Reading date (when you read the meter)", `<input type="date" name="readingDate" required max="${todayIso()}" value="${todayIso()}">`)}
        ${field("Cumulative register value (kWh)", `<input name="valueKwh" inputmode="decimal" required>`, { hint: "The total shown on the meter, not the usage since the last reading." })}
        ${field("Evidence photo (optional)", `<input type="file" name="evidence" accept="image/png,image/jpeg,application/pdf">`)}
        <label class="field full check"><input type="checkbox" name="confirmed" required> I checked this value against the physical meter.</label>
        <div class="field full"><button class="btn btn-primary" type="submit">Save verified reading</button></div>
      </form>`))}
    ${flagged ? notice("warning", `${flagged} reading(s) are flagged for review. Flags never change values; correct a reading only if it was entered wrongly.`) : ""}
    <div style="margin-top:14px">${ctx.panel("Reading history", table(
      ["Meter", "Observed", "Register (kWh)", "Interval use", "Source", "Status", ""],
      readings.map((r) => [
        user(meterLabel[r.meterId]),
        `${user(r.readingDate)}<div class="muted-note">Saved ${user(new Date(r.createdAt).toLocaleString())}</div>`,
        `${whToKwh(r.valueWh)}`,
        r.intervalWh === null || r.intervalWh === undefined ? `<span class="muted-note">First reading</span>`
          : `${whToKwh(r.intervalWh)} kWh <div class="muted-note">over ${user(r.intervalDays)} day(s)</div>${(r.anomalies ?? []).map((a) => `<div class="flag-note">⚠ ${user(a)}</div>`).join("")}`,
        `${r.source === "photo_ocr" ? "Photo (OCR) · confirmed" : "Manual"}${r.correctionReason ? `<div class="muted-note">Correction: ${user(r.correctionReason)}</div>` : ""}${r.evidencePath ? `<div><button class="text-link" data-act="reading-evidence" data-id="${encodeURIComponent(r.id)}">View evidence</button></div>` : ""}`,
        r.status === "active" ? "Current" : "Superseded",
        r.status === "active" ? `<details><summary class="text-link">Correct</summary><form class="inline-form" data-form="reading-correct" data-id="${encodeURIComponent(r.id)}">
          <input name="valueKwh" inputmode="decimal" required aria-label="Corrected value (kWh)" placeholder="kWh">
          <input type="date" name="readingDate" value="${r.readingDate}" aria-label="Reading date">
          <input name="reason" required minlength="5" maxlength="300" aria-label="Reason" placeholder="Reason">
          <button class="btn btn-outline btn-small">Save correction</button></form></details>` : "",
      ]),
      "No readings yet. Record the first reading for each meter to start tracking consumption.",
    ))}</div>`);
}

// ---------------------------------------------------------- utility bills
function billsPage(ctx) {
  return `${ctx.pageHead("Official utility bills", "Upload official bills, map them to meters, and generate tenant statements.")}
    ${slot("entitlement", "")}${legal()}${slot("rental-bills")}
    <div data-slot="reconciliation"></div>`;
}

async function loadBills(ctx, root) {
  const [property, data, bills] = await Promise.all([propertyHeader(root), apiGet(`${base()}/meters`), apiGet(`${base()}/utility-bills`)]);
  const meterLabel = Object.fromEntries(data.meters.map((m) => [m.id, m.label]));
  const utilityMeters = data.meters.filter((m) => m.kind !== "private_submeter");
  fill(root, "rental-bills", `
    ${ctx.panel("Add a utility bill", operational(property, `
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
        ${field("Charge breakdown (optional)", `<textarea name="components" rows="3" placeholder="Generation = 6,120.00&#10;Transmission = 980.50&#10;Taxes = 1,200.25"></textarea>`, { full: true, hint: "One charge per line as Label = amount. The lines must add up to the total amount." })}
        ${field("Bill document (PDF/JPEG/PNG, optional)", `<input type="file" name="document" accept="application/pdf,image/png,image/jpeg">`, { full: true })}
        <p class="muted-note full">You enter these figures from your bill. SmartWatts is not connected to MERALCO or other utility systems and does not verify them.</p>
        <div class="field full"><button class="btn btn-primary" type="submit">Save bill</button></div>
      </form>`))}
    <div style="margin-top:14px">${ctx.panel("Bills", table(
      ["Meter", "Period", "kWh", "Amount", "Document", ""],
      bills.map((b) => [
        `${user(meterLabel[b.meterId])}${b.billNumber ? `<div class="muted-note">Bill no. ${user(b.billNumber)}</div>` : ""}`,
        `${user(b.periodStart)} – ${user(b.periodEnd)}`,
        `${whToKwh(b.totalWh)} ${kindBadge("owner_entered")}`,
        `${formatPeso(b.amountCentavos)}${b.chargeComponents?.length ? `<details><summary class="text-link">Breakdown</summary>${b.chargeComponents.map((c) => `<div class="muted-note">${user(c.label)}: ${formatPeso(c.amountCentavos)}</div>`).join("")}</details>` : ""}`,
        b.documentPath ? `<button class="text-link" data-act="bill-document" data-id="${encodeURIComponent(b.id)}">View</button>` : "—",
        property.entitlement.active ? `<div class="toolbar"><button class="btn btn-primary btn-small" data-act="statements-generate" data-id="${encodeURIComponent(b.id)}">Generate draft statements</button>
         <button class="btn btn-outline btn-small" data-act="reconciliation-show" data-id="${encodeURIComponent(b.id)}">Reconciliation</button></div>` : "",
      ]),
      "No bills recorded yet.",
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
  return `${ctx.pageHead("Tenant statements", "Draft → Reviewed → Published. Tenants only see published statements; corrections create a new version.")}
    ${slot("entitlement", "")}${legal()}${slot("review-requests", "")}${slot("statements")}`;
}

async function loadStatements(ctx, root) {
  const [property, statements, units, members, requests] = await Promise.all([
    propertyHeader(root), apiGet(`${base()}/statements`), apiGet(`${base()}/units`), apiGet(`${base()}/members`),
    apiGet(`${base()}/review-requests`).catch(() => []),
  ]);
  const active = property.entitlement.active;
  const statementById = Object.fromEntries(statements.map((s) => [s.id, s]));
  const unitLabel = Object.fromEntries(units.map((u) => [u.id, u.label]));
  const tenantEmail = Object.fromEntries(members.members.map((m) => [m.uid, m.email]));
  fill(root, "review-requests", requests.length ? ctx.panel("Tenant review requests", requests.map((r) => {
    const st = statementById[r.statementId];
    return `<div class="review-request ${r.status}">
      <p><b>${user(unitLabel[r.unitId] ?? "Unit")}</b> · ${user(r.tenantEmail ?? "Tenant")} · ${st ? `${user(st.periodStart)} – ${user(st.periodEnd)}` : ""}
        <span class="status ${r.status === "open" ? "pending" : ""}">${r.status === "open" ? "Open" : "Answered"}</span></p>
      <p class="stat-foot">“${user(r.message)}”</p>
      ${r.status === "open" ? `<form class="inline-form" data-form="review-resolve" data-id="${encodeURIComponent(r.id)}">
        <input name="resolution" required minlength="5" maxlength="1000" placeholder="Your response to the tenant" aria-label="Response">
        <button class="btn btn-outline btn-small">Send response</button></form>` : `<p class="muted-note">Response: ${user(r.resolution)}</p>`}
    </div>`;
  }).join("")) : "");
  fill(root, "statements", statements.length ? statements.map((s) => ctx.panel(
    `<span translate="no">${ctx.escape(unitLabel[s.unitId] ?? s.unitId)}</span> · ${ctx.escape(s.periodStart)} – ${ctx.escape(s.periodEnd)} <small>v${s.version} · ${STATUS_LABELS[statementStage(s)]}</small>`,
    `${s.needsReview ? notice("danger", `Needs review: ${ctx.escape(s.reviewReason ?? "")}`) : ""}
     <ol class="stage-track" aria-label="Statement stage">${["draft", "reviewed", "finalized"].map((stage, i) => {
       const order = { draft: 0, reviewed: 1, finalized: 2 }[statementStage(s)] ?? -1;
       return `<li class="${order >= i ? "done" : ""}">${STATUS_LABELS[stage]}</li>`;
     }).join("")}</ol>
     <p class="stat-foot">Tenant: ${user(s.tenantUid ? tenantEmail[s.tenantUid] ?? s.tenantUid : "Not assigned")}</p>
     ${statementMeta(s)}
     ${statementLines(s)}
     <div class="bill-amount">${formatPeso(s.totalCentavos)}</div>
     ${calculationDetails(s)}
     ${s.voidReason ? `<p class="muted-note">Voided: ${user(s.voidReason)}</p>` : ""}
     <div class="toolbar">
       ${active && statementStage(s) === "draft" && !s.needsReview && s.tenantUid ? `<button class="btn btn-primary btn-small" data-act="statement-review" data-id="${encodeURIComponent(s.id)}">Mark as reviewed</button>` : ""}
       ${active && statementStage(s) === "reviewed" ? `<button class="btn btn-primary btn-small" data-act="statement-finalize" data-id="${encodeURIComponent(s.id)}">Publish to tenant</button>` : ""}
       ${s.status === "draft" || s.status === "finalized" ? `<button class="btn btn-outline btn-small" data-act="statement-void" data-id="${encodeURIComponent(s.id)}">Void</button>` : ""}
     </div>`,
  )).join("") : `<p class="muted-note">No statements yet. Record a utility bill, then generate draft statements from it.</p>`);
}

// --------------------------------------------------------- subscription
function subscriptionPage(ctx) {
  return `${ctx.pageHead("Subscription", "SmartWatts Rentals is billed per property. Tenants are never charged by SmartWatts.")}${slot("subscription")}`;
}

const SUBSCRIPTION_ACTION_LABELS = {
  request: "Activation requested", approve: "Approved", reject: "Request not approved", suspend: "Suspended",
  reactivate: "Reactivated", extend: "Period extended", expire: "Expired", disable: "Disabled", restore: "Restored to draft",
};
const SOURCE_LABELS = { external_payment_verified: "Payment verified by SmartWatts staff (outside the app)", administrative_grant: "Administrative grant" };
const fmtDate = (value) => (value ? user(new Date(value).toLocaleDateString("en-PH", { dateStyle: "medium" })) : "—");
const fmtTime = (value) => (value ? user(new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })) : "—");

async function loadSubscription(ctx, root) {
  const sub = await apiGet(`${base()}/subscription`);
  const owner = getWorkspace().role === "owner";
  const reasonTitle = { draft: "Reason your last request was not approved", suspended: "Suspension reason", disabled: "Reason", expired: "Note" }[sub.lifecycle];
  const canRequest = owner && !sub.archived && sub.nextAction?.action === "request";
  fill(root, "subscription", ctx.panel("SmartWatts Rentals", `
    <div class="detail-list">
      <div class="detail-row"><span>Status</span><b>${lifecycleBadge(sub.lifecycle)}</b></div>
      <div class="detail-row"><span>Plan</span><b>SmartWatts Rentals · ${formatPeso(sub.priceCentavos)} per property per month (proposed)</b></div>
      <div class="detail-row"><span>Unit limit</span><b>${user(sub.unitLimit)} units</b></div>
      <div class="detail-row"><span>Entitlement period</span><b>${sub.currentPeriodEnd ? `${fmtDate(sub.currentPeriodStart)} – ${fmtDate(sub.currentPeriodEnd)}` : "—"}</b></div>
      <div class="detail-row"><span>Activation request</span><b>${sub.activationRequestedAt ? `Sent ${fmtTime(sub.activationRequestedAt)} · waiting for review` : sub.lastRequestedAt ? `Last sent ${fmtTime(sub.lastRequestedAt)}` : "Not requested"}</b></div>
      ${sub.activationSource ? `<div class="detail-row"><span>Activated by</span><b>${SOURCE_LABELS[sub.activationSource] ?? user(sub.activationSource)}</b></div>` : ""}
      <div class="detail-row"><span>Next step</span><b>${user(sub.nextAction?.label ?? "—")}</b></div>
    </div>
    ${sub.statusReason && reasonTitle ? notice(sub.lifecycle === "draft" || sub.lifecycle === "expired" ? "warning" : "danger", `<b>${reasonTitle}:</b> ${user(sub.statusReason)}`) : ""}
    ${notice("info", "Online payment is not enabled. SmartWatts staff review requests and activate subscriptions after verifying payment outside the app or approving an administrative grant. No card or e-wallet details are collected here.")}
    ${canRequest ? `<button class="btn btn-primary" data-act="subscription-request">${user(sub.nextAction.label)}</button>` : ""}`)
    + (sub.history?.length ? `<div style="margin-top:14px">${ctx.panel("Subscription history", table(["When", "Change", "Details"], sub.history.map((h) => [
      fmtTime(h.at), SUBSCRIPTION_ACTION_LABELS[h.action] ?? user(h.action),
      [h.periodEnd ? `Until ${fmtDate(h.periodEnd)}` : "", h.reason ? user(h.reason) : ""].filter(Boolean).join(" · ") || "—",
    ])))}</div>` : "")
    + (owner && !sub.archived ? `<div style="margin-top:14px">${ctx.panel("Archive this property", `<p class="stat-foot">Archiving makes the property read-only for everyone. Readings, bills, statements, and tenancy history are kept. Record move-outs for current tenants first.</p>
      <button class="btn btn-outline danger-link" data-act="property-archive">Archive property</button>`)}</div>` : ""));
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
  return `${ctx.pageHead("My rental electricity", "Your unit, billing arrangement, and the statements your landlord has published.")}
    ${legal()}${slot("tenant-unit")}${slot("tenant-statements")}`;
}

async function loadTenantStatements(ctx, root) {
  const [unit, statements, requests] = await Promise.all([
    apiGet(`${base()}/me/unit`), apiGet(`${base()}/me/statements`), apiGet(`${base()}/me/review-requests`).catch(() => []),
  ]);
  const requestsByStatement = {};
  for (const r of requests) (requestsByStatement[r.statementId] ??= []).push(r);
  fill(root, "tenant-unit", `<div class="two-panels">${ctx.panel(`<span translate="no">${ctx.escape(unit.propertyName)}</span> · <span translate="no">${ctx.escape(unit.unitLabel)}</span>`, `
    ${unit.propertyAddress ? `<p class="muted-note">${user(unit.propertyAddress)}</p>` : ""}
    <h4>Your billing arrangement</h4>
    ${table(["Meter", "Type", "Assigned"], unit.meters.map((m) => [`<b>${user(m.label)}</b>`, METER_KINDS[m.kind], `<span class="nowrap">${user(m.effectiveFrom)}</span> – ${m.effectiveTo ? `<span class="nowrap">${user(m.effectiveTo)}</span>` : "ongoing"}`]), unit.sharedArrangements?.length ? "No individual meter is assigned to your unit." : "No meter or allocation is set up for your unit yet.")}
    ${(unit.sharedArrangements ?? []).map((a) => `<div class="shared-arrangement">${kindBadge("allocation_based_charge")}
      <p><b>${user(a.meterLabel)}</b> is a shared meter. Your unit's agreed share is <b>${user(a.unitWeight)} of ${user(a.totalWeight)}</b> (${user(Math.round((a.unitWeight / a.totalWeight) * 1000) / 10)}%) of the shared consumption that is allocated to tenants.</p>
      <p class="muted-note">Agreement: ${user(a.description)} · from ${user(a.effectiveFrom)}${a.effectiveTo ? ` to ${user(a.effectiveTo)}` : ""}. This is an allocation, not a measurement of your unit.</p></div>`).join("")}
    <p class="stat-foot">You do not pay SmartWatts. Your appliances, schedules, savings plans, and AI chats are private — your landlord cannot see them.</p>`)}
    ${await notificationsPanel(ctx, getWorkspace().propertyId)}</div>`);
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
     ${statementMeta(s)}
     ${(requestsByStatement[s.id] ?? []).map((r) => `<div class="review-request ${r.status}"><p class="stat-foot">You asked: “${user(r.message)}” · <b>${r.status === "open" ? "Waiting for your landlord" : "Answered"}</b></p>${r.resolution ? `<p class="muted-note">Response: ${user(r.resolution)}</p>` : ""}</div>`).join("")}
     ${s.status === "finalized" && !(requestsByStatement[s.id] ?? []).some((r) => r.status === "open") ? `<details><summary class="text-link">Ask your landlord to re-check this statement</summary>
       <form class="inline-form" data-form="tenant-review-request" data-id="${encodeURIComponent(s.id)}">
         <input name="message" required minlength="10" maxlength="1000" placeholder="What looks wrong?" aria-label="Message to your landlord">
         <button class="btn btn-outline btn-small">Send request</button></form></details>` : ""}
     <p class="muted-note">${ctx.escape(s.legalReviewNotice)}</p>`,
  )).join("") : `<p class="muted-note">No published statements yet. Your landlord publishes statements after recording and reviewing a utility bill.</p>`));
}

function tenantMetersPage(ctx) {
  return `${ctx.pageHead("My meter history", "Verified readings from meters that measure your unit only.")}${slot("tenant-meters")}`;
}

function historyPage(ctx, tenant = false) {
  return `${ctx.pageHead(tenant ? "My rental history" : "Historical Data", tenant ? "Your own readings, published statements, occupancy, and allocation records." : "Property electricity, billing, occupancy, allocation, subscription, and audit records.")}
    <form class="filter-row" data-form="history-filter">
      <label>From <input type="date" name="start"></label><label>To <input type="date" name="end"></label>
      <label>Preset <select name="preset"><option value="custom">Custom period</option><option value="30">Last 30 days</option><option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option></select></label>
      ${tenant ? "" : `<label>Unit <select name="unitId"><option value="">All units</option></select></label><label>Meter <select name="meterId"><option value="">All meters</option></select></label>`}
      <label>Record type <select name="type"><option value="">All history</option>${(tenant ? ["reading", "statement", "occupancy", "allocation"] : ["reading", "bill", "statement", "occupancy", "allocation", "audit", "subscription"]).map((x) => `<option value="${x}">${x[0].toUpperCase()}${x.slice(1)}</option>`).join("")}</select></label>
      <button class="btn btn-outline btn-small">Apply filters</button>
      <button class="btn btn-outline btn-small" type="button" data-act="history-export">Export this page CSV</button>
    </form>${slot("history-summary")}${slot("history-records")}${slot("history-more")}`;
}

let latestHistoryPage = null;
let historyFilters = {};
async function loadHistory(ctx, root, tenant = false, cursor = null, filters = {}) {
  const params = new URLSearchParams({ limit: "50" });
  for (const key of ["start", "end", "type", "unitId", "meterId"]) if (filters[key]) params.set(key, filters[key]);
  if (cursor) params.set("cursor", cursor);
  const endpoint = tenant ? `${base()}/me/history` : `${base()}/history`;
  const [result, units, meters] = await Promise.all([
    apiGet(`${endpoint}?${params}`),
    tenant ? Promise.resolve([]) : apiGet(`${base()}/units`),
    tenant ? Promise.resolve([]) : apiGet(`${base()}/meters`).then((data) => data.meters ?? data),
  ]);
  latestHistoryPage = cursor && latestHistoryPage ? { ...result, records: [...latestHistoryPage.records, ...result.records], tenant, filters } : { ...result, tenant, filters };
  historyFilters = filters;
  result.records = latestHistoryPage.records;
  const records = result.records;
  fill(root, "history-summary", `<p class="muted-note">${result.total} matching records · dates shown as recorded in Asia/Manila. ${tenant ? "Only your records within your occupancy are included; shared usage is labeled as an allocation." : "Source values and status are preserved; shared usage is not presented as unit-metered consumption."}</p>`);
  const rows = records.map((r) => {
    const period = r.periodStart ? `${user(r.periodStart)} – ${user(r.periodEnd ?? "")}` : user(r.date);
    const amount = Number.isInteger(r.totalCentavos) ? formatPeso(r.totalCentavos) : Number.isInteger(r.amountCentavos) ? formatPeso(r.amountCentavos) : "—";
    const usage = Number.isFinite(r.totalWh) ? `${whToKwh(r.totalWh)} kWh` : Number.isFinite(r.intervalWh) ? `${whToKwh(r.intervalWh)} kWh interval` : Number.isFinite(r.valueWh) ? `${whToKwh(r.valueWh)} kWh register` : r.allocatedWh ? `${whToKwh(r.allocatedWh)} kWh allocated` : "—";
    const status = [r.status ?? (r.verified ? "verified" : "recorded"), r.source].filter(Boolean).join(" · ");
    const ref = `${r.billNumber ? `Ref ${user(r.billNumber)}` : ""}${r.version ? `${r.billNumber ? " · " : ""}v${r.version}` : ""}` || "—";
    const authorizedBillLink = !tenant && r.type === "bill" && r.documentPath
      ? ` <button class="text-link" data-act="bill-document" data-id="${encodeURIComponent(r.id)}">View bill</button>` : "";
    return [user(r.type), period, user(r.meterLabel ?? r.unitId ?? "Property"), usage, amount, user(status), `${ref}${authorizedBillLink}`];
  });
  fill(root, "history-records", table(["Record", "Period / Date", "Meter / Unit", "Consumption", "Recorded charge (not payment)", "Status / Source", "Reference"], rows, "No matching historical records."));
  fill(root, "history-more", result.nextCursor ? `<button class="btn btn-outline" data-act="history-more" data-cursor="${result.nextCursor}">Load next 50</button>` : "");
  const form = root.querySelector('[data-form="history-filter"]');
  if (form) {
    if (!tenant) {
      form.elements.unitId.innerHTML = `<option value="">All units</option>${units.map((unit) => `<option value="${ctx.escape(unit.id)}">${ctx.escape(unit.label)}</option>`).join("")}`;
      form.elements.meterId.innerHTML = `<option value="">All meters</option>${meters.map((meter) => `<option value="${ctx.escape(meter.id)}">${ctx.escape(meter.label)}</option>`).join("")}`;
    }
    for (const [key, value] of Object.entries(filters)) if (form.elements[key]) form.elements[key].value = value;
  }
}

function rentalCsvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
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
  "rental-analytics": { title: "Property Analytics", subtitle: "SmartWatts Rentals", render: analyticsPage, load: loadAnalytics },
  "rental-history": { title: "Historical Data", subtitle: "SmartWatts Rentals", render: (ctx) => historyPage(ctx), load: (ctx, root) => loadHistory(ctx, root) },
  "rental-units": { title: "Units & Tenants", subtitle: "SmartWatts Rentals", render: unitsPage, load: loadUnits },
  "rental-meters": { title: "Meters & Allocation", subtitle: "SmartWatts Rentals", render: metersPage, load: loadMeters },
  "rental-readings": { title: "Meter Readings", subtitle: "SmartWatts Rentals", render: readingsPage, load: loadReadings },
  "rental-bills": { title: "Utility Bills", subtitle: "SmartWatts Rentals", render: billsPage, load: loadBills },
  "rental-statements": { title: "Tenant Statements", subtitle: "SmartWatts Rentals", render: statementsPage, load: loadStatements },
  "rental-subscription": { title: "Subscription", subtitle: "SmartWatts Rentals", render: subscriptionPage, load: loadSubscription },
  "rental-audit": { title: "Audit Log", subtitle: "SmartWatts Rentals", render: auditPage, load: loadAudit },
  "tenant-statements": { title: "My Statements", subtitle: "SmartWatts Rentals · Tenant", render: tenantStatementsPage, load: loadTenantStatements },
  "tenant-meters": { title: "My Meter History", subtitle: "SmartWatts Rentals · Tenant", render: tenantMetersPage, load: loadTenantMeters },
  "tenant-history": { title: "My Rental History", subtitle: "SmartWatts Rentals · Tenant", render: (ctx) => historyPage(ctx, true), load: (ctx, root) => loadHistory(ctx, root, true) },
};

function parseChargeComponents(text) {
  const lines = String(text ?? "").split(/\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/^(.+?)\s*[=:]\s*(-?[₱\d,.\s]+)$/);
    const amount = match ? parsePesoToCentavos(match[2].replace(/[₱\s]/g, "")) : null;
    if (!match || amount === null) throw new Error(`Could not read the charge line “${line}”. Use Label = amount.`);
    return { label: match[1].trim(), amountCentavos: amount };
  });
}

async function openDocument(path) {
  const { getIdToken } = await import("./src/lib/apiAuth.ts");
  const response = await fetch(path, { headers: { Authorization: `Bearer ${await getIdToken()}` } });
  if (!response.ok) throw new Error("Could not open the document.");
  const url = URL.createObjectURL(await response.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const rentalForms = {
  async "history-filter"(form, ctx) {
    historyFilters = formValues(form);
    if (historyFilters.preset && historyFilters.preset !== "custom") {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date()).map(({ type, value }) => [type, value]));
      const [year, month, day] = [Number(parts.year), Number(parts.month), Number(parts.day)];
      const endDay = Date.UTC(year, month - 1, day);
      const startDate = new Date(endDay);
      if (historyFilters.preset === "30") startDate.setUTCDate(startDate.getUTCDate() - 30);
      else {
        const originalDay = startDate.getUTCDate();
        startDate.setUTCDate(1);
        startDate.setUTCMonth(startDate.getUTCMonth() - Number(historyFilters.preset));
        const lastDay = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0)).getUTCDate();
        startDate.setUTCDate(Math.min(originalDay, lastDay));
      }
      const end = new Date(endDay).toISOString().slice(0, 10);
      const start = startDate.toISOString().slice(0, 10);
      historyFilters = { ...historyFilters, start, end };
    }
    await loadHistory(ctx, document.querySelector("#content"), getWorkspace().type === "tenant", null, historyFilters);
  },
  async "unit-create"(form, ctx) {
    await apiPost(`${base()}/units`, formValues(form));
    ctx.toast("Unit added.");
    ctx.render();
  },
  async "unit-update"(form, ctx) {
    const v = formValues(form);
    await apiPatch(`${base()}/units/${form.dataset.id}`, { label: v.label, occupancyStatus: v.occupancyStatus, notes: v.notes || null });
    ctx.toast("Unit updated.");
    ctx.render();
  },
  async "meter-retire"(form, ctx) {
    const ok = await confirmDialog({
      title: "Retire this meter?", danger: true, confirmLabel: "Retire meter",
      body: "No more readings can be recorded on it, and its unit assignment ends on this date. Its readings and bills are kept.",
    });
    if (!ok) return;
    await apiPost(`${base()}/meters/${form.dataset.id}/retire`, formValues(form));
    ctx.toast("Meter retired. Register the replacement meter and link it with “Replaces retired meter”.");
    ctx.render();
  },
  async "review-resolve"(form, ctx) {
    await apiPost(`${base()}/review-requests/${form.dataset.id}/resolve`, formValues(form));
    ctx.toast("Response sent to the tenant.");
    ctx.render();
  },
  async "tenant-review-request"(form, ctx) {
    await apiPost(`${base()}/me/statements/${form.dataset.id}/review-request`, formValues(form));
    ctx.toast("Request sent to your landlord.");
    ctx.render();
  },
  async "analytics-filter"(form, ctx) {
    const v = formValues(form);
    if (v.from && v.to && v.to < v.from) throw new Error("The To date must be on or after the From date.");
    currentAnalyticsFilter = { from: v.from || "", to: v.to || "" };
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
    await apiPost(`${base()}/meters`, {
      ...v, parentMeterId: v.parentMeterId ? idFrom(v.parentMeterId) : null, replacesMeterId: v.replacesMeterId ? idFrom(v.replacesMeterId) : null,
    });
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
    const saved = await apiPost(`${base()}/readings`, {
      meterId: idFrom(v.meterId), readingDate: v.readingDate, valueKwh: String(v.valueKwh).replace(/,/g, ""),
      source: v.source, ocrSuggestedKwh: v.ocrSuggestedKwh || null, confirmed: v.confirmed === "on",
    });
    const file = form.elements.evidence?.files?.[0];
    if (file) {
      try {
        await apiPutFile(`${base()}/readings/${encodeURIComponent(saved.id)}/evidence`, file);
      } catch (error) {
        ctx.toast(`Reading saved, but the evidence upload failed: ${errorMessage(error)}`);
        ctx.render();
        return;
      }
    }
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
    if (v.periodStart && v.periodEnd && v.periodEnd <= v.periodStart) throw new Error("The period end must be after the period start.");
    const chargeComponents = parseChargeComponents(v.components);
    if (chargeComponents.length && chargeComponents.reduce((sum, c) => sum + c.amountCentavos, 0) !== amountCentavos) {
      throw new Error("The charge breakdown must add up exactly to the total amount.");
    }
    const bill = await apiPost(`${base()}/utility-bills`, {
      meterId: idFrom(v.meterId), periodStart: v.periodStart, periodEnd: v.periodEnd, totalKwh: String(v.totalKwh).replace(/,/g, ""),
      amountCentavos, billNumber: v.billNumber || null, source: v.source, chargeComponents,
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
    ctx.toast("Bill saved.");
    ctx.render();
  },
};

export const rentalActions = {
  async "history-more"(button, ctx) {
    if (!latestHistoryPage?.nextCursor) return;
    await loadHistory(ctx, document.querySelector("#content"), latestHistoryPage.tenant, latestHistoryPage.nextCursor, historyFilters);
  },
  "history-export"(_button, ctx) {
    if (!latestHistoryPage) return;
    const rows = [["Record", "Date", "Scope", "Consumption", "Amount centavos", "Status", "Source", "Exported at"], ...latestHistoryPage.records.map((r) => [r.type, r.date, r.meterLabel ?? r.unitId ?? "Property", r.totalWh ?? r.intervalWh ?? r.valueWh ?? r.allocatedWh ?? "", r.totalCentavos ?? r.amountCentavos ?? "", r.status ?? "", r.source ?? "", new Date().toISOString()])];
    const blob = new Blob([rows.map((row) => row.map(rentalCsvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `smartwatts-rental-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    ctx.toast("Current authorized history page exported as CSV.");
  },
  async "invite-revoke"(button, ctx) {
    if (!await confirmDialog({ title: "Revoke this invitation?", body: "The link and QR code will stop working immediately.", confirmLabel: "Revoke", danger: true })) return;
    await apiPost(`${base()}/invitations/${button.dataset.id}/revoke`);
    ctx.toast("Invitation revoked.");
    ctx.render();
  },
  async "member-revoke"(button, ctx) {
    if (!await confirmDialog({ title: "Remove this person's access?", body: "Any current occupancy ends today. Their published statements stay available to them.", confirmLabel: "Remove access", danger: true })) return;
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
    await openDocument(`${base()}/utility-bills/${button.dataset.id}/document`);
  },
  async "reading-evidence"(button) {
    await openDocument(`${base()}/readings/${button.dataset.id}/evidence`);
  },
  async "statement-review"(button, ctx) {
    await apiPost(`${base()}/statements/${button.dataset.id}/review`);
    ctx.toast("Marked as reviewed. Publish it when you are ready for the tenant to see it.");
    ctx.render();
  },
  async "statement-finalize"(button, ctx) {
    if (!await confirmDialog({ title: "Publish this statement to the tenant?", body: "Published statements cannot be edited. Corrections create a new version.", confirmLabel: "Publish" })) return;
    await apiPost(`${base()}/statements/${button.dataset.id}/finalize`);
    ctx.toast("Statement published and visible to the tenant.");
    ctx.render();
  },
  async "statement-void"(button, ctx) {
    const reason = await confirmDialog({
      title: "Void this statement?", confirmLabel: "Void statement", danger: true,
      body: "The tenant will see that it was voided. This is recorded in the audit log.",
      input: { label: "Reason (at least 5 characters)", minLength: 5, maxLength: 300 },
    });
    if (!reason) return;
    await apiPost(`${base()}/statements/${button.dataset.id}/void`, { reason });
    ctx.toast("Statement voided.");
    ctx.render();
  },
  async "unit-archive"(button, ctx) {
    const ok = await confirmDialog({
      title: `Archive ${button.dataset.label ?? "this unit"}?`, danger: true, confirmLabel: "Archive unit",
      body: "Its readings, bills, statements, and tenancy history are kept. Open meter assignments end today. Archived units do not count toward the 10-unit limit.",
    });
    if (!ok) return;
    await apiPost(`${base()}/units/${button.dataset.id}/archive`, { confirm: true });
    ctx.toast("Unit archived.");
    ctx.render();
  },
  async "property-archive"(_button, ctx) {
    const ok = await confirmDialog({
      title: "Archive this property?", danger: true, confirmLabel: "Archive property",
      body: "Everyone keeps read access to existing records, but nothing can be changed afterwards.",
    });
    if (!ok) return;
    await apiPost(`${base()}/archive`, { confirm: true });
    await loadWorkspaces();
    ctx.toast("Property archived.");
    ctx.render();
  },
  async "rental-notification-read"(button, ctx) {
    await apiPost(`/api/rentals/notifications/${button.dataset.id}/read`);
    ctx.render();
  },
  "analytics-filter-clear"(_button, ctx) {
    currentAnalyticsFilter = { from: "", to: "" };
    ctx.render();
  },
  "analytics-print"() {
    window.print();
  },
  async "subscription-request"(_button, ctx) {
    await apiPost(`${base()}/subscription/request-activation`);
    ctx.toast("Activation requested. SmartWatts staff will contact you; no payment was taken.");
    ctx.render();
  },
  "analytics-switch-view"(button, ctx) {
    currentAnalyticsState.viewMode = button.dataset.view;
    const root = document.querySelector("#content");
    if (root) renderAnalyticsView(ctx, root);
  },
  "view-unit-details"(button, ctx) {
    currentAnalyticsState.unitId = button.dataset.unitId;
    const root = document.querySelector("#content");
    if (root) {
      const select = root.querySelector("#rentalAnalyticsUnitSelect");
      if (select) select.value = button.dataset.unitId;
      renderAnalyticsView(ctx, root);
      root.querySelector("#rentalAnalyticsUnitSelect")?.scrollIntoView({ behavior: "smooth" });
    }
  },
  "clear-unit-details"(_button, ctx) {
    currentAnalyticsState.unitId = "all";
    const root = document.querySelector("#content");
    if (root) {
      const select = root.querySelector("#rentalAnalyticsUnitSelect");
      if (select) select.value = "all";
      renderAnalyticsView(ctx, root);
    }
  },
  "export-property-analytics"(_button, ctx) {
    if (!currentAnalyticsData) return;
    const a = currentAnalyticsData;
    const rows = [
      `"SmartWatts Rentals Property Analytics Report"`,
      `"Property","${a.propertyName.replace(/"/g, '""')}","Address","${(a.address || '').replace(/"/g, '""')}"`,
      `"Export Date","${new Date().toISOString()}"`,
      `"Legal Notice","${(a.legalNotice || '').replace(/"/g, '""')}"`,
      `""`,
      `"--- PROPERTY SUMMARY ---"`,
      `"Metric","Value"`,
      `"Total Units","${a.unitCount}"`,
      `"Occupied Units","${a.occupiedUnitCount}"`,
      `"Vacant Units","${a.vacantUnitCount}"`,
      `"Occupancy Rate","${a.occupancyRate}%"`,
      `"Total Measured Electricity (kWh)","${whToKwh(a.totalTenantMeasuredWh)}"`,
      `"Total Official Utility Billed (PHP)","${(a.totalOfficialBilledCentavos / 100).toFixed(2)}"`,
      `"Total Tenant Billed (PHP)","${(a.totalTenantBilledCentavos / 100).toFixed(2)}"`,
      `"Published Finalized Statements","${a.statementsSummary.finalizedCount}"`,
      `"Draft Statements","${a.statementsSummary.draftCount}"`,
      `""`,
      `"--- BILLING PERIODS COMPARISON ---"`,
      `"Period Start","Period End","Utility kWh","Utility Charges (PHP)","Tenant Measured kWh","Tenant Allocated kWh","Tenant Total Charges (PHP)","kWh Change %","Cost Change %"`,
      ...a.billingPeriods.map((p) =>
        `"${p.periodStart}","${p.periodEnd}","${p.utilityKwh}","${(p.utilityAmountCentavos / 100).toFixed(2)}","${(p.tenantMeasuredWh / 1000).toFixed(2)}","${(p.tenantAllocatedWh / 1000).toFixed(2)}","${(p.tenantBilledCentavos / 100).toFixed(2)}","${p.kwhChangePercent ?? 'N/A'}","${p.costChangePercent ?? 'N/A'}"`
      ),
      `""`,
      `"--- UNIT-LEVEL ELECTRICITY ANALYTICS ---"`,
      `"Unit","Occupancy Status","Assigned Meters","Measured kWh","Allocated kWh","Total Charges (PHP)","Change %","Published Statements","Draft Statements"`,
      ...a.unitsAnalytics.map((u) =>
        `"${u.unitLabel.replace(/"/g, '""')}","${u.isOccupied ? 'Occupied' : 'Vacant'}","${u.meters.map((m) => m.meterLabel).join('; ').replace(/"/g, '""')}","${(u.totalMeasuredWh / 1000).toFixed(2)}","${(u.totalAllocatedWh / 1000).toFixed(2)}","${(u.totalBilledCentavos / 100).toFixed(2)}","${u.consumptionChangePercent ?? 'N/A'}","${u.finalizedStatementsCount}","${u.draftStatementsCount}"`
      ),
    ];
    const blob = new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `smartwatts-property-analytics-${a.propertyName.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    ctx.toast("Property analytics report exported successfully.");
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
