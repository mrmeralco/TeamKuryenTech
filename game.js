// SmartWatts game layer: levels, quests, badges, mascot, confetti.
// Loaded before app.js so its function declarations are available to the page renderers.
// All progress is demo data stored in this browser only.

const LEVEL_STEP = 100;
const LEVEL_TITLES = ["Spark", "Bulb Buddy", "Watt Watcher", "Power Saver", "Grid Guardian", "Energy Hero", "Volt Legend"];
const CHART_COLORS = ["#ff7a00", "#ffc700", "#e6a000", "#a55300"];
const DEFAULT_MONTHLY_TARGET = 320;
const MONTHLY_USAGE = 342.18;
const ENERGY_TARGET_KEY = "smartwatts-monthly-target";

const QUESTS = [
  { id: "daily", icon: "🌿", title: "Power down for an hour", desc: "Switch off unused lights and appliances for one hour.", pts: 20, color: "#ff7a00", tint: "#fff0dc" },
  { id: "ac", icon: "❄️", title: "Set the AC to 25°C", desc: "A slightly warmer setting can trim cooling energy.", pts: 30, color: "#ffc700", tint: "#fff9db" },
  { id: "standby", icon: "🔌", title: "Unplug standby gadgets", desc: "Chargers and TVs sip power even when idle.", pts: 15, color: "#a55300", tint: "#fff1bf" },
  { id: "daylight", icon: "☀️", title: "Use daylight until 5 PM", desc: "Open the curtains and keep the lights off.", pts: 25, color: "#e6a000", tint: "#fff7db" },
  { id: "laundry", icon: "🧺", title: "Wash a full load", desc: "Fewer, fuller loads use less energy overall.", pts: 20, color: "#ff7a00", tint: "#fff0dc" },
];

const VALID_QUEST_IDS = new Set(QUESTS.map(({ id }) => id));

const BADGES = [
  { icon: "🌱", name: "First Step", desc: "Complete your first quest", test: (g) => g.completed.length >= 1 },
  { icon: "❄️", name: "Cool Operator", desc: "Finish the AC quest", test: (g) => g.completed.includes("ac") },
  { icon: "🔌", name: "Phantom Hunter", desc: "Unplug standby gadgets", test: (g) => g.completed.includes("standby") },
  { icon: "☀️", name: "Daylight Dynamo", desc: "Use daylight until 5 PM", test: (g) => g.completed.includes("daylight") },
  { icon: "💡", name: "Energy Champion", desc: "Complete all 5 quests", test: (g) => g.completed.length >= QUESTS.length },
  { icon: "🔥", name: "Consistency Star", desc: "Reach a 7-day streak", test: (g) => g.streak >= 7 },
  { icon: "🚀", name: "Rocket Rank", desc: "Reach level 3", test: (g) => levelInfo(g.points).level >= 3 },
  { icon: "👑", name: "Watt Royalty", desc: "Earn 300 points", test: (g) => g.points >= 300 },
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
let gameCache = null;
let energyTargetCache = DEFAULT_MONTHLY_TARGET;

function getGameState() {
  if (gameCache) return gameCache;
  let loaded = null;
  try {
    loaded = JSON.parse(localStorage.getItem("smartwatts-game") || "null");
  } catch {
    loaded = null;
  }
  const validPoints = loaded && Number.isFinite(loaded.points) && loaded.points >= 0;
  const completed = Array.isArray(loaded && loaded.completed)
    ? [...new Set(loaded.completed.filter((id) => VALID_QUEST_IDS.has(id)))]
    : [];
  gameCache = validPoints
    ? {
        points: Math.floor(loaded.points),
        streak: Number.isFinite(loaded.streak) && loaded.streak >= 0 ? Math.floor(loaded.streak) : 0,
        completed,
      }
    : { points: 120, streak: 3, completed: [] };
  return gameCache;
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

function saveGame(game) {
  gameCache = game;
  try {
    localStorage.setItem("smartwatts-game", JSON.stringify(game));
  } catch {
    /* storage unavailable: progress lasts for this page session */
  }
}

function levelInfo(points) {
  const level = Math.floor(points / LEVEL_STEP) + 1;
  const into = points % LEVEL_STEP;
  return { level, into, pct: (into / LEVEL_STEP) * 100, toNext: LEVEL_STEP - into, title: LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)] };
}

