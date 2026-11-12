// SmartWatts Personal (Tier 1, free forever) screens plus account sign-in,
// the plans page, and the entry point to SmartWatts Rentals.
import {
  deleteAppliance, deleteBill, deleteSavingsPlan, ensureUserProfile, listAppliances, listBills, listSavingsPlans,
  saveAppliance, saveBill, saveSavingsPlan, saveUserProfile, storageMode,
} from "./src/lib/personal/store.ts";
import { effectiveRateCentavosPerKwh, estimateMonthlyKwh, simulateSavings } from "./src/lib/personal/estimates.ts";
import { extractBillFields, recognizeImage, redactBillText } from "./src/lib/ocr.ts";
import { CHARGE_CATEGORIES, categoryLabel, compareScenario, deriveRateProfile, enteredRateProfile, reconcileBill } from "./src/lib/billing/meralco.ts";
import {
  extractApplianceSpecs, recognizeApplianceLabel, rotateCanvas,
} from "./src/lib/appliance-ocr.ts";
import { parsePesoToCentavos, formatKwh } from "./src/lib/format.ts";
import {
  continueWithGoogle, createPermanentAccount, currentAccount, friendlyAuthError,
  resendVerification, signInPermanent, signOutAccount,
} from "./src/lib/account.ts";
import { apiPost } from "./src/lib/apiAuth.ts";
import { firebaseConfigured } from "./src/lib/firebase.ts";
import {
  errorMessage, field, fill, formatPeso, formValues, kindBadge, notice, slot, table, user, LEGAL_NOTICE, todayIso,
} from "./ui-kit.js";
import { getMemberships, getRentalsStatus, loadWorkspaces, setWorkspace } from "./workspace.js";

export const PENDING_INVITE_KEY = "smartwatts-pending-invite";
const CATEGORIES = ["cooling", "refrigeration", "lighting", "entertainment", "laundry", "cooking", "computing", "other"];
const SAMPLE_APPLIANCES = [
  ["Air Conditioner", 129.23], ["Refrigerator", 75.28], ["Television", 45.67], ["Washing Machine", 32.18], ["Others", 59.82],
];
const FALLBACK_PLANS = {
  tiers: [
    { id: "personal", tier: 1, name: "SmartWatts Personal", priceCentavos: 0 },
    { id: "rentals", tier: 2, name: "SmartWatts Rentals", priceCentavos: 29900, unitLimit: 10 },
  ],
  paymentsEnabled: false,
};
let lastSimulation = null;

function storageNote() {
  return storageMode() === "cloud"
    ? "Private to your account. Landlords and property managers can never see this data."
    : "Firebase is not configured, so this data is saved on this device only.";
}

// ------------------------------------------------------------ appliances
let scannerState = null;

function renderScannerPreview(root, state) {
  if (!state || !state.canvas) {
    fill(root, "scanner-preview", "");
    return;
  }
  const previewHtml = `
    <div class="scanner-box">
      <div class="scanner-preview-wrapper">
        <canvas class="scanner-preview-img" id="scannerCanvasView"></canvas>
        <div class="scanner-toolbar">
          <button type="button" class="btn btn-outline btn-small" data-act="scanner-rotate-ccw">↺ Rotate Left (90°)</button>
          <button type="button" class="btn btn-outline btn-small" data-act="scanner-rotate-cw">↻ Rotate Right (90°)</button>
          <button type="button" class="btn btn-outline btn-small" data-act="scanner-discard">🗑️ Discard Image</button>
        </div>
      </div>
      <div class="scanner-progress" id="scannerProgressArea" style="${state.processing ? "" : "display:none"}">
        <div class="scanner-progress-track">
          <div class="scanner-progress-fill" id="scannerProgressFill" style="width:${state.percent || 15}%"></div>
        </div>
        <span class="scanner-progress-text" id="scannerProgressText">${state.stage || "Reading image…"}</span>
      </div>
    </div>`;
  fill(root, "scanner-preview", previewHtml);

  const viewCanvas = root.querySelector("#scannerCanvasView");
  if (viewCanvas && state.canvas) {
    viewCanvas.width = state.canvas.width;
    viewCanvas.height = state.canvas.height;
    const vCtx = viewCanvas.getContext("2d");
    if (vCtx) vCtx.drawImage(state.canvas, 0, 0);
  }
}

function updateLiveEstimate(root) {
  const form = root?.querySelector('[data-form="appliance-save"]');
  if (!form) return;
  const watts = parseFloat(form.elements.watts?.value || "0");
  const testedKwhMonth = parseFloat(form.elements.testedKwhMonth?.value || "0");
  const quantity = parseInt(form.elements.quantity?.value || "1", 10);
  const hoursPerDay = parseFloat(form.elements.hoursPerDay?.value || "0");
  const daysPerWeek = parseFloat(form.elements.daysPerWeek?.value || "7");

  const target = root.querySelector('[data-slot="appliance-live-kwh"]');
  const basis = root.querySelector('[data-slot="appliance-live-basis"]');
  if (!target) return;

  if (watts > 0 || testedKwhMonth > 0) {
    try {
      const kwh = estimateMonthlyKwh({ watts, quantity, hoursPerDay, daysPerWeek, testedKwhMonth });
      target.textContent = `${formatKwh(kwh)} kWh / month`;
      if (basis) {
        basis.textContent = watts > 0
          ? "Based on entered wattage and daily usage schedule."
          : `Calculation basis: manufacturer tested monthly consumption (${testedKwhMonth.toFixed(2)} kWh/month per unit under standard test conditions). Daily hours are not applied.`;
      }
    } catch {
      target.textContent = "—";
    }
  } else {
    target.textContent = "0.00 kWh / month";
    if (basis) basis.textContent = "Enter wattage or energy label consumption to view estimate.";
  }
}

