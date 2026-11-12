// Watts Coins rewards: quest-gated daily check-ins, two small daily quests, and
// bill-verified monthly kWh reductions.
const CHART_COLORS = ["#ff7a00", "#ffc700", "#e6a000", "#a55300"];
const DEFAULT_MONTHLY_TARGET = 320;
const MONTHLY_USAGE = 342.18;
const ENERGY_TARGET_KEY = "smartwatts-monthly-target";
const COIN_STORAGE_PREFIX = "smartwatts-coins";
const CHECK_IN_REWARDS_CENTS = [50, 50, 50, 50, 75, 75, 150];
const QUEST_REWARD_CENTS = 5;
const TIP_READ_SECONDS = 15;
const QUESTS = {
  tip: { source: "Energy Tip of the Day Quest", label: "Energy Tip of the Day" },
  forecast: { source: "Daily Cost Forecast Quest", label: "Daily Cost Forecast Check" },
};
const ENERGY_TIPS = [
  "Set your air conditioner to 25°C. Each degree cooler can add several percent to its energy use.",
  "Clean your aircon filter every two weeks. A clogged filter makes the compressor work longer.",
  "Unplug chargers, TVs, and set-top boxes you are not using. Standby power adds up every day.",
  "Keep your refrigerator door closed and let hot food cool before storing it.",
  "Leave a few centimetres of space behind the refrigerator so its coils can release heat.",
  "Use an electric fan instead of the aircon on milder nights. Fans use a fraction of the power.",
  "Switch to LED bulbs. They use far less electricity than incandescent bulbs for the same light.",
  "Iron clothes in one batch instead of a few pieces every day to avoid repeated heat-up.",
  "Run the washing machine with full loads and use the shortest suitable cycle.",
  "Turn off the rice cooker's keep-warm mode when the rice will not be eaten soon.",
  "Close curtains during the hottest hours so your room stays cooler with less cooling.",
  "Check the yellow Energy Label before buying an appliance and compare its kWh per year.",
];

const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let gameUiCallbacks = {
  render() {},
  toast() {},
  pageHead() {},
  stat() {},
  panel() {},
  language() { return "en"; },
};

function setGameCallbacks(callbacks) {
  gameUiCallbacks = callbacks;
}

// State (in-memory first so the demo still works when browser storage is blocked)
let energyTargetCache = DEFAULT_MONTHLY_TARGET;
let currentGameUser = "guest";
const coinMemory = new Map();
// Energy tip reading session (in memory: a page reload restarts the 15-second read).
let tipReading = null; // { date, user, startedAt }
let tipTimer = null;
let activeRateCentavos = null;

