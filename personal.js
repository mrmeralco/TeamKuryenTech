// SmartWatts Personal (Tier 1, free forever) screens plus account sign-in,
// the plans page, and the entry point to SmartWatts Rentals.
import {
  deleteAppliance, deleteBill, deleteSavingsPlan, ensureUserProfile, listAppliances, listBills, listSavingsPlans,
  loadUserProfile, saveAppliance, saveBill, saveSavingsPlan, saveUserProfile, storageMode,
} from "./src/lib/personal/store.ts";
import { effectiveRateCentavosPerKwh, estimateMonthlyKwh, simulateSavings } from "./src/lib/personal/estimates.ts";
import { extractBillFields, redactBillText } from "./src/lib/ocr.ts";
import { photoQuality, scanMeralcoBillPages, toDashboardComponents } from "./src/lib/meralcoScanner.ts";
import { openBillCamera, openCropEditor } from "./src/lib/billCamera.ts";
import { buildIcs, calendarEvents, daysBetween, googleCalendarLink, monthMatrix, predictNext } from "./src/lib/billSchedule.ts";
import { ALL_APPLIANCES, WATTAGE_SOURCE, findAppliancePreset } from "./src/lib/applianceWattage.ts";
import { CHARGE_CATEGORIES, categoryLabel, compareScenario, deriveRateProfile, enteredRateProfile, reconcileBill } from "./src/lib/billing/meralco.ts";
import {
  extractApplianceSpecs, highlightWords, recognizeApplianceLabel, rotateCanvas,
} from "./src/lib/appliance-ocr.ts";
import { escapeHtml, parsePesoToCentavos, formatKwh } from "./src/lib/format.ts";
import {
  continueWithGoogle, createPermanentAccount, currentAccount, friendlyAuthError,
  resendVerification, signInPermanent, signOutAccount,
} from "./src/lib/account.ts";
import { apiPost } from "./src/lib/apiAuth.ts";
import { auth, firebaseConfigured } from "./src/lib/firebase.ts";
import {
  EmailAuthProvider, GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup,
  reload, sendPasswordResetEmail, updateProfile, verifyBeforeUpdateEmail,
} from "firebase/auth";
import { getLanguage, getSupportedLanguages, setLanguage } from "./i18n.js";
import { captureInviteFromHash, hasPendingInvite, PENDING_INVITE_KEY } from "./src/lib/pendingInvite.ts";
import {
  errorMessage, field, fill, formatPeso, formValues, kindBadge, lifecycleBadge, notice, slot, table, user, LEGAL_NOTICE, todayIso,
} from "./ui-kit.js";
import { getMemberships, getRentalsStatus, getWorkspace, loadWorkspaces, setWorkspace } from "./workspace.js";

export { PENDING_INVITE_KEY };
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
        <div class="lens-stage${state.processing ? " lens-scanning" : ""}">
          <canvas class="scanner-preview-img" id="scannerCanvasView"></canvas>
          <div class="lens-layer" data-lens-layer aria-hidden="true"></div>
          <div class="lens-shimmer" aria-hidden="true"></div>
        </div>
        <p class="lens-ai" data-lens-ai aria-live="polite"></p>
        <div class="lens-chips" data-lens-chips></div>
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

// ------------------------------------------------------------------ typical wattage presets
const fmtW = (w) => `${Number(w).toLocaleString("en-PH")} W`;

/** Show the typical wattage for what was typed (or what OCR found), with a one-tap "use" button. */
function showAppliancePreset(root, query, { fromScan = false } = {}) {
  const form = root?.querySelector('[data-form="appliance-save"]');
  if (!form) return;
  const preset = findAppliancePreset(query);
  if (!preset) { fill(root, "appliance-preset-hint", ""); return; }
  if (!fromScan && CATEGORIES.includes(preset.category)) form.elements.category.value = preset.category;
  const hasWatts = Number(form.elements.watts.value) > 0;
  fill(root, "appliance-preset-hint", `
    <div class="preset-hint">
      <span class="preset-icon">💡</span>
      <div>
        <b>${user(preset.name)}</b> usually uses <b>${fmtW(preset.minWatts)}${preset.maxWatts !== preset.minWatts ? `–${fmtW(preset.maxWatts)}` : ""}</b>${preset.standbyWatts ? ` (standby ${preset.standbyWatts} W)` : ""}.
        <small>${fromScan ? "The label’s wattage could not be read, so this is a typical value. " : ""}Typical range — your label or manual is more accurate. Source: <a href="${WATTAGE_SOURCE.url}" target="_blank" rel="noopener">Daft Logic</a>.</small>
      </div>
      <button type="button" class="btn btn-outline btn-small" data-act="preset-use" data-watts="${preset.typicalWatts}" data-hours="${preset.hoursPerDay}">${hasWatts ? "Replace with" : "Use"} ${fmtW(preset.typicalWatts)}</button>
    </div>`);
}

document.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.name !== "name" || !input.closest('[data-form="appliance-save"]')) return;
  showAppliancePreset(document.querySelector("#content"), input.value);
});

function applyPresetWatts(button) {
  const root = document.querySelector("#content");
  const form = root?.querySelector('[data-form="appliance-save"]');
  if (!form) return;
  form.elements.watts.value = button.dataset.watts;
  if (form.elements.consumptionBasis) form.elements.consumptionBasis.value = "wattage";
  // Only replace the default 8 h/day, never a schedule the person typed.
  if (!form.elements.hoursPerDay.value || form.elements.hoursPerDay.value === "8") form.elements.hoursPerDay.value = button.dataset.hours;
  updateLiveEstimate(root);
  button.textContent = "Applied ✓";
}

// ------------------------------------------------------------------ AI identify (Gemini Vision)
// Recognizes WHAT the appliance is from the photo itself (e.g. an electric fan with no label),
// then uses the typical-wattage list when the label gives no rating. Printed specs still win.
const GENERIC_NAMES = new Set(["", "appliance", "other", "unknown"]);

async function identifyApplianceWithAi(ctx, root, { auto }) {
  if (!scannerState?.canvas || !root) return;
  const stage = root.querySelector(".lens-stage");
  const status = root.querySelector("[data-lens-ai]");
  stage?.classList.add("lens-scanning");
  if (status) status.innerHTML = `<span class="lens-ai-spin"></span> Identifying the appliance…`;
  try {
    const base64 = scannerState.canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    const result = await apiPost("/api/ai/appliance-label", { image_base64: base64, mime_type: "image/jpeg" });
    const form = root.querySelector('[data-form="appliance-save"]');
    if (!form) return;
    const typeText = [result.size_hint, result.appliance_type].filter(Boolean).join(" ");
    const preset = findAppliancePreset(typeText) ?? findAppliancePreset(result.appliance_type);
    const currentName = form.elements.name.value.trim().toLowerCase();
    if (result.appliance_type && GENERIC_NAMES.has(currentName)) form.elements.name.value = (preset?.name ?? result.appliance_type).slice(0, 60);
    if (preset && CATEGORIES.includes(preset.category)) form.elements.category.value = preset.category;
    if (result.brand && !form.elements.brand.value) form.elements.brand.value = result.brand;
    if (result.model && !form.elements.model.value) form.elements.model.value = result.model;
    if (result.voltage && !form.elements.voltage.value) form.elements.voltage.value = result.voltage;
    if (result.tested_kwh_month && !form.elements.testedKwhMonth.value) form.elements.testedKwhMonth.value = result.tested_kwh_month;
    const labelWatts = result.watts != null && result.watts > 0;
    if (labelWatts) form.elements.watts.value = result.watts;
    form.elements.source.value = "ai";

    // No printed rating: fill the typical wattage for this kind of appliance (clearly labelled as typical).
    let usedTypical = false;
    if (!labelWatts && !(Number(form.elements.watts.value) > 0) && !form.elements.testedKwhMonth.value && preset) {
      form.elements.watts.value = preset.typicalWatts;
      form.elements.consumptionBasis.value = "wattage";
      if (!form.elements.hoursPerDay.value || form.elements.hoursPerDay.value === "8") form.elements.hoursPerDay.value = preset.hoursPerDay;
      if (!form.elements.scheduleNote.value) form.elements.scheduleNote.value = "Typical wattage — no rating label scanned";
      usedTypical = true;
    }
    if (preset) showAppliancePreset(root, preset.name, { fromScan: !labelWatts });

    const what = result.appliance_type ? `${result.appliance_type}${result.size_hint ? ` (${result.size_hint})` : ""}` : "an appliance";
    const chipRow = root.querySelector(".lens-chip-row") ?? (() => {
      const chips = root.querySelector("[data-lens-chips]");
      if (!chips) return null;
      chips.innerHTML = `<p class="lens-chips-title">Identified from the photo · tap a detail to edit it</p><div class="lens-chip-row"></div>`;
      return chips.querySelector(".lens-chip-row");
    })();
    if (chipRow && result.appliance_type) {
      chipRow.insertAdjacentHTML("afterbegin", `<button type="button" class="lens-chip lens-ai" data-act="lens-focus" data-field="name"><span>🔎</span><small>${result.identified_from === "object" ? "Looks like" : "Appliance"}</small><b>${ctx.escape(what)}</b></button>${usedTypical ? `<button type="button" class="lens-chip lens-watts" data-act="lens-focus" data-field="watts"><span>⚡</span><small>Typical power</small><b>${fmtW(preset.typicalWatts)}</b></button>` : ""}`);
    }
    if (status) {
      status.innerHTML = result.appliance_type
        ? `✨ ${result.identified_from === "object" ? "Recognized from the photo" : "Read from the label"}: <b>${ctx.escape(what)}</b>${usedTypical ? ` — no rating label found, so the typical ${fmtW(preset.typicalWatts)} is filled in. Scan the rating sticker for the exact value.` : ""}`
        : "Couldn’t tell what appliance this is — type the name below.";
    }
    updateLiveEstimate(root);
    if (!auto) ctx.toast("AI analysis complete! Please review and confirm before saving.");
  } catch (error) {
    if (status) status.textContent = auto
      ? `AI identify unavailable (${errorMessage(error)}). Type the appliance name below to get its typical wattage.`
      : errorMessage(error);
    if (!auto) ctx.toast(errorMessage(error));
  } finally {
    stage?.classList.remove("lens-scanning");
    ctx.translate?.(root);
  }
}