// Mascot: "Wattie", an original little spark
function mascot(size = 120, cheer = false) {
  return `
    <svg class="mascot ${cheer ? "cheer" : ""}" width="${size}" height="${size}" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <ellipse cx="60" cy="113" rx="28" ry="5" fill="#1d1236" opacity=".22"/>
      <path d="M68 3 46 30h12l-6 16 24-29H63Z" fill="#ff7a00" stroke="#2b2140" stroke-width="3.5" stroke-linejoin="round"/>
      <circle cx="60" cy="73" r="38" fill="#ffc800" stroke="#2b2140" stroke-width="3.5"/>
      <ellipse cx="44" cy="54" rx="10" ry="6" fill="#fff" opacity=".55" transform="rotate(-30 44 54)"/>
      <g class="m-eyes">
        <ellipse cx="46" cy="70" rx="6" ry="8.5" fill="#2b2140"/><circle cx="48" cy="67" r="2.4" fill="#fff"/>
        <ellipse cx="74" cy="70" rx="6" ry="8.5" fill="#2b2140"/><circle cx="76" cy="67" r="2.4" fill="#fff"/>
      </g>
      <circle cx="36" cy="84" r="6" fill="#ff5c8a" opacity=".45"/><circle cx="84" cy="84" r="6" fill="#ff5c8a" opacity=".45"/>
      <path d="M47 83q13 17 26 0Z" fill="#2b2140" stroke="#2b2140" stroke-width="3" stroke-linejoin="round"/>
      <path d="M53 90q7 5 14 0q-7-4-14 0Z" fill="#ff5c8a"/>
    </svg>`;
}

// Dashboard hero
function weekRow(game) {
  const days = gameUiCallbacks.language() === "tl"
    ? ["L", "M", "M", "H", "B", "S", "L"]
    : ["M", "T", "W", "T", "F", "S", "S"];
  const today = (new Date().getDay() + 6) % 7;
  const doneToday = game.completed.includes("daily");
  const prior = game.streak - (doneToday ? 1 : 0);
  return `<div class="week" role="img" aria-label="${game.streak} day streak">${days
    .map((label, i) => {
      let state = "future";
      if (i === today) state = doneToday ? "done" : "today";
      else if (i < today) state = today - i <= prior ? "done" : "missed";
      const mark = state === "done" ? "🔥" : state === "today" ? "⚡" : "";
      return `<div class="day ${state}"><span>${mark}</span><small>${label}</small></div>`;
    })
    .join("")}</div>`;
}

function questRow(q, game) {
  const done = game.completed.includes(q.id);
  return `
    <div class="quest ${done ? "done" : ""}" style="--c:${q.color};--t:${q.tint}">
      <span class="quest-icon">${q.icon}</span>
      <div class="quest-body"><b>${q.title}</b><p>${q.desc}</p></div>
      <button class="btn ${done ? "btn-complete" : "btn-go"}" ${done ? "disabled" : `data-quest="${q.id}"`}>${done ? "✓ Done" : `Claim +${q.pts}`}</button>
    </div>`;
}