function getManilaDateString(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function setGameUser(userId) {
  currentGameUser = userId || "guest";
}

function getCoinStorageKey() {
  return currentGameUser === "guest" ? COIN_STORAGE_PREFIX : `${COIN_STORAGE_PREFIX}-${currentGameUser}`;
}

function addCalendarMonths(date, months = 3) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function newCoinState() {
  return { batches: [], ledger: [], lastCheckIn: null, streak: 0, claimedCycles: [], quests: { date: null, done: [] } };
}

function saveCoinState(state) {
  coinMemory.set(getCoinStorageKey(), state);
  try { localStorage.setItem(getCoinStorageKey(), JSON.stringify(state)); } catch { /* session-only fallback */ }
  return state;
}

function getCoinState({ reconcile = true } = {}) {
  let state = null;
  try { state = JSON.parse(localStorage.getItem(getCoinStorageKey()) || "null"); } catch { state = null; }
  if (!state) state = coinMemory.get(getCoinStorageKey()) || null;
  if (!state || !Array.isArray(state.batches) || !Array.isArray(state.ledger)) state = newCoinState();
  state.lastCheckIn = typeof state.lastCheckIn === "string" ? state.lastCheckIn : null;
  state.streak = Number.isInteger(state.streak) && state.streak > 0 ? state.streak : 0;
  state.claimedCycles = Array.isArray(state.claimedCycles) ? state.claimedCycles : [];
  const quests = state.quests && typeof state.quests === "object" ? state.quests : {};
  state.quests = {
    date: typeof quests.date === "string" ? quests.date : null,
    done: Array.isArray(quests.done) ? quests.done.filter((id) => id in QUESTS) : [],
  };
  if (reconcile) {
    const now = new Date();
    let changed = false;
    for (const batch of state.batches) {
      if (!Number.isInteger(batch.remainingCents) || batch.remainingCents <= 0) continue;
      const expiresAt = new Date(batch.expiresAt);
      if (!Number.isFinite(expiresAt.getTime())) continue;
      if (now >= expiresAt) {
        const expired = batch.remainingCents;
        batch.remainingCents = 0;
        state.ledger.unshift({ id: `expire-${batch.id}`, kind: "expiration", source: "Coins expiration (3-month validity ended)", amountCents: -expired, date: now.toISOString(), batchId: batch.id });
        changed = true;
        window.dispatchEvent(new CustomEvent("smartwatts-coins-expired", { detail: { amountCents: expired, expiresAt: batch.expiresAt } }));
      } else if (!batch.expiryNoticeSent && now >= new Date(expiresAt.getTime() - 7 * 86400000)) {
        batch.expiryNoticeSent = true;
        changed = true;
        window.dispatchEvent(new CustomEvent("smartwatts-coins-expiring", { detail: { amountCents: batch.remainingCents, expiresAt: batch.expiresAt } }));
      }
    }
    if (changed) saveCoinState(state);
  }
  return state;
}

function coinBalanceCents(state = getCoinState()) {
  return state.batches.reduce((total, batch) => total + Math.max(0, batch.remainingCents || 0), 0);
}

function formatCoins(cents) {
  return (cents / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function addCoinBatch(amountCents, source, date = new Date(), metadata = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new RangeError("Coin amount must be positive centavos.");
  const state = getCoinState();
  const earnedAt = new Date(date);
  const batch = {
    id: `coin-${earnedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    amountCents,
    remainingCents: amountCents,
    earnedDate: earnedAt.toISOString(),
    expiresAt: addCalendarMonths(earnedAt).toISOString(),
    source,
    expiryNoticeSent: false,
    ...metadata,
  };
  state.batches.push(batch);
  state.ledger.unshift({ id: batch.id, kind: "earning", source, amountCents, date: earnedAt.toISOString(), batchId: batch.id });
  saveCoinState(state);
  window.dispatchEvent(new CustomEvent("smartwatts-coins-earned", { detail: { amountCents, source } }));
  return batch;
}

function coinSummaryHtml() {
  const state = getCoinState();
  const balance = coinBalanceCents(state);
  const next = state.batches.filter((b) => b.remainingCents > 0).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];
  const language = gameUiCallbacks.language();
  const expiryDate = next ? new Date(next.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
  const expiryNotice = next
    ? language === "tl"
      ? `${formatCoins(next.remainingCents)} coin(s) mag-e-expire sa ${expiryDate}`
      : language === "tl-taglish"
        ? `${formatCoins(next.remainingCents)} coin(s) mag-e-expire sa ${expiryDate}`
        : `${formatCoins(next.remainingCents)} coin(s) expiring on ${expiryDate}`
    : language === "tl" ? "Dito lalabas ang mga coin na nakuha mo." : "Your earned coins will appear here.";
  return `<div class="coin-balance-card"><div><small>WATTS COINS BALANCE</small><strong>${formatCoins(balance)} Watts Coins <span>(₱${formatCoins(balance)})</span></strong></div><a href="#" data-action="coin-history" class="text-link">History →</a>
    <p class="coin-expiration">${expiryNotice} <span class="coin-info" tabindex="0" title="Each earned coin batch is valid for exactly three calendar months from its earn date.">?</span></p>
    <div class="coin-lock">🔒 Locked · Pending for Next Bill <span>Coins become usable only during your monthly bill payment or subscription renewal window.</span></div></div>`;
}

// Daily quests
function completedQuestsToday(state = getCoinState()) {
  return state.quests.date === getManilaDateString() ? [...state.quests.done] : [];
}

function completeQuest(questId) {
  const quest = QUESTS[questId];
  if (!quest) return false;
  const state = getCoinState();
  const today = getManilaDateString();
  if (state.quests.date !== today) state.quests = { date: today, done: [] };
  if (state.quests.done.includes(questId)) return false;
  state.quests.done.push(questId);
  saveCoinState(state);
  addCoinBatch(QUEST_REWARD_CENTS, quest.source, new Date(), { questId, questDate: today });
  return true;
}

function todaysEnergyTip(date = getManilaDateString()) {
  const [y, m, d] = date.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return ENERGY_TIPS[((dayNumber % ENERGY_TIPS.length) + ENERGY_TIPS.length) % ENERGY_TIPS.length];
}

function tipSecondsLeft() {
  if (!tipReading || tipReading.date !== getManilaDateString() || tipReading.user !== currentGameUser) return null;
  return Math.max(0, TIP_READ_SECONDS - Math.floor((Date.now() - tipReading.startedAt) / 1000));
}

function startTipReading() {
  if (completedQuestsToday().includes("tip")) return false;
  if (tipSecondsLeft() === null) tipReading = { date: getManilaDateString(), user: currentGameUser, startedAt: Date.now() };
  hydrateDailyQuests();
  return true;
}

function claimTipQuest() {
  const left = tipSecondsLeft();
  if (left === null || left > 0) {
    gameUiCallbacks.toast(`Read the tip for ${TIP_READ_SECONDS} seconds before claiming.`);
    return false;
  }
  if (!completeQuest("tip")) {
    gameUiCallbacks.toast("You already finished today's Energy Tip quest.");
    return false;
  }
  tipReading = null;
  gameUiCallbacks.toast(`Energy Tip quest complete! +${formatCoins(QUEST_REWARD_CENTS)} Watts Coins.`);
  gameUiCallbacks.render();
  return true;
}

function forecastDailyCost(watts, hours, rateCentavos) {
  const w = Number(watts), h = Number(hours), r = Number(rateCentavos);
  if (!Number.isFinite(w) || w <= 0 || w > 50000) throw new RangeError("Enter the appliance wattage (1 to 50,000 W).");
  if (!Number.isFinite(h) || h <= 0 || h > 24) throw new RangeError("Enter today's hours of use (up to 24).");
  if (!Number.isFinite(r) || r <= 0 || r > 10000) throw new RangeError("Enter your rate per kWh, e.g. 12.25.");
  const kwh = (w * h) / 1000;
  return { kwh, costCentavos: Math.round(kwh * r) };
}

function submitCostForecast(form) {
  const data = new FormData(form);
  let result;
  try {
    result = forecastDailyCost(data.get("watts"), data.get("hours"), Math.round(Number(data.get("rate")) * 100));
  } catch (error) {
    gameUiCallbacks.toast(error.message);
    return false;
  }
  const cost = (result.costCentavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const message = `Forecast: ${result.kwh.toFixed(2)} kWh today ≈ ₱${cost}`;
  const awarded = completeQuest("forecast");
  gameUiCallbacks.toast(awarded ? `${message}. Cost Forecast quest complete! +${formatCoins(QUEST_REWARD_CENTS)} Watts Coins.` : `${message}.`);
  if (awarded) gameUiCallbacks.render();
  const output = document.querySelector("#forecastResult");
  if (output) output.textContent = `${message} (estimate only; your bill includes other charges).`;
  return true;
}

function setActiveRate(rateCentavos) {
  activeRateCentavos = Number.isFinite(rateCentavos) && rateCentavos > 0 ? Math.round(rateCentavos) : null;
  const input = document.querySelector("#forecastRate");
  if (input && !input.value && activeRateCentavos) input.value = (activeRateCentavos / 100).toFixed(2);
}

// Keeps the tip countdown and the claim button in sync after each render.
function hydrateDailyQuests() {
  if (tipTimer) { clearInterval(tipTimer); tipTimer = null; }
  const card = document.querySelector(".quest-tip");
  if (!card) return;
  const update = () => {
    const left = tipSecondsLeft();
    const body = card.querySelector(".quest-tip-body");
    const claim = card.querySelector('[data-action="quest-tip-claim"]');
    const open = card.querySelector('[data-action="quest-tip-open"]');
    if (left === null || !body || !claim) return false;
    body.hidden = false;
    if (open) open.hidden = true;
    claim.hidden = false;
    claim.disabled = left > 0;
    claim.textContent = left > 0 ? `Keep reading… ${left}s` : `Claim +${formatCoins(QUEST_REWARD_CENTS)} coins`;
    return left > 0;
  };
  if (update()) {
    tipTimer = setInterval(() => {
      if (!document.body.contains(card) || !update()) { clearInterval(tipTimer); tipTimer = null; }
    }, 250);
  }
}

function dailyQuestsHtml(state) {
  const done = completedQuestsToday(state);
  const tipDone = done.includes("tip");
  const forecastDone = done.includes("forecast");
  const reward = `+${formatCoins(QUEST_REWARD_CENTS)}`;
  const rateValue = activeRateCentavos ? (activeRateCentavos / 100).toFixed(2) : "";
  return `
      <div class="daily-quests" aria-label="Daily quests">
        <article class="quest-card quest-tip ${tipDone ? "done" : ""}">
          <div class="quest-head"><span class="quest-badge">Read &amp; Learn</span><b>${QUESTS.tip.label}</b><span class="quest-reward">${tipDone ? "✓ Done" : reward}</span></div>
          ${tipDone
            ? `<p class="quest-tip-text">${todaysEnergyTip()}</p>`
            : `<p class="stat-foot">Read today's ${TIP_READ_SECONDS}-second energy-saving tip.</p>
               <div class="quest-tip-body" hidden><p class="quest-tip-text">${todaysEnergyTip()}</p></div>
               <div class="quest-actions"><button class="btn btn-outline" data-action="quest-tip-open">Read today's tip</button><button class="btn btn-primary" data-action="quest-tip-claim" hidden disabled>Keep reading… ${TIP_READ_SECONDS}s</button></div>`}
        </article>
        <article class="quest-card quest-forecast ${forecastDone ? "done" : ""}">
          <div class="quest-head"><span class="quest-badge">Planning</span><b>${QUESTS.forecast.label}</b><span class="quest-reward">${forecastDone ? "✓ Done" : reward}</span></div>
          <p class="stat-foot">Use the appliance calculator to forecast today's cost with your active rate.</p>
          <form id="costForecastForm" class="quest-forecast-form">
            <label>Wattage (W)<input name="watts" type="number" min="1" max="50000" step="any" inputmode="decimal" required placeholder="1000"></label>
            <label>Hours today<input name="hours" type="number" min="0.1" max="24" step="any" inputmode="decimal" required placeholder="8"></label>
            <label>Rate (₱/kWh)<input id="forecastRate" name="rate" type="number" min="0.01" step="0.01" inputmode="decimal" required value="${rateValue}" placeholder="12.25"></label>
            <button class="btn btn-outline" type="submit">Forecast cost</button>
          </form>
          <p id="forecastResult" class="quest-result" aria-live="polite"></p>
        </article>
      </div>`;
}

function checkIn(source) {
  const state = getCoinState();
  if (!completedQuestsToday(state).length) {
    gameUiCallbacks.toast("Finish at least one daily quest (Energy Tip or Cost Forecast) to unlock today's check-in.");
    return false;
  }
  const today = getManilaDateString();
  if (state.lastCheckIn === today) {
    gameUiCallbacks.toast("You already checked in today. Come back tomorrow!");
    return false;
  }
  if (state.lastCheckIn) {
    const days = Math.round((Date.parse(`${today}T00:00:00+08:00`) - Date.parse(`${state.lastCheckIn}T00:00:00+08:00`)) / 86400000);
    state.streak = days === 1 ? state.streak : 0;
  } else state.streak = 0;
  const day = (state.streak % 7) + 1;
  state.streak += 1;
  state.lastCheckIn = today;
  saveCoinState(state);
  const amount = CHECK_IN_REWARDS_CENTS[day - 1];
  addCoinBatch(amount, day === 7 ? "7-Day Streak Completed Bonus" : "Daily Check-In", new Date(), { checkInDay: day });
  gameUiCallbacks.toast(`Check-in complete! +${formatCoins(amount)} Watts Coins.`);
  gameUiCallbacks.render();
  return true;
}

function awardMonthlyReduction(currentKwh, previousKwh, cycleId) {
  const current = Number(currentKwh), previous = Number(previousKwh);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current >= previous) return 0;
  const state = getCoinState();
  if (state.claimedCycles.includes(cycleId)) return 0;
  const amountCents = Math.min(1500, Math.round((previous - current) * 20));
  if (amountCents <= 0) return 0;
  state.claimedCycles.push(cycleId);
  saveCoinState(state);
  addCoinBatch(amountCents, `Monthly kWh Reduction Bonus · ${(previous - current).toFixed(2)} kWh Saved`, new Date(), { cycleId, previousKwh: previous, currentKwh: current });
  return amountCents;
}

function redeemCoinBatches(amountCents, windowActive = false, destination = "bill") {
  if (!windowActive) throw new Error("Watts Coins can only be redeemed during the bill payment or subscription renewal window.");
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new RangeError("Enter a valid coin amount.");
  const state = getCoinState();
  if (amountCents > coinBalanceCents(state)) throw new RangeError("Not enough available Watts Coins.");
  let remaining = amountCents;
  for (const batch of state.batches.filter((b) => b.remainingCents > 0).sort((a, b) => a.earnedDate.localeCompare(b.earnedDate))) {
    const used = Math.min(remaining, batch.remainingCents);
    batch.remainingCents -= used;
    remaining -= used;
    if (!remaining) break;
  }
  state.ledger.unshift({ id: `redeem-${Date.now()}`, kind: "spending", source: destination === "subscription" ? "Redeemed with Subscription" : "Redeemed with Bill Payment", amountCents: -amountCents, date: new Date().toISOString() });
  saveCoinState(state);
  return amountCents;
}

function getMonthlyEnergyTarget() {
  try {
    const stored = Number(localStorage.getItem(ENERGY_TARGET_KEY));
    if (Number.isFinite(stored) && stored >= 50 && stored <= 2000) {
      energyTargetCache = stored;
    }
  } catch {
    // Keep the in-memory target when browser storage is unavailable.
  }
  return energyTargetCache;
}

function saveMonthlyEnergyTarget(target) {
  if (!Number.isFinite(target) || target < 50 || target > 2000) return false;
  energyTargetCache = target;
  try {
    localStorage.setItem(ENERGY_TARGET_KEY, String(target));
    return true;
  } catch {
    return false;
  }
}

function gamificationCard() {
  const state = getCoinState();
  const checkedToday = state.lastCheckIn === getManilaDateString();
  const unlocked = completedQuestsToday(state).length > 0;
  const completedInCycle = checkedToday ? ((state.streak - 1) % 7) + 1 : state.streak % 7;
  const upcomingDay = checkedToday ? (completedInCycle === 7 ? 1 : completedInCycle + 1) : (completedInCycle === 0 ? 1 : completedInCycle + 1);
  const labels = ["Today", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"];
  const tracker = labels.map((label, index) => {
    const done = checkedToday ? index < completedInCycle : index < completedInCycle;
    const today = index === upcomingDay - 1 && !checkedToday;
    const completedToday = checkedToday && index === completedInCycle - 1;
    return `<div class="coin-day ${done ? "done" : ""} ${today || completedToday ? "today" : ""}"><span>${done ? "✓" : `+${formatCoins(CHECK_IN_REWARDS_CENTS[index])}`}</span><small>${today || completedToday ? "Today" : label}</small></div>`;
  }).join("");
  return `
    <section class="game-card coin-checkin-card" aria-label="Daily Watts Coins check-in">
      <div class="coin-checkin-head"><div><small>7-DAY DAILY CHECK-IN STREAK</small><h2>Small habits, real rewards.</h2><p>Earn 5.00 Watts Coins (₱5.00) for a complete seven-day cycle.</p></div><button class="btn btn-outline" data-page="rewards">View Watts Coins</button></div>
      <div class="coin-streak-tracker">${tracker}</div>
      ${dailyQuestsHtml(state)}
      <div class="coin-checkin-footer"><p class="quest-gate">${checkedToday ? "Come back tomorrow to keep your streak." : unlocked ? "🔓 Check-in unlocked. Claim today's coins." : "🔒 Complete at least one daily quest above to unlock today's check-in."}</p><button class="btn btn-primary" data-action="checkin" ${checkedToday || !unlocked ? "disabled" : ""}>${checkedToday ? "Checked in today" : "Check in to get coins"}</button></div>
    </section>`;
}

// Goals
function ring(pct, label, sub) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const shown = Math.min(100, pct);
  const over = pct > 100;
  return `
    <div class="ring ${over ? "over" : ""}">
      <svg viewBox="0 0 130 130" width="170" height="170" role="img" aria-label="${label} ${sub}">
        <circle cx="65" cy="65" r="${r}" fill="none" stroke="#f6ecd8" stroke-width="16"/>
        <circle class="ring-arc" cx="65" cy="65" r="${r}" fill="none" stroke-width="16" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - shown / 100)).toFixed(1)}" transform="rotate(-90 65 65)"/>
      </svg>
      <div class="ring-center"><strong>${label}</strong><small>${sub}</small></div>
    </div>`;
}

function goalsPage() {
  const target = getMonthlyEnergyTarget();
  const used = MONTHLY_USAGE;
  const pct = Math.round((used / target) * 100);
  const targetLabel = target.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const percentageLabel = pct > 999 ? "999+%" : `${pct}%`;
  const difference = Math.abs(used - target).toFixed(2);
  const usageMessage = used > target
    ? `You're ${difference} kWh over your monthly target. Reduce usage to get back on track.`
    : used < target
      ? `You have ${difference} kWh left before reaching your monthly target.`
      : "You've reached your monthly energy target. Keep it up!";
  const targetFoot = used > target
    ? `${difference} kWh above target`
    : `${Math.max(0, target - used).toFixed(2)} kWh remaining`;
  return `
    ${gameUiCallbacks.pageHead("Your energy goals", "Set realistic targets and build lower-energy habits.")}
    <div class="grid stats">
      ${gameUiCallbacks.stat("target", "Monthly Target", targetLabel, "kWh", "Your chosen goal", "")}
      ${gameUiCallbacks.stat("chart-no-axes-column-increasing", "Used This Month", MONTHLY_USAGE.toFixed(2), "kWh", targetFoot, "")}
      ${gameUiCallbacks.stat("zap", "Daily Target", (target / 31).toFixed(1), "kWh", "Average daily goal", "")}
      ${gameUiCallbacks.stat("trophy", "Watts Coins", formatCoins(coinBalanceCents()), "coins", "₱1.00 per coin", "")}
    </div>
    <div class="two-panels goal-panels">
      ${gameUiCallbacks.panel(
        "Monthly energy target",
        `<div class="goal-target-outline">
           <div class="goal-ring-row">
             ${ring(pct, percentageLabel, "of target")}
             <div class="goal-copy">
               <strong>${MONTHLY_USAGE.toFixed(2)} / ${targetLabel} kWh</strong>
               <p class="stat-foot">${usageMessage}</p>
               <span class="reward-pill">Daily check-ins earn up to 1.50 coins on Day 7</span>
             </div>
           </div>
         </div>`,
      )}
      ${gameUiCallbacks.panel("Earn Watts Coins", `<p>Earn coins from the 7-day check-in streak, two daily quests (+0.05 each), and a verified decrease in monthly kWh.</p><button class="btn btn-outline" data-page="rewards">View earning options</button>`)}
    </div>
    ${gameUiCallbacks.panel(
      "Adjust your monthly target",
      `<form id="energyGoalForm" class="energy-goal-form">
         <label for="monthlyEnergyTarget">Monthly target (kWh)</label>
         <div class="energy-goal-controls">
           <input id="monthlyEnergyTarget" name="target" type="number" min="50" max="2000" step="1" value="${target}" required>
           <button class="btn btn-primary" type="submit">Save target</button>
         </div>
         <small>Choose a monthly target between 50 and 2,000 kWh.</small>
       </form>`,
    )}
    `;
}

function rewardsPage() {
  const state = getCoinState();
  const historyTab = window.__smartWattsCoinTab || "all";
  const records = state.ledger.filter((item) => historyTab === "all" || (historyTab === "earning" ? item.kind === "earning" : item.kind !== "earning"));
  const history = records.length ? records.map((item) => {
    const expired = item.kind === "expiration";
    const positive = item.amountCents > 0;
    const value = `${positive ? "+" : "-"}${formatCoins(Math.abs(item.amountCents))}`;
    const date = new Date(item.date).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
    const batch = item.kind === "earning" ? state.batches.find((b) => b.id === item.batchId) : null;
    const detail = item.source === "Daily Check-In" && batch ? `Daily Check-In (expires ${new Date(batch.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" })})` : item.source;
    return `<div class="coin-ledger-row ${expired ? "expired" : ""}"><span class="coin-ledger-icon">◉</span><div><b>${detail}</b><small>${date}</small></div><strong class="${positive ? "positive" : "negative"}">${value}</strong></div>`;
  }).join("") : `<p class="empty-note">No coin transactions yet. Complete a daily quest, check in, or save a lower monthly bill.</p>`;
  return `
    ${gameUiCallbacks.pageHead("Watts Coins", "Earn coins through daily quests, check-ins, and verified monthly energy savings.", `<button class="btn btn-outline" data-page="bills">Earn More Coins</button>`)}
    ${coinSummaryHtml()}
    ${gamificationCard()}
    ${gameUiCallbacks.panel("Monthly Consumption Reduction Mission", `<p>At the end of the month, upload your Meralco bill (Personal) or your condo/apartment utility SOA or sub-meter slip (Rentals). If your kWh went down versus the previous month, you earn 0.20 Watts Coins (₱0.20) per kWh reduced, up to 15.00 Watts Coins per billing cycle.</p><button class="btn btn-outline" data-page="bills">Upload / review monthly bill</button>`)}
    ${gameUiCallbacks.panel("My Watts Coins", `<div class="coin-tabs" role="tablist"><button data-coin-tab="all" class="${historyTab === "all" ? "active" : ""}">ALL HISTORY</button><button data-coin-tab="earning" class="${historyTab === "earning" ? "active" : ""}">EARNING</button><button data-coin-tab="spending" class="${historyTab === "spending" ? "active" : ""}">SPENDING</button></div><div class="coin-ledger" id="coin-ledger">${history}</div>`, `<span class="reward-pill">${formatCoins(coinBalanceCents(state))} available · locked</span>`)}
    <p class="about-note">Coin balance and expiry are stored in this browser for this account. Real bill payment, subscription renewal, and external utility verification are not connected in this demo.</p>`;
}

// Chrome: top chips, mobile tab highlight, count-up numbers
function renderGameChrome(currentPage) {
  const coins = coinBalanceCents();
  const chips = document.querySelector("#chips");
  if (chips) {
    chips.innerHTML = `
      <button class="chip chip-xp" data-page="rewards" aria-label="${formatCoins(coins)} Watts Coins">🪙 <b>${formatCoins(coins)}</b></button>`;
  }
  document.querySelectorAll(".mobile-tabbar [data-page]").forEach((button) => {
    const on = button.dataset.page === currentPage;
    button.classList.toggle("active", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function animateNumbers() {
  if (reducedMotion()) return;
  document.querySelectorAll(".stat-value").forEach((el) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return;
    const match = node.textContent.match(/^(₱?)([\d,]+(?:\.\d+)?)([\s\S]*)$/);
    if (!match) return;
    const [, prefix, raw, suffix] = match;
    const target = parseFloat(raw.replace(/,/g, ""));
    const decimals = (raw.split(".")[1] || "").length;
    const start = performance.now();
    const duration = 750;
    const format = (value) => value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: raw.includes(",") });
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = t < 1 ? `${prefix}${format(target * eased)}${suffix}` : `${prefix}${raw}${suffix}`;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export {
  addCalendarMonths,
  addCoinBatch,
  animateNumbers,
  awardMonthlyReduction,
  CHART_COLORS,
  checkIn,
  claimTipQuest,
  completedQuestsToday,
  completeQuest,
  forecastDailyCost,
  gamificationCard,
  hydrateDailyQuests,
  setActiveRate,
  startTipReading,
  submitCostForecast,
  todaysEnergyTip,
  getMonthlyEnergyTarget,
  getCoinState,
  coinBalanceCents,
  formatCoins,
  goalsPage,
  redeemCoinBatches,
  renderGameChrome,
  rewardsPage,
  saveMonthlyEnergyTarget,
  setGameCallbacks,
  setGameUser,
};
