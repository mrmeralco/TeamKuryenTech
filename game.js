// Watts Coins rewards: task-gated check-ins and bill-verified monthly reductions only.
const CHART_COLORS = ["#ff7a00", "#ffc700", "#e6a000", "#a55300"];
const DEFAULT_MONTHLY_TARGET = 320;
const MONTHLY_USAGE = 342.18;
const ENERGY_TARGET_KEY = "smartwatts-monthly-target";
const COIN_STORAGE_PREFIX = "smartwatts-coins";
const CHECK_IN_REWARDS_CENTS = [50, 50, 50, 50, 75, 75, 150];

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
  return { batches: [], ledger: [], lastCheckIn: null, streak: 0, claimedCycles: [] };
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

function checkIn(source) {
  const habit = document.querySelector("#dailyHabitCheck");
  if (!habit?.checked) {
    gameUiCallbacks.toast("Complete today's energy-saving habit check before claiming your coins.");
    return false;
  }
  const state = getCoinState();
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
      <div class="coin-checkin-footer"><label><input id="dailyHabitCheck" type="checkbox" ${checkedToday ? "disabled" : ""}> I completed one energy-saving habit today.</label><button class="btn btn-primary" data-action="checkin" disabled>${checkedToday ? "Checked in today" : "Check in to get coins"}</button></div>
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
      ${gameUiCallbacks.panel("Earn Watts Coins", `<p>Only two earning sources are available: daily check-ins and a verified decrease in monthly kWh.</p><button class="btn btn-outline" data-page="rewards">View earning options</button>`)}
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
  }).join("") : `<p class="empty-note">No coin transactions yet. Complete a daily check-in or save a lower monthly bill.</p>`;
  return `
    ${gameUiCallbacks.pageHead("Watts Coins", "Earn coins through daily check-ins and verified monthly energy savings.", `<button class="btn btn-outline" data-page="bills">Earn More Coins</button>`)}
    ${coinSummaryHtml()}
    ${gameUiCallbacks.panel("Monthly kWh Reduction Bonus", `<p>Save at least 1 kWh against your previous saved bill to earn ₱0.20 per kWh reduced, up to 15.00 Watts Coins per billing cycle. Review and save your monthly bill to compare usage.</p><button class="btn btn-outline" data-page="bills">Upload / review monthly bill</button>`)}
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
  gamificationCard,
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
