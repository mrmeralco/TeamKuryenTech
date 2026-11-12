// Consumption Calendar views shared by the Personal, Rental Owner, and Rental Tenant workspaces.
import { buildTimeline, monthGrid, seasonalAverages, yearsCovered } from "./src/lib/calendar.ts";
import { estimateMonthlyKwh } from "./src/lib/personal/estimates.ts";
import { listAppliances, listBills, listSavingsPlans } from "./src/lib/personal/store.ts";
import { getMonthlyEnergyTarget } from "./game.js";
import { fill, formatPeso, kindBadge, notice, slot, table, user } from "./ui-kit.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const views = new Map(); // container id -> { records, year }

const kwhText = (kwh) => (kwh === null || kwh === undefined ? "Not measured" : `${kwh.toLocaleString("en-PH", { maximumFractionDigits: 2 })} kWh`);
const percentText = (value) => (value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`);

function gridHtml(id) {
  const { records, year } = views.get(id);
  const years = yearsCovered(records);
  const grid = monthGrid(records, year);
  return `
    <div class="toolbar calendar-years" role="group" aria-label="Year">
      ${years.map((y) => `<button type="button" class="btn btn-small ${y === year ? "btn-primary" : "btn-outline"}" data-act="calendar-year" data-view="${id}" data-year="${y}" aria-pressed="${y === year}">${y}</button>`).join("")}
    </div>
    <div class="calendar-grid">
      ${grid.map((cell) => `<div class="calendar-month${cell.periods.length ? " has-data" : ""}">
        <b>${MONTH_NAMES[cell.month - 1]} ${year}</b>
        ${cell.periods.length
          ? cell.periods.map((p) => `<div class="calendar-period"><span translate="no">${user(p.periodStart)} – ${user(p.periodEnd)}</span><small>${kwhText(p.kwh)}${p.amountCentavos !== null ? ` · ${formatPeso(p.amountCentavos)}` : ""}</small><small class="muted-note">${p.overlapDays} day(s) in this month</small></div>`).join("")
          : `<small class="muted-note">No record</small>`}
      </div>`).join("")}
    </div>
    <p class="muted-note">Billing periods keep their exact dates. A period spanning two months appears in both with its full total; kWh are never split into invented daily or monthly values.</p>`;
}

/** Calendar + timeline HTML for recorded billing periods. */
export function calendarSection(ctx, id, records, { monthlyGoalKwh = null, estimatedMonthlyKwh = null, recordedKind = "official_utility_bill" } = {}) {
  if (!records.length) return `<p class="muted-note">No recorded billing periods yet.</p>`;
  const year = views.get(id)?.year ?? yearsCovered(records)[0];
  views.set(id, { records, year });
  const timeline = buildTimeline(records, { monthlyGoalKwh, estimatedMonthlyKwh }).reverse();
  const seasonal = seasonalAverages(records);
  return `
    <div data-calendar="${id}">${gridHtml(id)}</div>
    <h4>Billing periods ${kindBadge(recordedKind)}</h4>
    ${table(
      ["Period", "Days", "Consumption", "Amount", "Avg. per day", "Change (per day)", ...(monthlyGoalKwh ? ["Vs. goal"] : []), ...(estimatedMonthlyKwh ? ["Appliance estimate"] : [])],
      timeline.map((t) => [
        `<span translate="no">${user(t.periodStart)} – ${user(t.periodEnd)}</span>${t.label ? `<div class="muted-note">${user(t.label)}</div>` : ""}`,
        t.days,
        kwhText(t.kwh),
        t.amountCentavos === null ? "—" : formatPeso(t.amountCentavos),
        t.averageKwhPerDay === null ? "—" : `${t.averageKwhPerDay} kWh <small class="muted-note">(period average)</small>`,
        percentText(t.changeVsPreviousPercent),
        ...(monthlyGoalKwh ? [t.goalDifferenceKwh === null ? "—" : `${t.goalDifferenceKwh > 0 ? "+" : ""}${t.goalDifferenceKwh} kWh vs ${t.goalForPeriodKwh} kWh goal`] : []),
        ...(estimatedMonthlyKwh ? [`${t.estimatedForPeriodKwh} kWh ${kindBadge("estimate")}`] : []),
      ]),
    )}
    ${seasonal.length > 1 ? `<h4>Seasonal pattern</h4>${table(["Period ending in", "Avg. kWh per day", "Periods"], seasonal.map((s) => [MONTH_NAMES[s.month - 1], s.averageKwhPerDay, s.periods]))}` : ""}`;
}

export const calendarActions = {
  "calendar-year"(button, ctx) {
    const view = views.get(button.dataset.view);
    if (!view) return;
    view.year = Number(button.dataset.year);
    const container = document.querySelector(`[data-calendar="${CSS.escape(button.dataset.view)}"]`);
    if (container) {
      container.innerHTML = gridHtml(button.dataset.view);
      ctx.translate(container);
    }
  },
};

// ---------------------------------------------------------- personal page
function calendarPage(ctx) {
  return `
    ${ctx.pageHead("Consumption calendar", "Your recorded bills by billing period, compared with your goal and appliance estimates.")}
    ${notice("info", `${kindBadge("official_utility_bill")} Consumption comes from bills you recorded. ${kindBadge("estimate")} Goal and appliance figures are scaled to each period's length. SmartWatts has no meter connection, so there is no daily data.`)}
    ${ctx.panel("Billing calendar", slot("personal-calendar"))}
    <div style="margin-top:14px">${ctx.panel("Savings plans history", slot("savings-history"))}</div>`;
}

async function loadCalendar(ctx, root) {
  const [bills, appliances, plans] = await Promise.all([listBills(), listAppliances(), listSavingsPlans()]);
  let estimatedMonthlyKwh = 0;
  for (const appliance of appliances) {
    try {
      estimatedMonthlyKwh += estimateMonthlyKwh(appliance);
    } catch {
      // Skip incomplete appliance records in the estimate.
    }
  }
  const records = bills.map((b) => ({ periodStart: b.periodStart, periodEnd: b.periodEnd, kwh: b.kwh, amountCentavos: b.amountCentavos, kind: "recorded" }));
  fill(root, "personal-calendar", records.length
    ? calendarSection(ctx, "personal", records, { monthlyGoalKwh: getMonthlyEnergyTarget(), estimatedMonthlyKwh: estimatedMonthlyKwh || null })
    : `<p class="muted-note">No bills recorded yet. Add bills to build your calendar.</p><button class="btn btn-primary" data-page="bills">Add a bill</button>`);
  fill(root, "savings-history", table(
    ["Plan", "Estimated monthly savings"],
    plans.map((p) => [user(p.title), `${p.monthlyKwhSaved} kWh · ${formatPeso(p.monthlySavingsCentavos)} ${kindBadge("estimate")}`]),
    "No saved savings plans yet.",
  ));
}

export const calendarPages = {
  calendar: { title: "Consumption Calendar", subtitle: "Billing-period history and goals.", render: calendarPage, load: loadCalendar },
};