// Google Lens-style result: every recognized word gets a soft box on the photo, the words
// behind a detected spec glow orange, and the detected specs appear as chips below.
const LENS_KINDS = {
  brand: { icon: "🏷️", label: "Brand", field: "brand" },
  model: { icon: "#", label: "Model", field: "model" },
  watts: { icon: "⚡", label: "Power", field: "watts" },
  volts: { icon: "🔌", label: "Voltage", field: "voltage" },
  kwh: { icon: "📅", label: "Tested energy", field: "testedKwhMonth" },
  eer: { icon: "⭐", label: "EER", field: "energyEfficiencyRating" },
};

function drawLensResults(root, canvas, words, specs, ctx) {
  root.querySelector(".lens-stage")?.classList.remove("lens-scanning");
  const layer = root.querySelector("[data-lens-layer]");
  const chips = root.querySelector("[data-lens-chips]");
  if (!layer || !canvas?.width) return;
  const hits = highlightWords(words, specs);
  const W = canvas.width, H = canvas.height;
  layer.innerHTML = words.map((w, i) => {
    const kind = hits.get(i);
    const { x0, y0, x1, y1 } = w.bbox;
    const style = `left:${(x0 / W) * 100}%;top:${(y0 / H) * 100}%;width:${((x1 - x0) / W) * 100}%;height:${((y1 - y0) / H) * 100}%;animation-delay:${Math.min(i * 12, 900)}ms`;
    return `<span class="lens-word${kind ? ` lens-hit lens-${kind}` : ""}" style="${style}"${kind ? ` data-act="lens-focus" data-field="${LENS_KINDS[kind].field}" title="${LENS_KINDS[kind].label}"` : ""}></span>`;
  }).join("");
  const values = [
    ["brand", specs.brand],
    ["model", specs.model],
    ["watts", specs.watts != null ? `${specs.watts} W` : null],
    ["volts", specs.voltage],
    ["kwh", specs.testedKwhMonth != null ? `${specs.testedKwhMonth.toFixed(2)} kWh/mo` : null],
    ["eer", specs.energyEfficiencyRating != null ? `${specs.energyEfficiencyRating}` : null],
  ].filter(([, v]) => v != null && v !== "");
  if (chips) {
    chips.innerHTML = values.length
      ? `<p class="lens-chips-title">${words.length} words found · tap a detail to edit it</p>
         <div class="lens-chip-row">${values.map(([kind, v]) => `<button type="button" class="lens-chip lens-${kind}" data-act="lens-focus" data-field="${LENS_KINDS[kind].field}"><span>${LENS_KINDS[kind].icon}</span><small>${LENS_KINDS[kind].label}</small><b>${ctx.escape(String(v))}</b></button>`).join("")}</div>`
      : `<p class="lens-chips-title">${words.length ? `${words.length} words found, but no ratings recognized — retake closer, or type them below.` : "No text found — retake the photo closer and in good light."}</p>`;
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
    const { specs, words } = await recognizeApplianceLabel(scannerState.canvas, onProgress);
    scannerState.specs = specs;
    scannerState.processing = false;
    if (progressArea) progressArea.style.display = "none";
    drawLensResults(root, scannerState.canvas, words, specs, ctx);
    // Label wattage unreadable and no tested kWh: suggest the typical wattage for this appliance,
    // and let the AI recognize what the appliance is from the photo itself (no label needed).
    if (specs.watts == null && specs.testedKwhMonth == null) {
      showAppliancePreset(root, specs.name || specs.category, { fromScan: true });
      identifyApplianceWithAi(ctx, root, { auto: true });
    } else fill(root, "appliance-preset-hint", "");

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
          <button type="button" class="btn btn-primary scanner-btn" data-act="appliance-camera" title="Scan the label with your camera, like Google Lens">
            <span>📷 Scan Appliance Label</span>
          </button>
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
          ${field("Name", `<input name="name" required maxlength="60" placeholder="e.g. Bedroom aircon" list="appliance-presets" autocomplete="off">`)}
          <datalist id="appliance-presets">${ALL_APPLIANCES.map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join("")}</datalist>
          ${field("Brand (optional)", `<input name="brand" maxlength="60" placeholder="e.g. Carrier">`)}
          ${field("Model (optional)", `<input name="model" maxlength="60" placeholder="e.g. FP-53CAS010">`)}
          ${field("Category", `<select name="category" class="select">${CATEGORIES.map((c) => `<option value="${c}">${c[0].toUpperCase()}${c.slice(1)}</option>`).join("")}</select>`)}
          ${field("Power (watts)", `<input name="watts" type="number" min="0" max="20000" step="any" placeholder="e.g. 150">`, { hint: "Check label or manual. Leave blank if label has verified kWh/month." })}
          ${field("Tested energy (kWh/month, optional)", `<input name="testedKwhMonth" type="number" min="0.1" max="5000" step="any" placeholder="e.g. 26.10">`, { hint: "From manufacturer energy guide or efficiency label." })}
          ${field("Energy efficiency rating (optional)", `<input name="energyEfficiencyRating" type="number" min="1" max="10000" step="any" placeholder="e.g. 253">`, { hint: "EER or star rating (dimensionless, not watts)." })}
          <div class="field full" data-slot="appliance-preset-hint"></div>
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
    <div style="margin-top:14px">${ctx.panel("Registered appliances", slot("appliances"))}</div>
    <div style="margin-top:14px">${ctx.panel(`All appliances <small>(${ALL_APPLIANCES.length} typical household appliances)</small>`, `
      <p class="muted-note">Tap <b>＋ Add</b> to register an appliance with its typical wattage, then edit it to match your label. Source: <a href="${WATTAGE_SOURCE.url}" target="_blank" rel="noopener">Daft Logic</a> + SmartWatts Philippine household list.</p>
      <div class="catalog-tools">
        <input class="input" type="search" data-catalog-search placeholder="Search e.g. aircon, ref, rice cooker, PS5…" aria-label="Search appliances">
        <select class="select" data-catalog-cat aria-label="Filter by category">
          <option value="">All categories</option>
          ${CATEGORIES.map((c) => `<option value="${c}">${c[0].toUpperCase()}${c.slice(1)}</option>`).join("")}
        </select>
      </div>
      ${slot("appliance-catalog")}`)}</div>`;
}

// ------------------------------------------------------------- appliance catalog
let registeredNames = new Set();

function catalogRows(query = "", category = "") {
  const q = query.trim().toLowerCase();
  const seen = new Set();
  const items = ALL_APPLIANCES.filter((p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    if (category && p.category !== category) return false;
    return !q || [p.name, ...p.aliases].some((n) => n.toLowerCase().includes(q));
  });
  if (!items.length) return `<p class="muted-note">No appliance matches “${escapeHtml(query)}”. You can still add it with the form above.</p>`;
  return `<div class="catalog-scroll">${table(
    ["Appliance", "Typical power", "Standby", "Est. kWh / month", ""],
    items.map((p) => {
      const index = ALL_APPLIANCES.indexOf(p);
      const kwh = estimateMonthlyKwh({ watts: p.typicalWatts, quantity: 1, hoursPerDay: p.hoursPerDay, daysPerWeek: 7 });
      const added = registeredNames.has(p.name.toLowerCase());
      return [
        `<b>${user(p.name)}</b>${p.aliases.length ? `<div class="muted-note">${user(p.aliases.slice(0, 3).join(", "))}</div>` : ""}<div class="muted-note">${user(p.category)}</div>`,
        `${p.minWatts === p.maxWatts ? fmtW(p.minWatts) : `${fmtW(p.minWatts)}–${fmtW(p.maxWatts)}`}`,
        p.standbyWatts != null ? fmtW(p.standbyWatts) : "—",
        `${formatKwh(kwh)} <small class="muted-note">at ${p.hoursPerDay} h/day</small>`,
        added
          ? `<span class="catalog-added">✓ Added</span>`
          : `<button type="button" class="btn btn-outline btn-small" data-act="catalog-add" data-index="${index}">＋ Add</button>`,
      ];
    }),
  )}</div><p class="muted-note">${items.length} shown. Typical values are estimates — your appliance label is more accurate.</p>`;
}

function renderCatalog(root = document.querySelector("#content")) {
  if (!root?.querySelector('[data-slot="appliance-catalog"]')) return;
  const query = root.querySelector("[data-catalog-search]")?.value ?? "";
  const category = root.querySelector("[data-catalog-cat]")?.value ?? "";
  fill(root, "appliance-catalog", catalogRows(query, category));
}

for (const type of ["input", "change"]) {
  document.addEventListener(type, (event) => {
    if (event.target instanceof Element && event.target.matches("[data-catalog-search], [data-catalog-cat]")) renderCatalog();
  });
}

async function loadAppliances(_ctx, root) {
  const appliances = await listAppliances();
  registeredNames = new Set(appliances.map((a) => String(a.name).toLowerCase()));
  renderCatalog(root);
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
        <div data-slot="bill-scanner">${billScannerHtml()}</div>
        <p class="muted-note" data-slot="ocr-status"></p>
        <p class="muted-note privacy-note">🔒 Privacy: the photo or PDF is read on this device and is never uploaded or stored. SmartWatts keeps only the billing figures you confirm below — not your name, address, account, or meter numbers.</p>
        <form class="form-grid" data-form="bill-save">
          <input type="hidden" name="source" value="manual">
          ${field("Period start", `<input name="periodStart" type="date" required>`)}
          ${field("Period end", `<input name="periodEnd" type="date" required max="${todayIso()}">`)}
          ${field("Billed kWh", `<input name="kwh" inputmode="decimal" required>`)}
          ${field("Total current charges (₱)", `<input name="amount" inputmode="decimal" required>`, { hint: "This month's charges, excluding any previous unpaid balance." })}
          ${field("Due date (optional)", `<input name="dueDate" type="date">`, { hint: "Used for email reminders when due date approaches." })}
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
    <div style="margin-top:14px">${ctx.panel("📅 Bill calendar <small>(dates from your scanned bills + predicted next payment)</small>", slot("bill-calendar"))}</div>
    <div style="margin-top:14px">${ctx.panel("Billing history", slot("bills"))}</div>`;
}

// ---------------------------------------------------------------- bill calendar
// Dates read from scanned bills are kept on this device (keyed by billing-period end) and
// merged with saved bills; the next bill and payment due date are predicted from them.
const BILL_DATES_KEY = "smartwatts-bill-dates";
const billCal = { history: [], month: null };

function readBillDates() {
  try { return JSON.parse(localStorage.getItem(BILL_DATES_KEY) || "{}") || {}; } catch { return {}; }
}

function saveBillDates(entry) {
  try {
    const all = readBillDates();
    all[entry.periodEnd] = { ...all[entry.periodEnd], ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null)) };
    localStorage.setItem(BILL_DATES_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

const longDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "—");
const EVENT_ICONS = { bill: "🧾", due: "💸", reading: "🔎", "predicted-bill": "🧾", "predicted-due": "💸" };

function billCalendarHtml() {
  const history = billCal.history;
  if (!history.length) {
    return `<p class="muted-note">Scan a bill above — its bill date, due date and next meter reading are added here automatically, and SmartWatts predicts your next payment.</p>`;
  }
  const prediction = predictNext(history);
  const events = calendarEvents(history, prediction);
  const today = todayIso();
  const dueIn = prediction.nextDueDate ? daysBetween(today, prediction.nextDueDate) : null;
  const amount = prediction.estimatedAmountCentavos != null ? formatPeso(prediction.estimatedAmountCentavos) : null;
  const details = `Predicted by SmartWatts from your past bills${amount ? `. Estimated amount: ${amount}` : ""}. Check your actual Meralco bill.`;

  if (!billCal.month) billCal.month = (prediction.nextDueDate ?? today).slice(0, 7);
  const [y, m] = billCal.month.split("-").map(Number);
  const weeks = monthMatrix(y, m);
  const byDate = new Map();
  for (const e of events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });

  return `
    <div class="billcal-next">
      <div>
        <span class="billcal-label">Next payment due ${kindBadge("estimate")}</span>
        <b class="billcal-date">${longDate(prediction.nextDueDate)}</b>
        <span class="billcal-sub">${dueIn == null ? "" : dueIn < 0 ? `${-dueIn} day(s) ago` : dueIn === 0 ? "Today" : `in ${dueIn} day(s)`}${amount ? ` · about <b>${amount}</b>` : ""}</span>
        <span class="billcal-sub">Next bill expected ${longDate(prediction.nextBillDate)}</span>
      </div>
      <div class="billcal-actions">
        ${prediction.nextDueDate ? `<a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="${escapeHtml(googleCalendarLink(prediction.nextDueDate, "Pay Meralco bill (SmartWatts reminder)", details))}">＋ Google Calendar</a>` : ""}
        <button type="button" class="btn btn-outline btn-small" data-act="bill-ics">⬇ Download .ics</button>
      </div>
    </div>
    <p class="muted-note">${escapeHtml(prediction.basis)}</p>
    <div class="billcal-head">
      <button type="button" class="btn btn-outline btn-small" data-act="bill-cal-month" data-step="-1" aria-label="Previous month">‹</button>
      <b>${monthLabel}</b>
      <button type="button" class="btn btn-outline btn-small" data-act="bill-cal-month" data-step="1" aria-label="Next month">›</button>
    </div>
    <div class="billcal-grid" role="grid" aria-label="${monthLabel}">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="billcal-dow">${d}</div>`).join("")}
      ${weeks.flat().map((date) => {
        if (!date) return `<div class="billcal-day empty"></div>`;
        const dayEvents = byDate.get(date) ?? [];
        return `<div class="billcal-day${date === today ? " today" : ""}${dayEvents.length ? " has" : ""}">
          <span class="billcal-num">${Number(date.slice(8))}</span>
          ${dayEvents.map((e) => `<span class="billcal-ev ev-${e.kind}${e.predicted ? " predicted" : ""}" title="${escapeHtml(`${e.title}${e.amountCentavos ? ` · ${formatPeso(e.amountCentavos)}` : ""}`)}">${EVENT_ICONS[e.kind]} <i>${escapeHtml(e.title.replace(" (predicted)", ""))}</i></span>`).join("")}
        </div>`;
      }).join("")}
    </div>
    <p class="billcal-legend"><span class="billcal-ev ev-bill">🧾 Bill issued</span><span class="billcal-ev ev-due">💸 Payment due</span><span class="billcal-ev ev-reading">🔎 Meter reading</span><span class="billcal-ev ev-predicted-due predicted">Dashed = predicted</span></p>`;
}

function renderBillCalendar(root = document.querySelector("#content")) {
  if (root?.querySelector('[data-slot="bill-calendar"]')) fill(root, "bill-calendar", billCalendarHtml());
}

const billCalendarActions = {
  "bill-cal-month"(button) {
    const [y, m] = (billCal.month ?? todayIso().slice(0, 7)).split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + Number(button.dataset.step), 1));
    billCal.month = d.toISOString().slice(0, 7);
    renderBillCalendar();
  },
  "bill-ics"() {
    const events = calendarEvents(billCal.history);
    const blob = new Blob([buildIcs(events)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "smartwatts-bill-calendar.ics" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

async function loadBills(_ctx, root) {
  const bills = (await listBills()).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const stored = readBillDates();
  billCal.history = bills.map((b) => ({ periodStart: b.periodStart, periodEnd: b.periodEnd, amountCentavos: b.amountCentavos, ...stored[b.periodEnd] }));
  renderBillCalendar(root);
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
        <p class="eyebrow">Tier 1</p><h3>${escapeHtml(personal.name)}</h3>
        <div class="bill-amount">Free <small>forever</small></div>
        <ul class="plan-list">
          <li>Bill upload with in-browser OCR</li><li>Appliance registration and usage estimates</li>
          <li>Savings simulator and saved plans</li><li>AI Energy Advisor</li>
          <li>Billing history and personal analytics</li><li>English and Filipino</li>
        </ul>
        <button class="btn btn-outline" data-page="dashboard">Open my dashboard</button>
      </section>
      <section class="panel plan-card plan-featured">
        <p class="eyebrow">Tier 2</p><h3>${escapeHtml(rentals.name)}</h3>
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
function accountPersonalHtml(ctx, profile, identity) {
  const firstName = profile.firstName ?? "";
  const lastName = profile.lastName ?? "";
  const phone = identity.phoneNumber || profile.phoneNumber || "";
  return `<p class="muted-note">Current Firebase display name: <strong id="account-current-display-name">${ctx.escape(profile.displayName || identity.displayName || "Not set")}</strong>. First and last name fields are shown only when saved separately.</p>
  <form class="form-grid" data-form="account-profile-save" autocomplete="on">
    <div class="field"><label for="account-first-name">First name</label><input id="account-first-name" name="firstName" maxlength="100" autocomplete="given-name" value="${ctx.escape(firstName)}" placeholder="Enter your first name"></div>
    <div class="field"><label for="account-last-name">Last name</label><input id="account-last-name" name="lastName" maxlength="100" autocomplete="family-name" value="${ctx.escape(lastName)}" placeholder="Enter your last name"></div>
    <div class="field"><label for="account-email">Email address</label><input id="account-email" type="email" value="${ctx.escape(identity.email || "")}" readonly aria-readonly="true" autocomplete="email"><small class="muted-note">This is read from Firebase Authentication. Use Security for account actions.</small></div>
    <div class="field"><label for="account-phone">Mobile number</label><input id="account-phone" name="phoneNumber" type="tel" maxlength="32" autocomplete="tel" value="${ctx.escape(phone)}" placeholder="Enter your mobile number"${identity.phoneNumber ? " readonly aria-readonly=\"true\"" : ""}><small class="muted-note">${identity.phoneNumber ? "Verified by Firebase Authentication." : "Saved to your private profile; not verified by your utility provider."}</small></div>
    <div class="field full"><button class="btn btn-primary" type="submit">Save Changes</button></div>
  </form>`;
}

function accountServiceHtml(ctx, profile) {
  const options = (items, selected) => items.map(([value, label]) => `<option value="${value}"${selected === value ? " selected" : ""}>${label}</option>`).join("");
  return `<form class="form-grid" data-form="account-service-save" autocomplete="on">
    <div class="field"><label for="service-provider">Electricity provider</label><input id="service-provider" name="serviceProvider" maxlength="80" value="${ctx.escape(profile.serviceProvider || "")}" placeholder="Enter your electricity provider"></div>
    <div class="field"><label for="service-account">Utility account number</label><input id="service-account" name="utilityAccountNumber" maxlength="64" value="${ctx.escape(profile.utilityAccountNumber || "")}" placeholder="Add your utility account number" autocomplete="off"></div>
    <div class="field full"><label for="service-address">Service address</label><textarea id="service-address" name="serviceAddress" maxlength="300" rows="3" autocomplete="street-address" placeholder="Add your service address">${ctx.escape(profile.serviceAddress || "")}</textarea></div>
    <div class="field"><label for="service-rate">Rate category</label><input id="service-rate" name="rateCategory" maxlength="60" value="${ctx.escape(profile.rateCategory || "")}" placeholder="Enter rate category if shown on your bill"><small class="muted-note">Self-reported; not verified by MERALCO.</small></div>
    <div class="field"><label for="service-dwelling">Home setup</label><select id="service-dwelling" name="dwellingType"><option value="">Not specified</option>${options([["homeowner", "Homeowner"], ["condo_apartment", "Condo / apartment resident"]], profile.dwellingType)}</select></div>
    <div class="field"><label for="service-record-type">Utility record type</label><select id="service-record-type" name="utilityRecordType"><option value="">Not specified</option>${options([["meralco_bill", "Meralco bill"], ["condo_soa", "Condo / apartment statement"], ["submeter_slip", "Sub-meter slip"]], profile.utilityRecordType)}</select></div>
    <div class="field full"><small class="muted-note">These details are private to your SmartWatts account and do not indicate a verified utility connection. Only one service profile is currently supported.</small></div>
    <div class="field full"><button class="btn btn-primary" type="submit">Save Service Details</button></div>
  </form>`;
}

function accountSecurityHtml(ctx, identity) {
  const providers = identity.providerData.map((provider) => ({
    "google.com": "Google", password: "Email / Password", phone: "Phone",
  }[provider.providerId] ?? "Other sign-in provider"));
  const hasPassword = identity.providerData.some((provider) => provider.providerId === "password");
  const emailProvider = identity.providerData.some((provider) => ["password", "google.com"].includes(provider.providerId));
  return `<div class="detail-list">
      <div class="detail-row"><span>Signed-in email</span><b>${ctx.escape(identity.email || "Not provided by this sign-in method")}</b></div>
      <div class="detail-row"><span>Email verified</span><b>${identity.email ? (identity.emailVerified ? "Yes" : "Not yet") : "Not applicable"}</b></div>
      <div class="detail-row"><span>Sign-in provider</span><b>${ctx.escape([...new Set(providers)].join(", ") || (identity.isAnonymous ? "Guest session" : "Not available"))}</b></div>
      <div class="detail-row"><span>Account type</span><b>${identity.isAnonymous ? "Temporary guest" : "Permanent account"}</b></div>
    </div>
    <div class="toolbar" style="margin-top:14px">
      ${identity.email && !identity.emailVerified && emailProvider ? `<button class="btn btn-outline" data-act="resend-verification">Send verification email</button><button class="btn btn-outline" data-act="account-refresh-verification">Refresh verification status</button>` : ""}
      ${hasPassword && identity.email ? `<button class="btn btn-outline" data-act="account-password-reset">Send password reset link</button>` : ""}
      ${!hasPassword && providers.includes("Google") ? `<span class="muted-note">Password is managed by Google for this account.</span>` : ""}
      <button class="btn btn-outline" data-act="sign-out">Sign out</button>
    </div>
    ${identity.email ? `<form class="form-grid" data-form="account-email-update" style="margin-top:16px">
      <div class="field"><label for="account-new-email">New email address</label><input id="account-new-email" name="newEmail" type="email" required autocomplete="email" placeholder="Enter a new email address"></div>
      ${hasPassword ? `<div class="field"><label for="account-current-password">Current password</label><input id="account-current-password" name="currentPassword" type="password" required autocomplete="current-password"></div>` : `<div class="field"><span class="muted-note">Google will ask you to confirm your identity in a sign-in popup.</span></div>`}
      <div class="field full"><button class="btn btn-outline" type="submit">Verify new email</button><small class="muted-note">Firebase emails a verification link. Your sign-in email changes only after the link is confirmed.</small></div>
    </form>` : ""}`;
}

function accountPreferencesHtml(ctx, profile) {
  const languages = getSupportedLanguages();
  const preferredLanguage = languages.some((language) => language.code === profile.preferredLanguage) ? profile.preferredLanguage : getLanguage();
  const languageOptions = languages.map((language) => `<option value="${ctx.escape(language.code)}"${preferredLanguage === language.code ? " selected" : ""}>${ctx.escape(language.name)}</option>`).join("");
  let theme = "light";
  try { theme = localStorage.getItem("smartwatts-theme") === "dark" ? "dark" : "light"; } catch { /* use current light fallback */ }
  const np = profile.notificationPreferences || {};
  const reminderIntervals = np.reminder_intervals || [7, 3, 0];
  return `<form class="form-grid" data-form="account-preferences-save">
    <div class="field"><label for="account-language">Interface language</label><select id="account-language" name="preferredLanguage">${languageOptions}</select><small class="muted-note">Saved to your account when Firebase is available. Locally supported translations work without cloud translation.</small></div>
    <div class="field"><label for="account-theme">Theme</label><select id="account-theme" name="theme"><option value="light"${theme === "light" ? " selected" : ""}>Light</option><option value="dark"${theme === "dark" ? " selected" : ""}>Dark</option></select><small class="muted-note">Theme is saved on this browser, matching the existing app preference.</small></div>
    <div class="field full">
      <label>Email notifications</label>
      <div style="display:grid;gap:8px;margin-top:6px">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" name="bill_saved_confirmations"${np.bill_saved_confirmations !== false ? " checked" : ""}>
          <span>Send email confirmation when a bill is saved</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" name="bill_due_reminders"${np.bill_due_reminders !== false ? " checked" : ""}>
          <span>Send email reminders when bill due date approaches</span>
        </label>
        <div style="margin-left:24px;display:flex;gap:12px;font-size:12px">
          <label style="display:flex;align-items:center;gap:4px">
            <input type="checkbox" name="reminder_7_days"${reminderIntervals.includes(7) ? " checked" : ""}> 7 days before
          </label>
          <label style="display:flex;align-items:center;gap:4px">
            <input type="checkbox" name="reminder_3_days"${reminderIntervals.includes(3) ? " checked" : ""}> 3 days before
          </label>
          <label style="display:flex;align-items:center;gap:4px">
            <input type="checkbox" name="reminder_0_days"${reminderIntervals.includes(0) ? " checked" : ""}> On due date
          </label>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" name="rental_statements"${np.rental_statements !== false ? " checked" : ""}>
          <span>Send email notifications when a rental electricity statement is published</span>
        </label>
      </div>
      <small class="muted-note">Notifications are sent to your verified sign-in email. SmartWatts never sends marketing emails or shares your address.</small>
    </div>
    <div class="field full"><button class="btn btn-primary" type="submit">Save Preferences</button></div>
  </form>`;
}

async function loadAccount(ctx, root) {
  if (!firebaseConfigured || !auth) {
    fill(root, "account-context", notice("warning", "Firebase Authentication is unavailable. Customer profile settings cannot be loaded or saved."));
    for (const section of ["personal", "service", "security", "preferences"]) fill(root, `account-${section}`, notice("info", "Sign in with Firebase to manage account settings."));
    return;
  }
  await auth.authStateReady();
  const identity = auth.currentUser;
  if (!identity) throw new Error("Sign in before opening Account Settings.");
  const uid = identity.uid;
  const profile = await loadUserProfile(uid);
  if (root.isStale || auth.currentUser?.uid !== uid) return;
  const workspace = getWorkspace();
  const membership = getMemberships().find((item) => item.propertyId === workspace.propertyId);
  const workspaceLabel = workspace.type === "owner"
    ? `Rentals ${workspace.role === "admin" ? "Administrator" : "Owner"} · ${workspace.propertyName} · subscription ${membership?.lifecycle ?? "managed by property"}`
    : workspace.type === "tenant" ? `Rentals Tenant · ${workspace.propertyName} · property access` : "SmartWatts Personal · Free";
  fill(root, "account-context", `<span>Signed-in account</span> · ${ctx.escape(identity.displayName || identity.email || "Firebase user")} · ${ctx.escape(workspaceLabel)}`);
  const safeProfile = profile ?? { displayName: null, firstName: null, lastName: null, phoneNumber: null, serviceProvider: null,
    serviceAddress: null, utilityAccountNumber: null, rateCategory: null, preferredLanguage: null, dwellingType: null,
    utilityRecordType: null, baselineKwh: null, baselinePeriodEnd: null };
  fill(root, "account-personal", accountPersonalHtml(ctx, safeProfile, identity));
  fill(root, "account-service", accountServiceHtml(ctx, safeProfile));
  fill(root, "account-security", accountSecurityHtml(ctx, identity));
  fill(root, "account-preferences", accountPreferencesHtml(ctx, safeProfile));
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
  const roleLabel = (m) => (m.role === "tenant" ? `Tenant${m.unitLabel ? ` · ${user(m.unitLabel)}` : ""}` : m.role === "owner" ? "Owner" : "Administrator");
  const propertiesPanel = memberships.length ? ctx.panel("Your properties", `<ul class="property-list">${memberships.map((m) => `
      <li><div><b translate="no">${ctx.escape(m.propertyName)}</b><small>${roleLabel(m)}</small></div>
        ${m.lifecycle ? lifecycleBadge(m.lifecycle) : ""}
        <button class="btn btn-outline btn-small" data-act="open-workspace" data-id="${encodeURIComponent(m.propertyId)}">Open</button></li>`).join("")}</ul>`) : "";
  const createPanel = ctx.panel("Create a property", `
    <form class="form-grid" data-form="property-create">
      ${field("Property name", `<input name="name" required maxlength="120" placeholder="e.g. Sunrise Apartments">`, { full: true })}
      ${field("Address", `<input name="address" required maxlength="240" placeholder="Street, barangay, city">`, { full: true })}
      <div class="field full"><button class="btn btn-primary" type="submit">Create draft property</button></div>
      <p class="muted-note full">Drafts are free. Set up units and meters first; request activation (₱299 / property / month, proposed) when you are ready to invite tenants.</p>
    </form>`);
  const joinPanel = ctx.panel("Join with an invitation", `
    <form class="form-grid" data-form="invite-code">
      ${field("Invitation code or link", `<input name="code" required autocomplete="off">`, { full: true, hint: "Scan your landlord's QR code, or paste the link or code here." })}
      <div class="field full"><button class="btn btn-outline" type="submit">Continue</button></div>
    </form>
    <p class="muted-note">Tenants never pay a SmartWatts subscription.</p>`);
  const howItWorks = ctx.panel("How SmartWatts Rentals works", `<div class="rentals-how">
      <div><h4>Owners &amp; administrators</h4><ol>
        <li>Create a draft property and add up to 10 units.</li>
        <li>Register meters: one per unit, or a shared meter with a written allocation agreement.</li>
        <li>Activate the subscription, then invite tenants with a one-time link or QR code.</li>
        <li>Record readings and utility bills, review draft statements, and publish them.</li></ol></div>
      <div><h4>Tenants</h4><ol>
        <li>Open your landlord's invitation and sign in or register.</li>
        <li>See your unit, how your electricity is metered or allocated, and published statements.</li>
        <li>Ask your landlord to re-check a statement if something looks wrong.</li>
        <li>Your Personal appliances, savings plans, and AI chats stay private.</li></ol></div>
    </div>`);
  fill(root, "rentals-start", `
    ${propertiesPanel ? `<div style="margin-bottom:14px">${propertiesPanel}</div>` : ""}
    <div class="two-panels">${createPanel}${joinPanel}</div>
    <div style="margin-top:14px">${howItWorks}</div>`);
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
  return captureInviteFromHash();
}

export { hasPendingInvite };

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
  async "account-email-update"(form, ctx) {
    const identity = auth?.currentUser;
    if (!identity?.email) throw new Error("A verified email sign-in is required to update this account email.");
    const values = formValues(form);
    const newEmail = String(values.newEmail ?? "").trim();
    if (!/^\S+@\S+\.\S+$/.test(newEmail)) throw new Error("Enter a valid new email address.");
    if (newEmail.toLowerCase() === identity.email.toLowerCase()) throw new Error("Enter an email address different from your current one.");
    const hasPasswordProvider = identity.providerData.some((provider) => provider.providerId === "password");
    const hasGoogleProvider = identity.providerData.some((provider) => provider.providerId === "google.com");
    if (hasPasswordProvider && !String(values.currentPassword ?? "")) throw new Error("Enter your current password to confirm this change.");
    if (!hasPasswordProvider && !hasGoogleProvider) throw new Error("This sign-in provider does not support email changes in SmartWatts.");
    try {
      if (hasPasswordProvider) {
        const password = String(values.currentPassword);
        await reauthenticateWithCredential(identity, EmailAuthProvider.credential(identity.email, password));
      } else if (hasGoogleProvider) {
        await reauthenticateWithPopup(identity, new GoogleAuthProvider());
      }
      if (auth.currentUser?.uid !== identity.uid) throw new Error("Your signed-in account changed. Reload Account Settings and try again.");
      await verifyBeforeUpdateEmail(identity, newEmail);
    } catch (error) {
      if (error instanceof Error && error.message.includes("account changed")) throw error;
      throw new Error(friendlyAuthError(error));
    }
    ctx.toast("Firebase sent a verification link. Your email changes after you confirm it.");
  },
  async "account-profile-save"(form, ctx) {
    const identity = auth?.currentUser;
    if (!identity || identity.isAnonymous) throw new Error("A permanent Firebase account is required to save profile details.");
    const uid = identity.uid;
    const values = formValues(form);
    const firstName = String(values.firstName ?? "").trim();
    const lastName = String(values.lastName ?? "").trim();
    if (firstName.length > 100 || lastName.length > 100) throw new Error("Names must be 100 characters or fewer.");
    const profile = { firstName, lastName };
    if (!form.elements.phoneNumber.readOnly) profile.phoneNumber = String(values.phoneNumber ?? "").trim();
    if (!await saveUserProfile(profile)) throw new Error("Firebase could not save your profile. Check your connection and try again.");
    if (auth.currentUser?.uid !== uid) return;
    const displayName = [firstName, lastName].filter(Boolean).join(" ") || null;
    try {
      await updateProfile(identity, { displayName });
    } catch (error) {
      throw new Error(`Your profile was saved, but Firebase could not update the account display name: ${friendlyAuthError(error)}`);
    }
    const displayNameElement = document.querySelector("#account-current-display-name");
    if (displayNameElement) displayNameElement.textContent = displayName || "Not set";
    ctx.toast("Personal information saved to your account.");
  },
  async "account-service-save"(form, ctx) {
    const identity = auth?.currentUser;
    if (!identity || identity.isAnonymous) throw new Error("A permanent Firebase account is required to save service details.");
    const values = formValues(form);
    const dwellingType = String(values.dwellingType ?? "") || null;
    const utilityRecordType = String(values.utilityRecordType ?? "") || null;
    if (Boolean(dwellingType) !== Boolean(utilityRecordType)) throw new Error("Choose both home setup and utility record type, or leave both unspecified.");
    const saved = await saveUserProfile({
      serviceProvider: String(values.serviceProvider ?? ""),
      serviceAddress: String(values.serviceAddress ?? ""),
      utilityAccountNumber: String(values.utilityAccountNumber ?? ""),
      rateCategory: String(values.rateCategory ?? ""),
      dwellingType,
      utilityRecordType,
    });
    if (!saved) throw new Error("Firebase could not save your service details. Check your connection and try again.");
    ctx.toast("Service details saved. These entries are not utility-provider verified.");
  },
  async "account-preferences-save"(form, ctx) {
    const values = formValues(form);
    const language = String(values.preferredLanguage ?? "");
    const theme = String(values.theme ?? "");
    if (!getSupportedLanguages().some((item) => item.code === language)) throw new Error("Choose a supported interface language.");
    if (!["light", "dark"].includes(theme)) throw new Error("Choose a valid theme.");
    const reminder_intervals = [];
    if (values.reminder_7_days === "on") reminder_intervals.push(7);
    if (values.reminder_3_days === "on") reminder_intervals.push(3);
    if (values.reminder_0_days === "on") reminder_intervals.push(0);
    const notificationPreferences = {
      bill_saved_confirmations: values.bill_saved_confirmations === "on",
      bill_due_reminders: values.bill_due_reminders === "on",
      reminder_intervals,
      rental_statements: values.rental_statements === "on",
    };
    const saved = await saveUserProfile({ preferredLanguage: language, notificationPreferences });
    if (!saved) throw new Error("Firebase could not save your language preference. Check your connection and try again.");
    try {
      const identity = auth?.currentUser;
      if (identity && !identity.isAnonymous) {
        const token = await identity.getIdToken();
        fetch("/api/notifications/preferences", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(notificationPreferences),
        }).catch((err) => console.warn("Could not sync notification preferences:", err));
      }
    } catch (e) {
      console.warn("Preference sync error:", e);
    }
    let themeSaved = true;
    try { localStorage.setItem("smartwatts-theme", theme); } catch { themeSaved = false; }
    window.dispatchEvent(new CustomEvent("smartwatts-theme-change", { detail: theme }));
    if (language !== getLanguage()) setLanguage(language);
    ctx.toast(themeSaved ? "Preferences saved." : "Language saved; theme changed for this session because browser storage is unavailable.");
  },
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
    const scanned = billScan.result?.bill?.billing;
    const dueDate = v.dueDate ? String(v.dueDate).trim() : (scanned?.dueDate || null);
    const billId = await saveBill({
      periodStart: String(v.periodStart), periodEnd: String(v.periodEnd), kwh: Number(String(v.kwh).replace(/,/g, "")),
      amountCentavos, source: v.source === "ocr" ? "ocr" : "manual",
      components: Object.keys(components).length ? components : null,
      previousReading: reading(v.previousReading), presentReading: reading(v.presentReading),
      dueDate,
    });
    // Dates read by the scanner go straight onto the bill calendar.
    if (scanned && (scanned.dueDate || scanned.billDate || scanned.nextReadingDate) && (!scanned.periodEnd || scanned.periodEnd === String(v.periodEnd))) {
      saveBillDates({
        periodEnd: String(v.periodEnd), periodStart: String(v.periodStart), amountCentavos,
        billDate: scanned.billDate, dueDate: scanned.dueDate, nextReadingDate: scanned.nextReadingDate,
      });
      billCal.month = null;
    }
    // Queue server-side email confirmation when user is signed in
    try {
      const identity = auth?.currentUser;
      if (identity && !identity.isAnonymous && identity.email) {
        const token = await identity.getIdToken();
        fetch("/api/notifications/bill-saved", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            billId: String(billId),
            periodStart: String(v.periodStart),
            periodEnd: String(v.periodEnd),
            amountPesos: amountCentavos / 100,
            kwh: Number(String(v.kwh).replace(/,/g, "")),
            dueDate: dueDate || null,
            workspaceType: "Personal",
          }),
        }).catch((err) => console.warn("Could not queue bill saved notification:", err));
      }
    } catch (notifyErr) {
      console.warn("Notification trigger failed:", notifyErr);
    }
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
    await identifyApplianceWithAi(ctx, document.querySelector("#content"), { auto: false });
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
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    window.location.assign("/landing/login.html");
  },
  async "resend-verification"(_button, ctx) {
    try {
      await resendVerification();
    } catch (error) {
      throw new Error(friendlyAuthError(error));
    }
    ctx.toast("Verification email sent.");
  },
  async "account-password-reset"(_button, ctx) {
    const identity = auth?.currentUser;
    if (!identity?.email || !identity.providerData.some((provider) => provider.providerId === "password")) {
      throw new Error("Password reset is available only for an Email / Password account.");
    }
    try {
      await sendPasswordResetEmail(auth, identity.email);
    } catch (error) {
      throw new Error(friendlyAuthError(error));
    }
    ctx.toast("Firebase sent a password reset link to your signed-in email.");
  },
  async "account-refresh-verification"(_button, ctx) {
    const identity = auth?.currentUser;
    if (!identity) throw new Error("Sign in again to refresh account status.");
    await reload(identity);
    ctx.render();
    ctx.toast(identity.emailVerified ? "Email verification confirmed." : "Firebase still reports this email as unverified.");
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

// ---------------------------------------------------------------- bill scanner wizard (Front → Back → Scan)
// Same flow as the jrmph Meralco scanner: up to 3 shots of the FRONT (required) and
// BACK (optional) of the bill, quality badges, then one scan that merges every shot.
const MAX_SHOTS = 3;
const billScan = { step: 1, shots: { front: [], back: [] }, busy: false, result: null };
let shotSeq = 0;

const pesoValue = (n) => (n == null ? "—" : `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const niceDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
};