async function runApplianceOcr(ctx, root) {
  if (!scannerState || !scannerState.canvas) return;
  const progressArea = root.querySelector("#scannerProgressArea");
  const progressFill = root.querySelector("#scannerProgressFill");
  const progressText = root.querySelector("#scannerProgressText");
  if (progressArea) progressArea.style.display = "";

  const onProgress = ({ stage, percent }) => {
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = `${stage} (${percent}%)`;
  };

  try {
    const { specs } = await recognizeApplianceLabel(scannerState.canvas, onProgress);
    scannerState.specs = specs;
    scannerState.processing = false;
    if (progressArea) progressArea.style.display = "none";

    const form = root.querySelector('[data-form="appliance-save"]');
    if (form) {
      if (specs.name) form.elements.name.value = specs.name;
      if (specs.brand) form.elements.brand.value = specs.brand;
      if (specs.model) form.elements.model.value = specs.model;
      if (specs.category && CATEGORIES.includes(specs.category)) form.elements.category.value = specs.category;
      form.elements.watts.value = specs.watts !== null ? specs.watts : "";
      if (specs.voltage) form.elements.voltage.value = specs.voltage;
      form.elements.testedKwhMonth.value = specs.testedKwhMonth !== null ? specs.testedKwhMonth.toFixed(2) : "";
      form.elements.energyEfficiencyRating.value = specs.energyEfficiencyRating ?? "";
      form.elements.labelType.value = specs.labelType;
      form.elements.consumptionBasis.value = specs.consumptionBasis;
      form.elements.source.value = "ocr";
      if (!form.elements.hoursPerDay.value) form.elements.hoursPerDay.value = "8";
      if (!form.elements.daysPerWeek.value) form.elements.daysPerWeek.value = "7";
    }

    let statusHtml = `
      <div style="margin-bottom:8px">
        <span class="kind-badge kind-${specs.labelType === "ENERGY_EFFICIENCY" ? "estimate" : specs.labelType === "MIXED" ? "measured" : specs.labelType === "ELECTRICAL_SPECIFICATION" ? "official" : "sample"}">
          ${ctx.escape(specs.labelType.replace(/_/g, " "))}
        </span>
      </div>`;

    if (specs.labelType === "ENERGY_EFFICIENCY") {
      statusHtml += notice("info", `
        🏷️ <b>Energy Efficiency Label Detected</b><br>
        Rated input power (watts) is genuinely not listed on this label type.<br>
        ${specs.testedKwhMonth ? `Manufacturer tested consumption: <b>${specs.testedKwhMonth.toFixed(2)} kWh / month</b>.` : "<b>Tested consumption (kWh/month) could not be read.</b> Enter it from the label."}
        ${specs.energyEfficiencyRating ? `<br>Energy Efficiency Rating (EER): <b>${specs.energyEfficiencyRating}</b> (star efficiency metric, not watts).` : "<br>Energy Efficiency Rating could not be read. Enter it from the label if you need it (optional)."}
        <br><small>Your monthly consumption estimate below is based on the manufacturer's verified test rating.</small>
      `);
    } else if (specs.labelType === "MIXED") {
      statusHtml += notice("info", `
        🏷️ <b>Mixed Electrical &amp; Efficiency Label</b><br>
        ${specs.watts ? `Rated Power: <b>${specs.watts} W</b>` : ""}
        ${specs.testedKwhMonth ? ` · Tested Monthly Energy: <b>${specs.testedKwhMonth} kWh/mo</b>` : ""}
        ${specs.energyEfficiencyRating ? ` · EER: <b>${specs.energyEfficiencyRating}</b>` : ""}
      `);
    }

    if (specs.wattageCandidates.length > 1) {
      statusHtml += `
        <div class="candidate-selector">
          <p>⚠️ Multiple wattage values detected on label. Select your appliance operating power:</p>
          <div class="candidate-chips">
            ${specs.wattageCandidates.map((c) => `<button type="button" class="candidate-chip" data-act="scanner-choose-watt" data-watts="${c.value}">${ctx.escape(c.label)}</button>`).join(" ")}
          </div>
        </div>`;
    }

    if (specs.isDerivedPower && specs.derivedPowerExplanation) {
      statusHtml += notice("warning", `⚠️ <b>Estimated Power:</b> ${ctx.escape(specs.derivedPowerExplanation)}`);
    }

    if (specs.coolingBtuHr) {
      statusHtml += notice("info", `❄️ <b>Cooling Capacity:</b> ${specs.coolingBtuHr.toLocaleString()} BTU/h detected. SmartWatts requires electrical input power in Watts (not cooling BTU/h).`);
    }

    if (specs.motorHp) {
      statusHtml += notice("info", `⚙️ <b>Motor Horsepower:</b> ${specs.motorHp} HP detected. Please confirm actual electrical input wattage.`);
    }

    if (specs.testedKwhMonth && specs.labelType !== "ENERGY_EFFICIENCY") {
      statusHtml += `
        <div class="tested-energy-card">
          💡 <b>Manufacturer Tested Energy Consumption:</b> <b>${specs.testedKwhMonth} kWh/month</b> (tested under standard test conditions). Your actual estimate below is calculated from your usage schedule.
        </div>`;
    }

    if (specs.uncertainties.length && !specs.isDerivedPower && specs.wattageCandidates.length <= 1 && specs.labelType !== "ENERGY_EFFICIENCY") {
      statusHtml += notice("warning", `⚠️ ${specs.uncertainties.map((u) => ctx.escape(u)).join("<br>")}`);
    }

    statusHtml += `
      <details class="raw-ocr-drawer">
        <summary>View Raw OCR Text (${specs.rawText.length} characters)</summary>
        <pre>${ctx.escape(specs.rawText)}</pre>
      </details>
      <div style="margin-top:6px">
        <button type="button" class="btn btn-outline btn-small" data-act="scanner-ai-assist">✨ AI Vision Assist (Gemini)</button>
        <small class="field-hint" style="display:inline-block;margin-left:8px">Optional server AI analysis if label is blurry</small>
      </div>`;

    fill(root, "wattage-status", statusHtml);
    updateLiveEstimate(root);
    ctx.toast("Specifications extracted! Please review and confirm before saving.");
  } catch (error) {
    if (progressArea) progressArea.style.display = "none";
    fill(root, "wattage-status", `${notice("danger", `Could not read label: ${ctx.escape(errorMessage(error))}`)}
      <div style="margin-top:6px"><button type="button" class="btn btn-outline btn-small" data-act="scanner-ai-assist">✨ Try AI Vision Assist</button></div>`);
  } finally {
    ctx.translate(root);
  }
}

function appliancesPage(ctx) {
  return `
    ${ctx.pageHead("My appliances", "Register appliances and usage schedules to estimate where your electricity goes.")}
    ${notice("info", `${kindBadge("estimate")} Appliance figures are <b>estimates</b> based on the wattage and hours you enter, or manufacturer tested energy guide ratings. They are not meter measurements. ${storageNote()}`)}
    <div class="two-panels">
      ${ctx.panel("Add an appliance", `
        <div class="scanner-mode-bar">
          <label class="btn btn-primary scanner-btn" title="Take a photo with your device camera">
            <input type="file" accept="image/*" capture="environment" data-ocr="appliance-label" style="display:none">
            <span>📷 Scan Appliance Label</span>
          </label>
          <label class="btn btn-outline scanner-btn" title="Choose a photo from your computer or phone">
            <input type="file" accept="image/*" data-ocr="appliance-label" style="display:none">
            <span>📁 Upload Label Photo</span>
          </label>
          <button type="button" class="btn btn-outline scanner-btn" data-act="scanner-manual-mode">
            <span>✍️ Enter Details Manually</span>
          </button>
        </div>

        <div data-slot="scanner-preview"></div>

        <form class="form-grid" data-form="appliance-save">
          <input type="hidden" name="source" value="manual">
          <input type="hidden" name="voltage" value="">
          <input type="hidden" name="labelType" value="UNKNOWN">
          <input type="hidden" name="consumptionBasis" value="none">
          ${field("Name", `<input name="name" required maxlength="60" placeholder="e.g. Bedroom aircon">`)}
          ${field("Brand (optional)", `<input name="brand" maxlength="60" placeholder="e.g. Carrier">`)}
          ${field("Model (optional)", `<input name="model" maxlength="60" placeholder="e.g. FP-53CAS010">`)}
          ${field("Category", `<select name="category" class="select">${CATEGORIES.map((c) => `<option value="${c}">${c[0].toUpperCase()}${c.slice(1)}</option>`).join("")}</select>`)}
          ${field("Power (watts)", `<input name="watts" type="number" min="0" max="20000" step="any" placeholder="e.g. 150">`, { hint: "Check label or manual. Leave blank if label has verified kWh/month." })}
          ${field("Tested energy (kWh/month, optional)", `<input name="testedKwhMonth" type="number" min="0.1" max="5000" step="any" placeholder="e.g. 26.10">`, { hint: "From manufacturer energy guide or efficiency label." })}
          ${field("Energy efficiency rating (optional)", `<input name="energyEfficiencyRating" type="number" min="1" max="10000" step="any" placeholder="e.g. 253">`, { hint: "EER or star rating (dimensionless, not watts)." })}
          <div class="field full" data-slot="wattage-status"></div>
          ${field("Quantity", `<input name="quantity" type="number" min="1" max="50" step="1" value="1" required>`)}
          ${field("Hours used per day", `<input name="hoursPerDay" type="number" min="0" max="24" step="0.25" value="8" required>`)}
          ${field("Days used per week", `<input name="daysPerWeek" type="number" min="0" max="7" step="0.5" value="7" required>`)}
          ${field("Usage schedule (optional)", `<input name="scheduleNote" maxlength="200" placeholder="e.g. 9 PM – 5 AM on weeknights">`, { full: true })}
          <div class="field full">
            <div class="live-calc-box">
              <div class="live-calc-foot">${kindBadge("estimate")} Estimated consumption:</div>
              <div class="live-calc-value" data-slot="appliance-live-kwh">0.00 kWh / month</div>
              <div class="live-calc-foot" data-slot="appliance-live-basis">Enter wattage or energy label consumption to view estimate.</div>
            </div>
          </div>
          <div class="field full"><button class="btn btn-primary" type="submit">Save appliance</button></div>
        </form>`)}
      ${ctx.panel("Estimated monthly usage", slot("appliance-summary"))}
    </div>
    <div style="margin-top:14px">${ctx.panel("Registered appliances", slot("appliances"))}</div>`;
}