function gamificationCard() {
  const game = getGameState();
  const info = levelInfo(game.points);
  const next = QUESTS.find((q) => !game.completed.includes(q.id));
  const left = QUESTS.length - game.completed.length;
  const speech = next ? `${left} quest${left === 1 ? "" : "s"} left. Let's go!` : "All quests done. You're glowing!";

  const side = next
    ? `<div class="game-challenge">
         <div class="challenge-top"><span class="challenge-tag">⚡ NEXT QUEST</span><span class="reward-pill">+${next.pts} XP</span></div>
         <div class="challenge-body"><span class="challenge-icon" style="--c:${next.color};--t:${next.tint}">${next.icon}</span><div><h3>${next.title}</h3><p>${next.desc}</p></div></div>
         <button class="btn btn-go" data-quest="${next.id}">Complete quest</button>
       </div>`
    : `<div class="game-challenge all-done">
         <div class="challenge-top"><span class="challenge-tag">🎉 QUESTS CLEARED</span></div>
         <div class="challenge-body"><span class="challenge-icon" style="--c:#ffc700;--t:#fff8e8">🏅</span><div><h3>Perfect run!</h3><p>Come back tomorrow for fresh quests and keep your streak alive.</p></div></div>
         <button class="btn btn-outline" data-page="rewards">See my badges</button>
       </div>`;

  return `
    <section class="game-card" aria-label="Energy saving progress">
      <div class="game-main">
        <div class="hero-row">
          <div class="mascot-wrap">${mascot(112, !next)}<span class="speech">${speech}</span></div>
          <div class="hero-text">
            <div class="game-eyebrow">LEVEL ${info.level} · ${info.title.toUpperCase()}</div>
            <h2>Small changes. <span>Big savings.</span></h2>
            <div class="xp" role="progressbar" aria-valuemin="0" aria-valuemax="${LEVEL_STEP}" aria-valuenow="${info.into}" aria-label="Experience to next level">
              <div class="xp-fill" style="width:${Math.max(info.pct, 6)}%"></div>
              <span class="xp-label">${info.into} / ${LEVEL_STEP} XP</span>
            </div>
            <small class="xp-next">${info.toNext} XP to level ${info.level + 1}</small>
          </div>
        </div>
        <div class="game-stats">
          <div><span>🏆</span><strong>${game.points}</strong><small>Watts points</small></div>
          <div><span>🔥</span><strong>${game.streak}</strong><small>Day streak</small></div>
          <div><span>✅</span><strong>${game.completed.length}/${QUESTS.length}</strong><small>Quests done</small></div>
        </div>
        ${weekRow(game)}
      </div>
      ${side}
      <a class="game-link" href="#" data-page="goals">All quests →</a>
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
  const game = getGameState();
  const info = levelInfo(game.points);
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
  const doneCount = game.completed.length;
  return `
    ${gameUiCallbacks.pageHead("Your energy goals", "Set realistic targets and celebrate your progress.")}
    <div class="grid stats">
      ${gameUiCallbacks.stat("target", "Monthly Target", targetLabel, "kWh", "Your chosen goal", "")}
      ${gameUiCallbacks.stat("chart-no-axes-column-increasing", "Used This Month", MONTHLY_USAGE.toFixed(2), "kWh", targetFoot, "")}
      ${gameUiCallbacks.stat("zap", "Daily Target", (target / 31).toFixed(1), "kWh", "Average daily goal", "")}
      ${gameUiCallbacks.stat("trophy", "Watts Points", String(game.points), "pts", `Level ${info.level} · ${info.title}`, "")}
    </div>
    <div class="two-panels goal-panels">
      ${gameUiCallbacks.panel(
        "Monthly energy target",
        `<div class="goal-ring-row">
           ${ring(pct, percentageLabel, "of target")}
           <div class="goal-copy">
             <strong>${MONTHLY_USAGE.toFixed(2)} / ${targetLabel} kWh</strong>
             <p class="stat-foot">${usageMessage}</p>
             <span class="reward-pill">Tip: AC quest = +30 XP</span>
           </div>
         </div>`,
      )}
      ${gameUiCallbacks.panel(
        "Your next milestone",
        `<div class="milestone"><span class="milestone-icon">🌟</span><div><b>Energy-aware household</b><p class="stat-foot">Complete all ${QUESTS.length} quests to unlock the Energy Champion badge.</p></div></div>
         <div class="goal-track"><span style="width:${(doneCount / QUESTS.length) * 100}%"></span></div>
         <p class="stat-foot">${doneCount} of ${QUESTS.length} quests completed</p>`,
      )}
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
    <div class="game-challenges-list">
      ${gameUiCallbacks.panel("Today's quests", `<div class="quest-list">${QUESTS.map((q) => questRow(q, game)).join("")}</div>`, `<span class="reward-pill">${doneCount}/${QUESTS.length}</span>`)}
    </div>`;
}

function rewardsPage() {
  const game = getGameState();
  const info = levelInfo(game.points);
  const earned = BADGES.filter((b) => b.test(game)).length;
  return `
    ${gameUiCallbacks.pageHead("Rewards & badges", "Every energy-smart choice deserves a little celebration.")}
    <div class="rewards-hero">
      ${mascot(96, true)}
      <div class="rewards-copy">
        <small>YOUR WATTS POINTS</small>
        <strong>${game.points}</strong>
        <p>Level ${info.level} · ${info.title} · ${info.toNext} XP to level ${info.level + 1}</p>
        <div class="xp slim"><div class="xp-fill" style="width:${Math.max(info.pct, 6)}%"></div></div>
      </div>
    </div>
    ${gameUiCallbacks.panel(
      "Badge collection",
      `<div class="badge-grid">${BADGES.map((b) => {
        const on = b.test(game);
        return `<div class="badge ${on ? "earned" : "locked"}"><div class="badge-medal">${b.icon}</div><b>${b.name}</b><p>${b.desc}</p><span class="badge-state ${on ? "earned" : "locked"}">${on ? "✓ Unlocked" : "🔒 Locked"}</span></div>`;
      }).join("")}</div>`,
      `<span class="reward-pill">${earned}/${BADGES.length} earned</span>`,
    )}
    <p class="about-note">Points and badges are demonstration features stored in this browser only. They have no cash value.</p>`;
}

// Celebrations
function confetti(x, y) {
  if (reducedMotion()) return;
  const colors = ["#ff7a00", "#ffc700", "#e6a000", "#a55300"];
  for (let i = 0; i < 40; i += 1) {
    const piece = document.createElement("i");
    piece.className = "confetti";
    piece.style.left = `${x}px`;
    piece.style.top = `${y}px`;
    piece.style.setProperty("--c", colors[i % colors.length]);
    piece.style.setProperty("--dx", `${(Math.random() - 0.5) * 380}px`);
    piece.style.setProperty("--up", `${-90 - Math.random() * 150}px`);
    piece.style.setProperty("--down", `${60 + Math.random() * 170}px`);
    piece.style.setProperty("--rot", `${(Math.random() - 0.5) * 900}deg`);
    piece.style.animationDelay = `${Math.random() * 90}ms`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 1500);
  }
}

function floatText(x, y, text) {
  if (reducedMotion()) return;
  const el = document.createElement("div");
  el.className = "pop";
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

function claimQuest(id, source) {
  const quest = QUESTS.find((q) => q.id === id);
  const game = getGameState();
  if (!quest || game.completed.includes(id)) return;

  const before = levelInfo(game.points).level;
  game.points += quest.pts;
  game.completed.push(id);
  if (id === "daily") game.streak += 1;
  saveGame(game);
  const after = levelInfo(game.points).level;

  const box = source.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  confetti(x, y);
  floatText(x, y - 20, `+${quest.pts} XP`);

  document.body.classList.add("no-enter");
  gameUiCallbacks.render();
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-enter")));

  const unlocked = game.completed.length === QUESTS.length ? " All quests cleared!" : "";
  gameUiCallbacks.toast(after > before ? `🎉 Level up! You're now level ${after}: ${levelInfo(game.points).title}` : `Quest complete! +${quest.pts} XP.${unlocked}`);
}

// Chrome: top chips, mobile tab highlight, count-up numbers
function renderGameChrome(currentPage) {
  const game = getGameState();
  const info = levelInfo(game.points);
  const chips = document.querySelector("#chips");
  if (chips) {
    chips.innerHTML = `
      <button class="chip chip-streak" data-page="goals" aria-label="${game.streak} day streak">🔥 <b>${game.streak}</b></button>
      <button class="chip chip-xp" data-page="rewards" aria-label="${game.points} points">⚡ <b>${game.points}</b></button>
      <button class="chip chip-lvl" data-page="rewards" aria-label="Level ${info.level}">LV <b>${info.level}</b></button>`;
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
  animateNumbers,
  CHART_COLORS,
  claimQuest,
  gamificationCard,
  getMonthlyEnergyTarget,
  goalsPage,
  renderGameChrome,
  rewardsPage,
  saveMonthlyEnergyTarget,
  setGameCallbacks,
};