function shotHtml(side, s, i) {
  const badge = s.checking
    ? `<span class="scan-q scan-q-wait" title="Checking quality…">…</span>`
    : s.warnings.length
      ? `<span class="scan-q scan-q-bad" title="${escapeHtml(s.warnings.join(" "))}">⚠</span>`
      : s.url ? `<span class="scan-q scan-q-ok" title="Looks good">✓</span>` : "";
  return `<div class="scan-shot">
    ${s.url ? `<img src="${s.url}" alt="${side} ${i + 1}">` : `<div class="scan-pdf"><span>📄</span><b>${user(s.file.name)}</b></div>`}
    <span class="scan-shot-n">${i + 1}</span>${badge}
    <button type="button" class="scan-shot-x" data-act="scan-remove" data-side="${side}" data-id="${s.id}" aria-label="Remove shot ${i + 1}">✕</button>
    ${s.url ? `<button type="button" class="scan-shot-crop" data-act="scan-crop" data-side="${side}" data-id="${s.id}" aria-label="Crop shot ${i + 1}">✂ Crop</button>` : ""}
  </div>`;
}

function pickerButtons(side) {
  const full = billScan.shots[side].length >= MAX_SHOTS;
  if (full) return `<p class="muted-note">Maximum of ${MAX_SHOTS} shots for this side.</p>`;
  return `<div class="scan-actions">
    <button type="button" class="btn btn-primary" data-act="scan-camera" data-side="${side}">📷 ${billScan.shots[side].length ? "Take more photos" : "Scan with camera"}</button>
    <label class="btn btn-outline">⬆ Upload photo or PDF
      <input type="file" accept="image/*,application/pdf,.pdf" multiple class="sr-only" data-ocr="personal-bill" data-side="${side}"></label>
  </div>`;
}