async function loadAppliances(_ctx, root) {
  const appliances = await listAppliances();
  const form = root.querySelector('[data-form="appliance-save"]');
  if (form) {
    form.addEventListener("input", () => updateLiveEstimate(root));
    updateLiveEstimate(root);
  }

  if (scannerState && scannerState.canvas) {
    renderScannerPreview(root, scannerState);
  }

  if (!appliances.length) {
    fill(root, "appliance-summary", `${kindBadge("sample")}<p class="muted-note">No appliances yet. The sample household below shows how estimates look.</p>`);
    fill(root, "appliances", `${kindBadge("sample")}${table(
      ["Appliance", "Est. kWh / month"],
      SAMPLE_APPLIANCES.map(([name, kwh]) => [name, formatKwh(kwh)]),
    )}`);
    return;
  }
  const rows = appliances.map((a) => {
    const kwh = estimateMonthlyKwh(a);
    return { a, kwh };
  });
  const total = rows.reduce((sum, row) => sum + row.kwh, 0);
  fill(root, "appliance-summary", `
    <div class="bill-amount">${formatKwh(total)} kWh</div>
    <p class="stat-foot">${kindBadge("estimate")} Estimated per average month across ${appliances.length} appliance entr${appliances.length === 1 ? "y" : "ies"}.</p>`);
  fill(root, "appliances", table(
    ["Appliance", "Power / Rating", "Schedule", "Est. kWh / month", ""],
    rows.sort((x, y) => y.kwh - x.kwh).map(({ a, kwh }) => [
      `<b>${user(a.name)}</b>${a.brand || a.model ? `<div class="muted-note">${user([a.brand, a.model].filter(Boolean).join(" · "))}</div>` : ""}<div class="muted-note">${user(a.category)}</div>`,
      a.watts > 0
        ? `${user(a.quantity)} × ${user(a.watts)} W${a.voltage ? ` <small class="muted-note">(${user(a.voltage)})</small>` : ""}`
        : `${user(a.quantity)} × ${user(a.testedKwhMonth)} kWh/mo (Energy Label)`,
      a.watts > 0
        ? `${user(a.hoursPerDay)} h/day · ${user(a.daysPerWeek)} days/week${a.scheduleNote ? `<div class="muted-note">${user(a.scheduleNote)}</div>` : ""}`
        : `Continuous${a.scheduleNote ? `<div class="muted-note">${user(a.scheduleNote)}</div>` : ""}`,
      `${formatKwh(kwh)} ${kindBadge("estimate")}${a.energyEfficiencyRating ? `<div class="muted-note">EER: ${user(a.energyEfficiencyRating)}</div>` : ""}`,
      `<button class="btn btn-outline btn-small" data-act="appliance-delete" data-id="${encodeURIComponent(a.id)}">Remove</button>`,
    ]),
  ));
}