function sidePane(side) {
  const shots = billScan.shots[side];
  const front = side === "front";
  const warnings = shots.flatMap((s) => s.warnings);
  return `
    <h4 class="scan-title">${front ? "Front of the bill" : "Back of the bill <small>(optional)</small>"}</h4>
    <p class="muted-note">${front
      ? "The page with your billing period, meter readings, and charges. Lay the bill flat in good light — or upload the Meralco PDF e-bill (read exactly, no camera needed)."
      : "The page with “What you’ve paid” and “How your bill was computed”. Skip this if you uploaded a 2-page PDF e-bill."}</p>
    <div class="scan-dz${shots.length ? " has" : ""}">
      ${shots.length
        ? `<div class="scan-gallery">${shots.map((s, i) => shotHtml(side, s, i)).join("")}</div>`
        : `<div class="scan-dz-empty"><div class="scan-dz-icon">🧾</div><b>${front ? "Front page" : "Back page"}</b><span>Up to ${MAX_SHOTS} photos, or one PDF</span></div>`}
    </div>
    ${warnings.length ? `<ul class="scan-warnings">${[...new Set(warnings)].map((w) => `<li>⚠ ${user(w)}</li>`).join("")}</ul>` : ""}
    ${pickerButtons(side)}`;
}

function stepper() {
  const labels = ["Front page", "Back page", "Scan"];
  return `<ol class="scan-stepper">${labels.map((label, i) => {
    const n = i + 1;
    const state = billScan.step === n ? "now" : billScan.step > n ? "done" : "";
    return `<li class="${state}"><span>${billScan.step > n ? "✓" : n}</span>${label}</li>`;
  }).join("")}</ol>`;
}

function resultsHtml() {
  const { bill, back, checks, method, confidence, warnings } = billScan.result;
  const how = method === "pdf-text" ? "PDF e-bill (exact text)" : method === "pdf-ocr" ? "scanned PDF (OCR)" : `photo OCR${confidence != null ? ` · ${confidence}% confidence` : ""}`;
  const okCount = checks.filter((c) => c.ok).length;
  const stat = (label, value, sub = "") => `<div class="scan-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const backHtml = back && (back.payments.length || back.rateRows.length)
    ? `<details class="scan-back"><summary>Back page · ${back.payments.length} payment${back.payments.length === 1 ? "" : "s"}, ${back.rateRows.length} rate line${back.rateRows.length === 1 ? "" : "s"}</summary>
        ${back.payments.length ? `<p class="muted-note"><b>What you’ve paid</b></p><ul class="scan-list">${back.payments.map((p) => `<li><span>${niceDate(p.date)}</span><b>${pesoValue(p.amount)}</b></li>`).join("")}</ul>` : ""}
        ${back.rateRows.length ? `<p class="muted-note"><b>How your bill was computed</b></p><ul class="scan-list">${back.rateRows.map((r) => `<li><span>${user(r.component)}${r.basisKwh ? ` · ${r.basisKwh} kWh` : ""} × ${r.rate}</span><b>${pesoValue(r.amount)}</b></li>`).join("")}</ul>` : ""}
      </details>`
    : "";
  return `
    <div class="scan-results">
      <div class="scan-results-head"><b>Scan results</b><span class="muted-note">Read from ${how}</span></div>
      <div class="scan-stats">
        ${stat("Total amount due", pesoValue(bill.totals.totalAmountDue), bill.totals.previousBalance ? `incl. ${pesoValue(bill.totals.previousBalance)} previous balance` : "")}
        ${stat("Due date", niceDate(bill.billing.dueDate))}
        ${stat("Consumption", bill.reading.kwh != null ? `${bill.reading.kwh} kWh` : "—", bill.reading.ratePerKwh ? `₱${bill.reading.ratePerKwh}/kWh` : "")}
        ${stat("Billing period", niceDate(bill.billing.periodEnd), bill.billing.periodStart ? `from ${niceDate(bill.billing.periodStart)}` : "")}
      </div>
      <div class="scan-checks">
        <p class="muted-note"><b>Checks · ${okCount}/${checks.length} passed</b>${okCount < checks.length ? " — fix the ⚠ values in the form below" : ""}</p>
        <ul>${warnings.map((w) => `<li class="scan-bad">⚠ ${user(w)}</li>`).join("")}${checks.map((c) => `<li class="${c.ok ? "scan-ok" : "scan-bad"}"><b>${c.ok ? "✓" : "⚠"} ${user(c.label)}</b> — ${user(c.detail)}</li>`).join("")}</ul>
      </div>
      ${backHtml}
      <div class="scan-nav"><span class="muted-note">Values are filled into the form below — check them, then save. ${bill.billing.dueDate ? "📅 The due date and next reading go on your Bill calendar when you save." : ""}</span><button type="button" class="btn btn-outline" data-act="scan-reset">＋ Scan another bill</button></div>
    </div>`;
}

function billScannerHtml() {
  if (billScan.step === 4 && billScan.result) return resultsHtml();
  const { front, back } = billScan.shots;
  let body;
  if (billScan.step === 3) {
    const thumbs = (side) => `<div class="scan-thumb">
      <span class="scan-thumb-label">${side === "front" ? "Front" : "Back"} · ${billScan.shots[side].length} shot${billScan.shots[side].length === 1 ? "" : "s"}</span>
      ${billScan.shots[side].length
        ? `<div class="scan-mini-row">${billScan.shots[side].map((s) => (s.url ? `<img src="${s.url}" alt="">` : `<span class="scan-mini-pdf">📄</span>`)).join("")}</div>`
        : `<div class="scan-thumb-empty">None</div>`}
      <button type="button" class="text-link" data-act="scan-step" data-step="${side === "front" ? 1 : 2}">${billScan.shots[side].length ? "Change" : "Add"}</button>
    </div>`;
    body = `
      <h4 class="scan-title">Ready to scan</h4>
      <div class="scan-thumbs">${thumbs("front")}${thumbs("back")}</div>
      <p class="muted-note">🔒 Read on this device only — nothing is uploaded. Takes about 20–60 seconds for photos; PDFs are instant.</p>
      <div class="scan-nav">
        <button type="button" class="text-link" data-act="scan-step" data-step="2">← Back</button>
        <button type="button" class="btn btn-primary" data-act="scan-run" ${front.length && !billScan.busy ? "" : "disabled"}>${billScan.busy ? "Scanning…" : "✨ Start scan"}</button>
      </div>
      <div class="scan-progress" ${billScan.busy ? "" : "hidden"}><div class="scan-progress-bar"><span data-scan-bar></span></div><p class="muted-note" data-scan-stage>Starting…</p></div>`;
  } else {
    const side = billScan.step === 1 ? "front" : "back";
    body = `${sidePane(side)}
      <div class="scan-nav">
        ${side === "back" ? `<button type="button" class="text-link" data-act="scan-step" data-step="1">← Back</button>` : "<span></span>"}
        <div class="scan-nav-r">
          ${side === "back" && !back.length ? `<button type="button" class="btn btn-outline" data-act="scan-step" data-step="3">Skip</button>` : ""}
          <button type="button" class="btn btn-primary" data-act="scan-step" data-step="${billScan.step + 1}" ${front.length ? "" : "disabled"}>Next →</button>
        </div>
      </div>`;
  }
  return `<div class="bill-scanner">${stepper()}${body}</div>`;
}

function renderBillScanner(root = document.querySelector("#content")) {
  if (root?.querySelector('[data-slot="bill-scanner"]')) fill(root, "bill-scanner", billScannerHtml());
}

function applyScanToForm(root, scan) {
  const generic = extractBillFields(scan.text);
  const b = scan.bill;
  const scannedComponents = toDashboardComponents(b.charges);
  const suggestion = {
    kwh: b.reading.kwh ?? generic.kwh,
    amountPesos: b.totals.chargesThisPeriod != null ? b.totals.chargesThisPeriod.toFixed(2) : generic.amountPesos,
    periodStart: b.billing.periodStart ?? generic.periodStart,
    periodEnd: b.billing.periodEnd ?? generic.periodEnd,
    dueDate: b.billing.dueDate ?? generic.dueDate ?? null,
    previousReading: b.reading.previous ?? generic.previousReading,
    presentReading: b.reading.current ?? generic.presentReading,
    components: Object.keys(scannedComponents).length ? scannedComponents : generic.components,
  };
  const form = root.querySelector('[data-form="bill-save"]');
  if (!form) return suggestion;
  const set = (name, value) => { if (value !== null && value !== undefined && form.elements[name]) form.elements[name].value = value; };
  set("kwh", suggestion.kwh);
  set("amount", suggestion.amountPesos);
  set("periodStart", suggestion.periodStart);
  set("periodEnd", suggestion.periodEnd);
  set("dueDate", suggestion.dueDate);
  set("previousReading", suggestion.previousReading);
  set("presentReading", suggestion.presentReading);
  for (const [category, centavos] of Object.entries(suggestion.components)) set(`component:${category}`, (centavos / 100).toFixed(2));
  if (Object.keys(suggestion.components).length) form.querySelector(".charge-breakdown")?.setAttribute("open", "");
  if (["kwh", "amountPesos", "periodStart", "periodEnd"].some((key) => suggestion[key] !== null)) form.elements.source.value = "ocr";
  return suggestion;
}

export const billScannerActions = {
  "scan-step"(button, ctx) {
    const step = Number(button.dataset.step);
    if (step > 1 && !billScan.shots.front.length) return;
    billScan.step = Math.min(3, Math.max(1, step));
    renderBillScanner();
    ctx.translate?.(document.querySelector("#content"));
  },
  "scan-remove"(button, ctx) {
    const list = billScan.shots[button.dataset.side];
    const i = list.findIndex((s) => s.id === button.dataset.id);
    if (i >= 0) {
      if (list[i].url) URL.revokeObjectURL(list[i].url);
      list.splice(i, 1);
    }
    renderBillScanner();
    ctx.translate?.(document.querySelector("#content"));
  },
  "scan-reset"(_button, ctx) {
    for (const s of [...billScan.shots.front, ...billScan.shots.back]) if (s.url) URL.revokeObjectURL(s.url);
    Object.assign(billScan, { step: 1, shots: { front: [], back: [] }, busy: false, result: null });
    const root = document.querySelector("#content");
    renderBillScanner(root);
    fill(root, "ocr-status", "");
    fill(root, "ocr-review", "");
    ctx.translate?.(root);
  },
  async "scan-run"(_button, ctx) {
    if (billScan.busy || !billScan.shots.front.length) return;
    const root = document.querySelector("#content");
    billScan.busy = true;
    renderBillScanner(root);
    const progress = (side, stage, pct) => {
      const bar = root.querySelector("[data-scan-bar]");
      const label = root.querySelector("[data-scan-stage]");
      if (bar) bar.style.width = `${Math.round((pct ?? 0) * 100)}%`;
      if (label) label.textContent = `${side}: ${stage}${pct != null ? ` ${Math.round(pct * 100)}%` : ""}`;
    };
    try {
      const scan = await scanMeralcoBillPages(
        { front: billScan.shots.front.map((s) => s.file), back: billScan.shots.back.map((s) => s.file) },
        progress,
      );
      billScan.result = scan;
      billScan.step = 4;
      const suggestion = applyScanToForm(root, scan);
      const missing = [["kwh", "kWh"], ["amountPesos", "total charges"], ["periodStart", "billing period"]].filter(([key]) => suggestion[key] === null).map(([, label]) => label);
      fill(root, "ocr-status", missing.length ? `Could not read: ${missing.join(", ")}. Type those in below.` : "");
      // Only a redacted transcript is shown; the raw text is discarded.
      fill(root, "ocr-review", `<details class="raw-ocr-drawer"><summary>View recognized text (personal details redacted)</summary><pre translate="no">${ctx.escape(redactBillText(scan.text))}</pre></details>`);
    } catch (error) {
      fill(root, "ocr-status", `${ctx.escape(errorMessage(error))} You can still enter the values manually.`);
    } finally {
      billScan.busy = false;
      renderBillScanner(root);
      ctx.translate?.(root);
    }
  },
};

Object.assign(billScannerActions, {
  /** Live camera scanner with quality guide + crop. Starting on an empty Front page runs the
   *  guided flow from the jrmph scanner: Front → Back (or skip) → scan automatically. */
  async "scan-camera"(button, ctx) {
    const side = button.dataset.side === "back" ? "back" : "front";
    const guided = side === "front" && !billScan.shots.front.length;
    const shoot = (which) => openBillCamera({
      title: which === "front" ? "Front of the bill" : "Back of the bill",
      hint: which === "front" ? `Up to ${MAX_SHOTS} photos${guided ? ", then the back page" : ""}` : `Up to ${MAX_SHOTS} photos${guided ? ", then it scans automatically" : ""}`,
      room: MAX_SHOTS - billScan.shots[which].length,
      nextLabel: which === "front" && guided ? "Next ➜ Back" : "Done ✓",
      onSkip: which === "back" ? () => undefined : undefined,
    });
    const files = await shoot(side);
    addShots(side, files, ctx);
    if (!guided || !files.length) return;
    billScan.step = 2;
    renderBillScanner();
    addShots("back", await shoot("back"), ctx);
    billScan.step = 3;
    renderBillScanner();
    await billScannerActions["scan-run"](button, ctx);
  },
  /** Re-crop a photo that is already in the list (e.g. an uploaded one). */
  async "scan-crop"(button, ctx) {
    const shot = billScan.shots[button.dataset.side]?.find((s) => s.id === button.dataset.id);
    if (!shot) return;
    const cropped = await openCropEditor(shot.file, { title: "Crop the bill", allowSkip: false });
    if (!cropped) return;
    URL.revokeObjectURL(shot.url);
    Object.assign(shot, { file: cropped, url: URL.createObjectURL(cropped), warnings: [], checking: true });
    renderBillScanner();
    photoQuality(cropped).then((w) => { shot.warnings = w; }).catch(() => undefined).finally(() => { shot.checking = false; renderBillScanner(); ctx.translate?.(document.querySelector("#content")); });
  },
});

function addShots(side, files, ctx) {
  const list = billScan.shots[side];
  for (const file of files) {
    if (list.length >= MAX_SHOTS) break;
    const isImage = file.type.startsWith("image/");
    const isPdfFile = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isImage && !isPdfFile) { ctx.toast?.(`"${file.name}" is not a photo or PDF.`); continue; }
    const shot = { id: `s${++shotSeq}`, file, url: isImage ? URL.createObjectURL(file) : null, warnings: [], checking: isImage };
    list.push(shot);
    if (isImage) {
      photoQuality(file)
        .then((w) => { shot.warnings = w; })
        .catch(() => undefined)
        .finally(() => { shot.checking = false; renderBillScanner(); });
    }
  }
  renderBillScanner();
  ctx.translate?.(document.querySelector("#content"));
}

/** Photo/PDF chosen with "Upload": add it to the Front or Back shots. */
export async function handlePersonalBillOcr(input, ctx) {
  const side = input.dataset.side === "back" ? "back" : "front";
  const files = [...(input.files ?? [])];
  input.value = "";
  if (files.length) addShots(side, files, ctx);
}

// Register the wizard actions with the other personal actions (dispatched by app.js).
Object.assign(personalActions, billScannerActions, billCalendarActions);

export async function handleApplianceLabelScan(input, ctx) {
  const file = input.files?.[0];
  input.value = "";
  if (file) await startApplianceScan(file, ctx);
}

// "📷 Scan Appliance Label": Lens-style live camera → crop → scan with highlighted results.
Object.assign(personalActions, {
  async "appliance-camera"(_button, ctx) {
    const [file] = await openBillCamera({
      title: "Scan appliance label",
      hint: "Fit the rating plate or energy label inside the frame",
      room: 1,
      nextLabel: "Scan ✓",
      variant: "lens",
    });
    if (file) await startApplianceScan(file, ctx);
  },
  "preset-use"(button) {
    applyPresetWatts(button);
  },
  /** Register an appliance straight from the catalog with its typical wattage. */
  async "catalog-add"(button, ctx) {
    const preset = ALL_APPLIANCES[Number(button.dataset.index)];
    if (!preset) return;
    await saveAppliance({
      name: preset.name.slice(0, 60),
      category: preset.category,
      watts: preset.typicalWatts,
      quantity: 1,
      hoursPerDay: preset.hoursPerDay,
      daysPerWeek: 7,
      scheduleNote: "Typical value — edit to match your label",
      brand: null,
      model: null,
      voltage: null,
      source: "manual",
      testedKwhMonth: null,
      energyEfficiencyRating: null,
      labelType: null,
      consumptionBasis: "wattage",
    });
    ctx.toast(`${preset.name} added with ${fmtW(preset.typicalWatts)} (typical). Edit it to match your label.`);
    window.dispatchEvent(new CustomEvent("smartwatts-appliance-saved", { detail: preset.name }));
    ctx.render();
  },
  "lens-focus"(button) {
    const field = document.querySelector(`[data-form="appliance-save"] [name="${button.dataset.field}"]`);
    if (!field) return;
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    field.focus({ preventScroll: true });
    field.classList.add("lens-flash");
    setTimeout(() => field.classList.remove("lens-flash"), 1200);
  },
});

async function startApplianceScan(file, ctx) {
  const root = document.querySelector("#content");
  if (!file.type.startsWith("image/")) {
    ctx.toast("Please choose an image file (PNG, JPG, WebP), or enter details manually.");
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    ctx.toast("Image file is too large (maximum 15 MB).");
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
  }
}