// ------------------------------------------------------------- simulator
function simulatorPage(ctx) {
  return `
    ${ctx.pageHead("Savings simulator", "See how changing your appliance schedules could change your bill.")}
    ${notice("info", `${kindBadge("estimate")} Results are estimates from your appliance list and the rate you enter. Your actual bill depends on your utility's charges.`)}
    ${ctx.panel("Plan changes", slot("simulator"))}
    <div style="margin-top:14px">${ctx.panel("Result", `<div data-slot="simulation-result"><p class="muted-note">Adjust hours and press Simulate.</p></div>`)}</div>
    <div style="margin-top:14px">${ctx.panel("My savings plans", slot("plans"))}</div>`;
}

async function loadSimulator(ctx, root) {
  const [appliances, bills, plans] = await Promise.all([listAppliances(), listBills(), listSavingsPlans()]);
  const latest = [...bills].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const rate = effectiveRateCentavosPerKwh(latest);
  if (!appliances.length) {
    fill(root, "simulator", `<p class="muted-note">Add appliances first so the simulator has something to work with.</p>
      <button class="btn btn-primary" data-page="devices">Add appliances</button>`);
  } else {
    fill(root, "simulator", `
      <form data-form="simulate" class="form-grid">
        ${field("Your rate (₱ per kWh)", `<input name="rate" inputmode="decimal" required value="${rate ? (rate / 100).toFixed(2) : ""}" placeholder="e.g. 12.25">`, {
          hint: rate ? `From your ${latest.periodStart} – ${latest.periodEnd} bill (amount ÷ kWh).` : "Divide your bill's total amount by its kWh. SmartWatts does not assume a universal rate.",
        })}
        <div class="field full">${table(
          ["Appliance", "Current hours/day", "Planned hours/day"],
          appliances.map((a) => [
            user(a.name),
            user(a.hoursPerDay),
            `<input aria-label="Planned hours per day for ${ctx.escape(a.name)}" name="hours:${encodeURIComponent(a.id)}" type="number" min="0" max="24" step="0.25" value="${a.hoursPerDay}">`,
          ]),
        )}</div>
        <div class="field full"><button class="btn btn-primary" type="submit">Simulate</button></div>
      </form>`);
  }
  fill(root, "plans", table(
    ["Plan", "Changes", "Est. monthly savings", ""],
    plans.map((p) => [
      user(p.title),
      p.actions.map((x) => `${user(x.applianceName)}: ${user(x.fromHours)} → ${user(x.toHours)} h`).join("<br>"),
      `${formatKwh(p.monthlyKwhSaved)} kWh · ${formatPeso(p.monthlySavingsCentavos)} ${kindBadge("estimate")}`,
      `<button class="btn btn-outline btn-small" data-act="plan-delete" data-id="${encodeURIComponent(p.id)}">Delete</button>`,
    ]),
    "No saved plans yet.",
  ));
  if (!root.isStale) {
    ctx.state.appliances = appliances;
    ctx.state.latestBill = latest ?? null;
  }
}

// ---------------------------------------------------------------- bills
function billsPage(ctx) {
  return `
    ${ctx.pageHead("Bill upload & history", "Scan your electricity bill or type the figures, then keep a private history.")}
    <div class="two-panels">
      ${ctx.panel("Add a bill", `
        <label class="upload-drop">
          <input type="file" accept="image/*" class="sr-only" data-ocr="personal-bill">
          <span>Upload bill photo (OCR runs in your browser)</span>
        </label>
        <p class="muted-note" data-slot="ocr-status"></p>
        <p class="muted-note privacy-note">🔒 Privacy: the photo is read on this device and is never uploaded or stored. SmartWatts keeps only the billing figures you confirm below — not your name, address, account, or meter numbers.</p>
        <form class="form-grid" data-form="bill-save">
          <input type="hidden" name="source" value="manual">
          ${field("Period start", `<input name="periodStart" type="date" required>`)}
          ${field("Period end", `<input name="periodEnd" type="date" required max="${todayIso()}">`)}
          ${field("Billed kWh", `<input name="kwh" inputmode="decimal" required>`)}
          ${field("Total current charges (₱)", `<input name="amount" inputmode="decimal" required>`, { hint: "This month's charges, excluding any previous unpaid balance." })}
          ${field("Previous meter reading (optional)", `<input name="previousReading" inputmode="decimal">`)}
          ${field("Present meter reading (optional)", `<input name="presentReading" inputmode="decimal">`)}
          <details class="field full charge-breakdown">
            <summary>Charge breakdown (optional, ₱ — enter credits as negative)</summary>
            <div class="share-grid">${CHARGE_CATEGORIES.map((c) => `<label>${c.label}<input name="component:${c.id}" inputmode="decimal"></label>`).join("")}</div>
            <p class="muted-note">With a breakdown, the savings simulator can show savings per charge category.</p>
          </details>
          <label class="field full bill-verification"><span><input name="verified" type="checkbox" required> I reviewed this bill or statement and confirm its billing period and kWh value are correct.</span></label>
          <div class="field full"><button class="btn btn-primary" type="submit">Save bill</button></div>
        </form>
        <div data-slot="ocr-review"></div>
        <p class="muted-note">Always check OCR suggestions against your printed bill before saving.</p>`)}
      ${ctx.panel("Your average rate", slot("bill-rate"))}
    </div>
    <div style="margin-top:14px">${ctx.panel("Billing history", slot("bills"))}</div>`;
}

async function loadBills(_ctx, root) {
  const bills = (await listBills()).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const latestRate = effectiveRateCentavosPerKwh(bills[0]);
  fill(root, "bill-rate", latestRate
    ? `<div class="bill-amount">${formatPeso(Math.round(latestRate))}<small>/kWh</small></div><p class="stat-foot">${kindBadge("official_utility_bill")} Calculated from your latest bill (amount ÷ kWh).</p>`
    : `<p class="muted-note">Save a bill to see your own average cost per kWh.</p>`);
  fill(root, "bills", bills.length
    ? table(["Billing period", "Consumption", "Amount", "Avg. rate", "Source", ""], bills.map((b) => [
      `${user(b.periodStart)} – ${user(b.periodEnd)}`,
      `${user(b.kwh)} kWh`,
      `<b>${formatPeso(b.amountCentavos)}</b>`,
      `${formatPeso(Math.round(effectiveRateCentavosPerKwh(b) ?? 0))}/kWh${b.components ? `<details class="calc-details"><summary>Breakdown</summary>${Object.entries(b.components).map(([k, v]) => `${categoryLabel(k)}: ${formatPeso(v)}`).join("<br>")}</details>` : ""}`,
      b.source === "ocr" ? "Scanned & reviewed" : "Typed",
      `<button class="btn btn-outline btn-small" data-act="bill-delete" data-id="${encodeURIComponent(b.id)}">Delete</button>`,
    ]))
    : `${kindBadge("sample")}<p class="muted-note">No bills saved yet. Add your first bill above.</p>`);
}

// ----------------------------------------------------------------- plans
function plansPage(ctx) {
  return `
    ${ctx.pageHead("SmartWatts plans", "Two simple tiers. No hardware required.")}
    ${slot("plan-cards")}`;
}

async function loadPlans(_ctx, root) {
  let plans = FALLBACK_PLANS;
  try {
    const response = await fetch("/api/plans");
    if (response.ok) plans = await response.json();
  } catch {
    plans = FALLBACK_PLANS;
  }
  const [personal, rentals] = plans.tiers;
  fill(root, "plan-cards", `
    <div class="grid plan-grid">
      <section class="panel plan-card">
        <p class="eyebrow">Tier 1</p><h3>${personal.name}</h3>
        <div class="bill-amount">Free <small>forever</small></div>
        <ul class="plan-list">
          <li>Bill upload with in-browser OCR</li><li>Appliance registration and usage estimates</li>
          <li>Savings simulator and saved plans</li><li>AI Energy Advisor</li>
          <li>Billing history and personal analytics</li><li>English and Filipino</li>
        </ul>
        <button class="btn btn-outline" data-page="dashboard">Open my dashboard</button>
      </section>
      <section class="panel plan-card plan-featured">
        <p class="eyebrow">Tier 2</p><h3>${rentals.name}</h3>
        <div class="bill-amount">${formatPeso(rentals.priceCentavos)} <small>per property / month</small></div>
        <p class="stat-foot">Up to ${rentals.unitLimit} rental units per property. Proposed pricing.</p>
        <ul class="plan-list">
          <li>Properties, units, and tenant invitations with QR onboarding</li>
          <li>Individual, shared, and private submeter support</li>
          <li>Manual and photo-assisted meter readings with correction history</li>
          <li>Transparent tenant statements with reconciliation</li>
          <li>Tenants join free and keep their appliance data private</li>
        </ul>
        <button class="btn btn-primary" data-page="rentals-start">Set up a rental property</button>
        <p class="muted-note">${plans.paymentsEnabled ? "" : "Online payment is not enabled. Subscriptions are activated manually by SmartWatts staff."}</p>
      </section>
    </div>
    ${notice("info", "SmartWatts does not use IoT cameras or smart-meter hardware. Readings come from official bills and people who read their meters.")}`);
}

// ------------------------------------------------------- account & auth
function accountSecurityHtml() {
  const account = currentAccount();
  if (!firebaseConfigured) {
    return notice("info", "Firebase is not configured, so the app runs in local demo mode. Personal data stays on this device and SmartWatts Rentals is unavailable.");
  }
  const pendingInvite = sessionStorage.getItem(PENDING_INVITE_KEY);
  if (account.permanent) {
    return `
      <div class="detail-list">
        <div class="detail-row"><span>Signed in as</span><b>${user(account.email ?? "Google account")}</b></div>
        <div class="detail-row"><span>Email verified</span><b>${account.emailVerified ? "Yes" : "Not yet"}</b></div>
        <div class="detail-row"><span>Personal workspace</span><b>SmartWatts Personal · Free</b></div>
      </div>
      <div class="toolbar" style="margin-top:12px">
        ${pendingInvite ? `<button class="btn btn-primary" data-page="join">Continue to your rental invitation</button>` : ""}
        ${account.emailVerified ? "" : `<button class="btn btn-outline" data-act="resend-verification">Resend verification email</button>`}
        <button class="btn btn-outline" data-act="sign-out">Sign out</button>
      </div>`;
  }
  return `
    <p class="stat-foot">You are using a free guest session on this device. Create a permanent account to keep your data, use SmartWatts on other devices, and join or manage rental properties. Your existing personal data is kept.</p>
    ${pendingInvite ? notice("info", "Create or sign in to a permanent account to accept your rental invitation.") : ""}
    <div class="two-panels">
      <form class="form-grid" data-form="account-create">
        <h4 class="full">Create account</h4>
        ${field("Display Name", `<input name="displayName" type="text" required autocomplete="name" placeholder="e.g. Maria Santos">`, { full: true })}
        ${field("Home setup", `<select name="dwellingType" required><option value="homeowner">Tier 1 · Personal homeowner</option><option value="condo_apartment">Tier 2 · Condo / apartment resident</option></select>`, { full: true })}
        ${field("Monthly bill source", `<select name="utilityRecordType" required><option value="meralco_bill">Meralco electricity bill</option><option value="condo_soa">Condo / apartment statement of account</option><option value="submeter_slip">Sub-meter reading slip</option></select>`, { full: true })}
        ${field("Baseline monthly consumption (kWh)", `<input name="baselineKwh" type="number" min="0.01" max="1000000" step="0.01" required inputmode="decimal" placeholder="e.g. 250">`, { full: true, hint: "Use the latest verified bill or statement so SmartWatts has a starting point." })}
        ${field("Baseline billing period end", `<input name="baselinePeriodEnd" type="date" required>`, { full: true })}
        ${field("Email", `<input name="email" type="email" required autocomplete="email">`, { full: true })}
        ${field("Password", `<input name="password" type="password" minlength="8" required autocomplete="new-password">`, { full: true })}
        <div class="field full"><button class="btn btn-primary" type="submit">Create account &amp; keep my data</button></div>
      </form>
      <form class="form-grid" data-form="account-sign-in">
        <h4 class="full">Already have an account?</h4>
        ${field("Email", `<input name="email" type="email" required autocomplete="email">`, { full: true })}
        ${field("Password", `<input name="password" type="password" required autocomplete="current-password">`, { full: true })}
        <div class="field full"><button class="btn btn-outline" type="submit">Sign in</button></div>
        <p class="muted-note full">Signing in to a different account switches away from this guest session's data.</p>
      </form>
    </div>
    <button class="btn btn-outline" data-act="google-sign-in">Continue with Google</button>`;
}

async function loadAccount(_ctx, root) {
  fill(root, "account-security", accountSecurityHtml());
}

// ------------------------------------------------------- rentals entry
function rentalsStartPage(ctx) {
  return `
    ${ctx.pageHead("SmartWatts Rentals", "Transparent rental electricity management — no IoT devices needed.")}
    ${notice("warning", LEGAL_NOTICE)}
    ${slot("rentals-start")}`;
}

async function loadRentalsStart(ctx, root) {
  await loadWorkspaces();
  const { status, error } = getRentalsStatus();
  if (status === "unconfigured") {
    fill(root, "rentals-start", notice("info", "SmartWatts Rentals needs Firebase and the SmartWatts API to be configured."));
    return;
  }
  if (status === "needs-account") {
    fill(root, "rentals-start", `${notice("info", "Rentals requires a permanent account (email or Google). Your free personal data is kept when you upgrade.")}
      <button class="btn btn-primary" data-page="account">Create or sign in to an account</button>`);
    return;
  }
  if (status === "unavailable") {
    fill(root, "rentals-start", notice("danger", `Rentals is unavailable right now: ${ctx.escape(error)}`));
    return;
  }
  const memberships = getMemberships();
  fill(root, "rentals-start", `
    <div class="two-panels">
      ${ctx.panel("Your properties", table(
        ["Property", "Role", ""],
        memberships.map((m) => [
          user(m.propertyName),
          m.role === "tenant" ? `Tenant${m.unitLabel ? ` · ${user(m.unitLabel)}` : ""}` : m.role === "owner" ? "Owner" : "Administrator",
          `<button class="btn btn-outline btn-small" data-act="open-workspace" data-id="${encodeURIComponent(m.propertyId)}">Open</button>`,
        ]),
        "You are not a member of any rental property yet.",
      ))}
      ${ctx.panel("Add a property (owners)", `
        <form class="form-grid" data-form="property-create">
          ${field("Property name", `<input name="name" required maxlength="120">`, { full: true })}
          ${field("Address", `<input name="address" required maxlength="240">`, { full: true })}
          <div class="field full"><button class="btn btn-primary" type="submit">Create property</button></div>
          <p class="muted-note full">New properties start inactive. Request activation from the Subscription page; no payment is collected in the app.</p>
        </form>`)}
    </div>
    <div style="margin-top:14px">${ctx.panel("Tenants: join with an invitation", `
      <form class="form-grid" data-form="invite-code">
        ${field("Invitation code or link", `<input name="code" required autocomplete="off">`, { full: true, hint: "Scan your landlord's QR code, or paste the link or code here." })}
        <div class="field full"><button class="btn btn-outline" type="submit">Continue</button></div>
      </form>
      <p class="muted-note">Tenants never pay a SmartWatts subscription.</p>`)}</div>`);
}

function joinPage(ctx) {
  return `${ctx.pageHead("Rental invitation", "Review the invitation before joining.")}${slot("join")}`;
}

async function loadJoin(ctx, root) {
  const token = sessionStorage.getItem(PENDING_INVITE_KEY);
  if (!token) {
    fill(root, "join", `<p class="muted-note">No invitation found. Open the link or scan the QR code from your landlord again.</p>`);
    return;
  }
  if (!firebaseConfigured) {
    fill(root, "join", notice("info", "Rental invitations need Firebase and the SmartWatts API to be configured."));
    return;
  }
  let preview;
  try {
    preview = await apiPost("/api/rentals/invitations/preview", { token });
  } catch (error) {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    fill(root, "join", notice("danger", ctx.escape(errorMessage(error))));
    return;
  }
  const account = currentAccount();
  fill(root, "join", ctx.panel("Invitation", `
    <div class="detail-list">
      <div class="detail-row"><span>Property</span><b>${user(preview.propertyName)}</b></div>
      <div class="detail-row"><span>Role</span><b>${preview.role === "tenant" ? "Tenant" : "Property administrator"}</b></div>
      ${preview.unitLabel ? `<div class="detail-row"><span>Unit</span><b>${user(preview.unitLabel)}</b></div>` : ""}
      ${preview.moveInDate ? `<div class="detail-row"><span>Move-in date</span><b>${user(preview.moveInDate)}</b></div>` : ""}
      <div class="detail-row"><span>Expires</span><b>${user(new Date(preview.expiresAt).toLocaleString())}</b></div>
    </div>
    ${preview.role === "tenant" ? `<p class="stat-foot">Your landlord will see your account email and your official electricity statements. Your appliances, schedules, savings plans, and AI chats stay private.</p>` : ""}
    ${preview.emailRestricted ? `<p class="muted-note">This invitation is for a specific verified email address.</p>` : ""}
    ${account.permanent
      ? `<div class="toolbar"><button class="btn btn-primary" data-act="invite-accept">Accept invitation</button><button class="btn btn-outline" data-act="invite-dismiss">Not now</button></div>`
      : `${notice("info", "Create a permanent account first. Your personal data is kept.")}<button class="btn btn-primary" data-page="account">Create account</button>`}`));
}

export function readInviteFromHash() {
  const match = window.location.hash.match(/^#join=([A-Za-z0-9_-]{20,200})$/);
  if (!match) return false;
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, match[1]);
  } catch {
    return false;
  }
  // Remove the secret token from the address bar and browser history.
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}

function inviteTokenFromInput(value) {
  const trimmed = String(value).trim();
  const fromLink = trimmed.match(/#join=([A-Za-z0-9_-]{20,200})/);
  if (fromLink) return fromLink[1];
  return /^[A-Za-z0-9_-]{20,200}$/.test(trimmed) ? trimmed : null;
}

// ----------------------------------------------------------- registries
export const personalPages = {
  devices: { title: "My Appliances", subtitle: "Track appliances and estimated energy use.", render: appliancesPage, load: loadAppliances },
  simulator: { title: "Savings Simulator", subtitle: "Try schedule changes and estimate savings.", render: simulatorPage, load: loadSimulator },
  bills: { title: "Bill Upload & History", subtitle: "Scan or type your bills and keep a private history.", render: billsPage, load: loadBills },
  plans: { title: "Plans", subtitle: "SmartWatts Personal and SmartWatts Rentals.", render: plansPage, load: loadPlans },
  "rentals-start": { title: "SmartWatts Rentals", subtitle: "Manage rental electricity transparently.", render: rentalsStartPage, load: loadRentalsStart },
  join: { title: "Rental Invitation", subtitle: "Join a rental property.", render: joinPage, load: loadJoin },
};

export const personalLoaders = { account: loadAccount };

export const personalForms = {
  async "appliance-save"(form, ctx) {
    const v = formValues(form);
    const watts = Number(v.watts || 0);
    const testedKwhMonth = v.testedKwhMonth ? Number(v.testedKwhMonth) : null;
    if (watts <= 0 && (!testedKwhMonth || testedKwhMonth <= 0)) {
      throw new Error("Enter either appliance wattage (W) or verified energy consumption (kWh/month).");
    }
    await saveAppliance({
      name: String(v.name),
      category: String(v.category),
      watts,
      quantity: Number(v.quantity),
      hoursPerDay: Number(v.hoursPerDay || 0),
      daysPerWeek: Number(v.daysPerWeek || 7),
      scheduleNote: String(v.scheduleNote || ""),
      brand: v.brand ? String(v.brand) : null,
      model: v.model ? String(v.model) : null,
      voltage: v.voltage ? String(v.voltage) : null,
      source: v.source === "ocr" ? "ocr" : v.source === "ai" ? "ai" : "manual",
      testedKwhMonth,
      energyEfficiencyRating: v.energyEfficiencyRating ? Number(v.energyEfficiencyRating) : null,
      labelType: v.labelType ? String(v.labelType) : null,
      consumptionBasis: v.consumptionBasis ? String(v.consumptionBasis) : null,
    });
    scannerState = null;
    ctx.toast("Appliance saved.");
    window.dispatchEvent(new CustomEvent("smartwatts-appliance-saved", { detail: String(v.name) }));
    ctx.render();
  },
  async simulate(form, ctx) {
    const data = new FormData(form);
    const rateCentavos = parsePesoToCentavos(String(data.get("rate") ?? ""));
    if (!rateCentavos) throw new Error("Enter your rate per kWh in pesos, e.g. 12.25.");
    const appliances = ctx.state.appliances ?? [];
    const changes = appliances.map((a) => ({ applianceId: a.id, hoursPerDay: Number(data.get(`hours:${encodeURIComponent(a.id)}`)) }));
    const result = simulateSavings(appliances, changes, rateCentavos);
    // All peso figures come from the deterministic billing engine. Use the latest bill's per-category
    // averages when it has a breakdown and the person kept its derived rate; otherwise the typed rate.
    const latest = ctx.state.latestBill;
    const derived = latest ? effectiveRateCentavosPerKwh(latest) : null;
    const usesBill = Boolean(latest?.components && derived && Math.abs(Math.round(derived) - rateCentavos) <= 1);
    const comparison = compareScenario(result.currentKwh, result.plannedKwh, usesBill ? deriveRateProfile(latest) : enteredRateProfile(rateCentavos));
    result.savedCentavos = comparison.savingsCentavos;
    lastSimulation = { result, rateCentavos, appliances, changes };
    const root = document.querySelector("#content");
    const breakdown = usesBill ? table(
      ["Charge category", "Current (est.)", "Planned (est.)", "Difference"],
      Object.keys(comparison.current.byCategory).map((key) => [
        categoryLabel(key), formatPeso(comparison.current.byCategory[key]), formatPeso(comparison.planned.byCategory[key]), formatPeso(comparison.savingsByCategory[key]),
      ]),
    ) : "";
    fill(root, "simulation-result", `
      <div class="grid stats">
        ${ctx.stat("gauge", "Current estimate", formatKwh(result.currentKwh), "kWh/mo", "Estimate", "")}
        ${ctx.stat("target", "Planned estimate", formatKwh(result.plannedKwh), "kWh/mo", "Estimate", "")}
        ${ctx.stat("trending-down", "Estimated savings", formatPeso(result.savedCentavos), "", `${formatKwh(result.savedKwh)} kWh per month`, "")}
      </div>
      <p class="stat-foot">${kindBadge("estimate")} Estimated monthly charges: ${formatPeso(comparison.current.totalCentavos)} now → ${formatPeso(comparison.planned.totalCentavos)} planned (appliance estimates only, not your full bill).</p>
      ${breakdown}
      <details class="calc-details"><summary>Calculation assumptions</summary><ul>${comparison.assumptions.map((a) => `<li>${ctx.escape(a)}</li>`).join("")}</ul></details>
      ${result.savedKwh > 0 ? `<form class="form-grid" data-form="plan-save" style="margin-top:12px">
        ${field("Save as plan", `<input name="title" required maxlength="80" placeholder="e.g. Cooler nights">`)}
        <div class="field"><button class="btn btn-primary" type="submit">Save plan</button></div>
      </form>` : `<p class="muted-note">Lower some planned hours to see savings.</p>`}`);
    ctx.translate(root);
  },
  async "plan-save"(form, ctx) {
    if (!lastSimulation) throw new Error("Run a simulation first.");
    const { result, rateCentavos, appliances, changes } = lastSimulation;
    const actions = changes
      .map((change) => ({ change, appliance: appliances.find((a) => a.id === change.applianceId) }))
      .filter(({ change, appliance }) => appliance && appliance.hoursPerDay !== change.hoursPerDay)
      .map(({ change, appliance }) => ({ applianceId: appliance.id, applianceName: appliance.name, fromHours: appliance.hoursPerDay, toHours: change.hoursPerDay }));
    await saveSavingsPlan({
      title: String(formValues(form).title), actions, monthlyKwhSaved: result.savedKwh,
      monthlySavingsCentavos: Math.max(0, result.savedCentavos), ratePerKwhCentavos: rateCentavos,
    });
    lastSimulation = null;
    ctx.toast("Savings plan saved.");
    window.dispatchEvent(new CustomEvent("smartwatts-plan-saved", { detail: String(formValues(form).title) }));
    ctx.render();
  },
  async "bill-save"(form, ctx) {
    const v = formValues(form);
    const amountCentavos = parsePesoToCentavos(String(v.amount));
    if (amountCentavos === null) throw new Error("Enter the amount in pesos, e.g. 1,256.34.");
    const components = {};
    for (const category of CHARGE_CATEGORIES) {
      const raw = String(v[`component:${category.id}`] ?? "").trim();
      if (!raw) continue;
      const negative = /^\(.*\)$|^-/.test(raw);
      const centavos = parsePesoToCentavos(raw.replace(/[()-]/g, ""));
      if (centavos === null) throw new Error(`Check the ${category.label} amount.`);
      components[category.id] = negative ? -centavos : centavos;
    }
    const reading = (value) => (String(value ?? "").trim() ? Number(String(value).replace(/,/g, "")) : null);
    await saveBill({
      periodStart: String(v.periodStart), periodEnd: String(v.periodEnd), kwh: Number(String(v.kwh).replace(/,/g, "")),
      amountCentavos, source: v.source === "ocr" ? "ocr" : "manual",
      components: Object.keys(components).length ? components : null,
      previousReading: reading(v.previousReading), presentReading: reading(v.presentReading),
    });
    if (Object.keys(components).length) {
      const check = reconcileBill(amountCentavos, components);
      ctx.toast(check.balanced
        ? "Bill saved. The charge breakdown matches the total."
        : `Bill saved. Note: the breakdown differs from the total by ${formatPeso(check.differenceCentavos)} — check for a missing line.`);
    } else {
      ctx.toast("Bill saved.");
    }
    window.dispatchEvent(new CustomEvent("smartwatts-bill-saved", { detail: { periodStart: v.periodStart, periodEnd: v.periodEnd, kwh: Number(String(v.kwh).replace(/,/g, "")), verified: v.verified === "on" } }));
    ctx.render();
  },
  async "account-create"(form, ctx) {
    const v = formValues(form);
    const displayName = String(v.displayName || "").trim();
    const baselineKwh = Number(v.baselineKwh);
    if (!Number.isFinite(baselineKwh) || baselineKwh <= 0 || baselineKwh > 1_000_000) throw new Error("Enter a valid baseline monthly consumption in kWh.");
    if (!["homeowner", "condo_apartment"].includes(String(v.dwellingType))) throw new Error("Choose your home setup.");
    if (!["meralco_bill", "condo_soa", "submeter_slip"].includes(String(v.utilityRecordType))) throw new Error("Choose your monthly bill source.");
    if (v.dwellingType === "homeowner" && v.utilityRecordType !== "meralco_bill") throw new Error("Homeowner baseline records must use a Meralco electricity bill.");
    if (v.dwellingType === "condo_apartment" && v.utilityRecordType === "meralco_bill") throw new Error("Choose a condo statement or sub-meter slip for a condo or apartment setup.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.baselinePeriodEnd))) throw new Error("Choose the end date of your baseline billing period.");
    let registration;
    try {
      registration = await createPermanentAccount(String(v.email), String(v.password), displayName);
    } catch (error) {
      throw new Error(friendlyAuthError(error));
    }

    let profileSaved = false;
    try {
      profileSaved = await saveUserProfile({
        displayName,
        preferredLanguage: document.querySelector("#ui-language")?.value || "en",
        dwellingType: String(v.dwellingType),
        utilityRecordType: String(v.utilityRecordType),
        baselineKwh,
        baselinePeriodEnd: String(v.baselinePeriodEnd),
      });
    } catch {
      profileSaved = false;
    }
    await ctx.accountChanged();
    if (!profileSaved) {
      ctx.toast("Your account is signed in, but SmartWatts could not save your profile. Please retry after checking your connection.");
      return;
    }
    if (!registration.verificationEmailSent) {
      ctx.toast("Account created and profile saved, but Firebase could not send the verification email. You can retry from Account Settings.");
      return;
    }
    if (!registration.displayNameUpdated) {
      ctx.toast("Account created and profile saved, but Firebase could not update the Auth display name.");
      return;
    }
    ctx.toast("Account created. Check your inbox to verify your email.");
  },
  async "account-sign-in"(form, ctx) {
    const v = formValues(form);
    let signedInUser;
    try {
      signedInUser = await signInPermanent(String(v.email), String(v.password));
    } catch (error) {
      throw new Error(friendlyAuthError(error));
    }
    let profileSaved = false;
    try {
      profileSaved = await ensureUserProfile({
        displayName: signedInUser.displayName,
        preferredLanguage: document.querySelector("#ui-language")?.value || "en",
      });
    } catch {
      profileSaved = false;
    }
    await ctx.accountChanged();
    ctx.toast(profileSaved ? "Signed in." : "Signed in, but SmartWatts could not restore your profile. Please check your connection.");
  },
  async "property-create"(form, ctx) {
    const v = formValues(form);
    const property = await apiPost("/api/rentals/properties", { name: v.name, address: v.address });
    await loadWorkspaces();
    setWorkspace({ propertyId: property.id });
    ctx.toast("Property created.");
    ctx.navigate("rental-overview");
  },
  async "invite-code"(form, ctx) {
    const token = inviteTokenFromInput(formValues(form).code);
    if (!token) throw new Error("That does not look like a SmartWatts invitation code.");
    sessionStorage.setItem(PENDING_INVITE_KEY, token);
    ctx.navigate("join");
  },
};

export const personalActions = {
  async "scanner-rotate-cw"(_button, ctx) {
    if (!scannerState || !scannerState.rawImage) return;
    scannerState.rotation = (scannerState.rotation + 90) % 360;
    scannerState.canvas = rotateCanvas(scannerState.rawImage, scannerState.rotation);
    const root = document.querySelector("#content");
    renderScannerPreview(root, scannerState);
    await runApplianceOcr(ctx, root);
  },
  async "scanner-rotate-ccw"(_button, ctx) {
    if (!scannerState || !scannerState.rawImage) return;
    scannerState.rotation = (scannerState.rotation - 90 + 360) % 360;
    scannerState.canvas = rotateCanvas(scannerState.rawImage, scannerState.rotation);
    const root = document.querySelector("#content");
    renderScannerPreview(root, scannerState);
    await runApplianceOcr(ctx, root);
  },
  "scanner-discard"(_button, ctx) {
    scannerState = null;
    const root = document.querySelector("#content");
    fill(root, "scanner-preview", "");
    fill(root, "wattage-status", "");
    ctx.toast("Scan image discarded.");
  },
  "scanner-manual-mode"(_button, ctx) {
    const root = document.querySelector("#content");
    const nameInput = root?.querySelector('[data-form="appliance-save"] input[name="name"]');
    if (nameInput) {
      nameInput.focus();
      nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    ctx.toast("Enter appliance details below.");
  },
  "scanner-choose-watt"(button, ctx) {
    const watts = button.dataset.watts;
    const root = document.querySelector("#content");
    const wattsInput = root?.querySelector('[data-form="appliance-save"] input[name="watts"]');
    if (wattsInput) {
      wattsInput.value = watts;
      updateLiveEstimate(root);
    }
    ctx.toast(`Selected ${watts} W.`);
  },
  async "scanner-ai-assist"(_button, ctx) {
    if (!scannerState || !scannerState.canvas) {
      throw new Error("Scan or upload a label photo first.");
    }
    const root = document.querySelector("#content");
    const progressArea = root.querySelector("#scannerProgressArea");
    const progressFill = root.querySelector("#scannerProgressFill");
    const progressText = root.querySelector("#scannerProgressText");
    if (progressArea) {
      progressArea.style.display = "";
      if (progressFill) progressFill.style.width = "50%";
      if (progressText) progressText.textContent = "Analyzing image with Gemini Vision…";
    }

    try {
      const dataUrl = scannerState.canvas.toDataURL("image/jpeg", 0.9);
      const base64 = dataUrl.split(",")[1];
      const result = await apiPost("/api/ai/appliance-label", { image_base64: base64, mime_type: "image/jpeg" });

      const form = root.querySelector('[data-form="appliance-save"]');
      if (form) {
        if (result.brand && !form.elements.brand.value) form.elements.brand.value = result.brand;
        if (result.model && !form.elements.model.value) form.elements.model.value = result.model;
        if (result.appliance_type && !form.elements.name.value) form.elements.name.value = result.appliance_type;
        if (result.watts !== null && result.watts > 0) form.elements.watts.value = result.watts;
        if (result.voltage) form.elements.voltage.value = result.voltage;
        if (result.tested_kwh_month) form.elements.testedKwhMonth.value = result.tested_kwh_month;
        form.elements.source.value = "ai";
      }

      fill(root, "wattage-status", `
        ${notice("info", `✨ <b>Gemini Vision Analysis:</b><br>${ctx.escape(result.evidence || "Specification detected.")} ${result.notes ? `<br><small>${ctx.escape(result.notes)}</small>` : ""}`)}
        ${result.tested_kwh_month ? `<div class="tested-energy-card">💡 Manufacturer Tested Energy: <b>${result.tested_kwh_month} kWh/month</b></div>` : ""}
      `);

      updateLiveEstimate(root);
      ctx.toast("AI analysis complete! Please review and confirm before saving.");
    } catch (error) {
      ctx.toast(errorMessage(error));
    } finally {
      if (progressArea) progressArea.style.display = "none";
      ctx.translate(root);
    }
  },
  async "appliance-delete"(button, ctx) {
    await deleteAppliance(decodeURIComponent(button.dataset.id));
    ctx.toast("Appliance removed.");
    ctx.render();
  },
  async "plan-delete"(button, ctx) {
    await deleteSavingsPlan(decodeURIComponent(button.dataset.id));
    ctx.render();
  },
  async "bill-delete"(button, ctx) {
    if (!window.confirm("Delete this bill from your history?")) return;
    await deleteBill(decodeURIComponent(button.dataset.id));
    ctx.render();
  },
  async "google-sign-in"(_button, ctx) {
    let user;
    try {
      user = await continueWithGoogle();
    } catch (error) {
      throw new Error(friendlyAuthError(error));
    }
    let profileSaved = false;
    try {
      profileSaved = await ensureUserProfile({
        displayName: user.displayName,
        preferredLanguage: document.querySelector("#ui-language")?.value || "en",
      });
    } catch {
      profileSaved = false;
    }
    await ctx.accountChanged();
    ctx.toast(profileSaved ? "Signed in with Google." : "Signed in with Google, but SmartWatts could not restore your profile.");
  },
  async "sign-out"(_button, ctx) {
    await signOutAccount();
    setWorkspace(null);
    ctx.toast("Signed out.");
    await ctx.accountChanged();
  },
  async "resend-verification"(_button, ctx) {
    try {
      await resendVerification();
    } catch (error) {
      throw new Error(friendlyAuthError(error));
    }
    ctx.toast("Verification email sent.");
  },
  async "open-workspace"(button, ctx) {
    const membership = getMemberships().find((m) => m.propertyId === decodeURIComponent(button.dataset.id));
    if (!membership) return;
    setWorkspace({ propertyId: membership.propertyId });
    ctx.navigate(membership.role === "tenant" ? "tenant-statements" : "rental-overview");
  },
  async "invite-accept"(_button, ctx) {
    const token = sessionStorage.getItem(PENDING_INVITE_KEY);
    const result = await apiPost("/api/rentals/invitations/accept", { token });
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    await loadWorkspaces();
    setWorkspace({ propertyId: result.propertyId });
    ctx.toast("Invitation accepted.");
    ctx.navigate(result.role === "tenant" ? "tenant-statements" : "rental-overview");
  },
  async "invite-dismiss"(_button, ctx) {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    ctx.navigate("dashboard");
  },
};

export async function handlePersonalBillOcr(input, ctx) {
  const file = input.files?.[0];
  if (!file) return;
  const root = document.querySelector("#content");
  fill(root, "ocr-status", "Reading image in your browser…");
  try {
    const text = await recognizeImage(file);
    const suggestion = extractBillFields(text);
    const form = root.querySelector('[data-form="bill-save"]');
    const set = (name, value) => { if (value !== null && value !== undefined && form.elements[name]) form.elements[name].value = value; };
    set("kwh", suggestion.kwh);
    set("amount", suggestion.amountPesos);
    set("periodStart", suggestion.periodStart);
    set("periodEnd", suggestion.periodEnd);
    set("previousReading", suggestion.previousReading);
    set("presentReading", suggestion.presentReading);
    for (const [category, centavos] of Object.entries(suggestion.components)) set(`component:${category}`, (centavos / 100).toFixed(2));
    if (Object.keys(suggestion.components).length) form.querySelector(".charge-breakdown")?.setAttribute("open", "");
    const found = ["kwh", "amountPesos", "periodStart", "periodEnd"].filter((key) => suggestion[key] !== null);
    if (found.length) form.elements.source.value = "ocr";
    const missing = [["kwh", "kWh"], ["amountPesos", "total charges"], ["periodStart", "billing period"]].filter(([key]) => suggestion[key] === null).map(([, label]) => label);
    fill(root, "ocr-status", found.length
      ? `Suggested values filled in${missing.length ? `; could not read: ${missing.join(", ")}` : ""}. Check every value against your bill.`
      : "Could not find billing figures. Enter the values manually.");
    // Show only a redacted transcript for review; the raw text is discarded with this function.
    fill(root, "ocr-review", `<details class="raw-ocr-drawer"><summary>View recognized text (personal details redacted)</summary><pre translate="no">${ctx.escape(redactBillText(text))}</pre></details>`);
  } catch (error) {
    fill(root, "ocr-status", `${ctx.escape(errorMessage(error))} You can still enter the values manually.`);
  } finally {
    input.value = "";
    ctx.translate(root);
  }
}

export async function handleApplianceLabelScan(input, ctx) {
  const file = input.files?.[0];
  if (!file) return;

  const root = document.querySelector("#content");
  if (!file.type.startsWith("image/")) {
    ctx.toast("Please choose an image file (PNG, JPG, WebP), or enter details manually.");
    input.value = "";
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    ctx.toast("Image file is too large (maximum 15 MB).");
    input.value = "";
    return;
  }

  try {
    const img = new Image();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const cCtx = canvas.getContext("2d");
    if (!cCtx) throw new Error("Could not initialize canvas context.");
    cCtx.drawImage(img, 0, 0);

    scannerState = {
      file,
      rawImage: img,
      rotation: 0,
      canvas,
      specs: null,
      processing: true,
      stage: "Loading OCR model…",
      percent: 15,
    };
    renderScannerPreview(root, scannerState);

    await runApplianceOcr(ctx, root);
  } catch (error) {
    ctx.toast(errorMessage(error));
  } finally {
    input.value = "";
  }
}

