import {
  animateNumbers,
  awardMonthlyReduction,
  CHART_COLORS,
  checkIn,
  coinBalanceCents,
  formatCoins,
  gamificationCard,
  getCoinState,
  goalsPage,
  saveMonthlyEnergyTarget,
  renderGameChrome,
  rewardsPage,
  setGameCallbacks,
  setGameUser,
} from "./game.js";
import { getLanguage, getSupportedLanguages, loadSupportedLanguages, setLanguage, translateText, translateTree } from "./i18n.js";
import {
  handleApplianceLabelScan, handlePersonalBillOcr, personalActions, personalForms, personalLoaders, personalPages, readInviteFromHash,
} from "./personal.js";
import { handleRentalOcr, rentalActions, rentalForms, rentalPages } from "./rentals.js";
import { handleLocatorInput, locatorActions, locatorPages } from "./locator.js";
import { calendarActions, calendarPages } from "./calendar-view.js";
import { getWorkspace, loadWorkspaces, setWorkspace, workspaceOptions } from "./workspace.js";
import { currentAccount, onAccountChange } from "./src/lib/account.ts";
import { escapeHtml } from "./src/lib/format.ts";
import { listBills, loadPreferredLanguage, savePreferredLanguage } from "./src/lib/personal/store.ts";
import { auth } from "./src/lib/firebase.ts";

// Signed-in user's profile (Google name/photo or the name entered at registration).
function userProfile() {
  const user = auth?.currentUser;
  const signedIn = Boolean(user && !user.isAnonymous);
  const email = signedIn ? user.email ?? "" : "";
  const name = (signedIn && user.displayName?.trim()) || (email ? email.split("@")[0] : "");
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    signedIn,
    name,
    firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] ?? "",
    lastName: parts.length > 1 ? parts[parts.length - 1] : "",
    email,
    phone: (signedIn && user.phoneNumber) || "",
    photo: (signedIn && user.photoURL) || "",
    provider: signedIn && user.providerData.some((p) => p.providerId === "google.com") ? "Google" : "Email",
  };
}

// Good morning (5–11), noon (12), afternoon (13–17), evening (18–4).
function greeting(date = new Date()) {
  const hour = date.getHours();
  const period = hour >= 5 && hour < 12 ? "morning" : hour === 12 ? "noon" : hour >= 13 && hour < 18 ? "afternoon" : "evening";
  const firstName = userProfile().firstName;
  if (getLanguage() === "tl") {
    const tl = { morning: "Magandang umaga", noon: "Magandang tanghali", afternoon: "Magandang hapon", evening: "Magandang gabi" }[period];
    return firstName ? `${tl}, ${firstName}!` : `${tl}!`;
  }
  return firstName ? `Good ${period}, ${firstName}!` : `Good ${period}!`;
}

// Navigation and screen copy
// Tier 1 — SmartWatts Personal (free forever)
const personalNavigation = [
  {
    label: "MONITOR",
    items: [
      ["dashboard", "layout-dashboard", "Dashboard"],
      ["realtime", "activity", "Usage Patterns"],
      ["history", "history", "Usage History"],
      ["calendar", "clock", "Consumption Calendar"],
      ["breakdown", "chart-no-axes-column-increasing", "Analytics"],
      ["devices", "plug-zap", "My Appliances"],
    ],
  },
  {
    label: "SAVE & EARN",
    items: [
      ["simulator", "trending-down", "Savings Simulator"],
      ["goals", "target", "Energy Goals"],
      ["rewards", "trophy", "Watts Coins"],
    ],
  },
  {
    label: "BILLING",
    items: [
      ["bills", "receipt-text", "Bill Upload & History"],
      ["billing", "credit-card", "Billing & Payments"],
      ["rates", "badge-dollar-sign", "Rates Overview"],
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      ["plans", "badge-dollar-sign", "Plans"],
      ["rentals-start", "users-round", "SmartWatts Rentals"],
      ["account", "user-round-cog", "Account Settings"],
      ["notifications", "bell", "Notifications"],
      ["support", "message-circle-question", "Help & Support"],
    ],
  },
  {
    label: "MORE",
    items: [["about", "users-round", "About Team"]],
  },
];

// Tier 2 — SmartWatts Rentals, property owner or authorized administrator
const ownerNavigation = [
  {
    label: "PROPERTY",
    items: [
      ["rental-overview", "layout-dashboard", "Overview"],
      ["rental-analytics", "chart-no-axes-column-increasing", "Property Analytics"],
      ["rental-units", "users-round", "Units & Tenants"],
      ["rental-meters", "gauge", "Meters & Allocation"],
      ["rental-readings", "activity", "Meter Readings"],
      ["rental-bills", "receipt-text", "Utility Bills"],
      ["rental-statements", "receipt", "Tenant Statements"],
      ["rental-subscription", "credit-card", "Subscription"],
      ["rental-audit", "history", "Audit Log"],
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      ["account", "user-round-cog", "Account Settings"],
      ["support", "message-circle-question", "Help & Support"],
    ],
  },
];

// Tier 2 — SmartWatts Rentals, tenant (no SmartWatts fee for tenants)
const tenantNavigation = [
  {
    label: "MY RENTAL",
    items: [
      ["tenant-statements", "receipt-text", "My Statements"],
      ["tenant-meters", "gauge", "My Meter History"],
    ],
  },
  {
    label: "MY PRIVATE ENERGY",
    items: [
      ["devices", "plug-zap", "My Appliances"],
      ["simulator", "trending-down", "Savings Simulator"],
      ["calendar", "clock", "Consumption Calendar"],
      ["goals", "target", "Energy Goals"],
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      ["account", "user-round-cog", "Account Settings"],
      ["support", "message-circle-question", "Help & Support"],
    ],
  },
];

const modulePages = { ...personalPages, ...rentalPages, ...locatorPages, ...calendarPages };
const workspaceHome = { personal: "dashboard", owner: "rental-overview", tenant: "tenant-statements" };
const alwaysAvailable = new Set(["account", "support", "plans", "join", "rentals-start", "about", "notifications", "business-centers"]);

function currentNavigation() {
  const { type } = getWorkspace();
  return type === "owner" ? ownerNavigation : type === "tenant" ? tenantNavigation : personalNavigation;
}

const pageIdsOf = (groups) => new Set(groups.flatMap((group) => group.items.map(([id]) => id)));

const pageTitles = {
  dashboard: ["Good morning, Rean Justine!", "Here's what's happening with your electricity today."],
  realtime: ["Usage Patterns", "A sample daily usage profile — SmartWatts does not connect to meters."],
  history: ["Usage History", "Review and compare your past electricity consumption."],
  breakdown: ["Analytics", "Understand where your electricity is being consumed."],
  devices: ["My Appliances", "Register appliances and estimate their energy use."],
  goals: ["Energy Goals", "Build better habits and track your household energy targets."],
  rewards: ["Rewards & Badges", "Celebrate the small steps that help you use energy wisely."],
  billing: ["Billing & Payments", "Review your estimated bill and payment details."],
  rates: ["Rates Overview", "Understand your electricity rate and charges."],
  notifications: ["Notifications", "Stay updated with usage alerts and account activity."],
  account: ["Account Settings", "Manage your profile and account preferences."],
  support: ["Help & Support", "Find answers or contact the SmartWatts support team."],
  about: ["About Team", "Meet the people and purpose behind SmartWatts."],
};
pageTitles.rewards = ["Watts Coins", "Earn coins through daily check-ins and verified monthly energy savings."];
for (const [id, page] of Object.entries(modulePages)) pageTitles[id] = [page.title, page.subtitle];

const devices = [
  ["snowflake", "Air Conditioner", "129.23", "38%"],
  ["refrigerator", "Refrigerator", "75.28", "22%"],
  ["tv", "Television", "45.67", "13%"],
  ["washing-machine", "Washing Machine", "32.18", "9%"],
  ["package", "Others", "59.82", "18%"],
];

const historyRecords = [
  ["Apr 1 – Apr 30, 2026", "342.18 kWh", "₱1,256.34", "Paid"],
  ["Mar 1 – Mar 31, 2026", "304.42 kWh", "₱1,117.20", "Paid"],
  ["Feb 1 – Feb 28, 2026", "318.75 kWh", "₱1,169.80", "Paid"],
  ["Jan 1 – Jan 31, 2026", "289.10 kWh", "₱1,060.45", "Paid"],
  ["Dec 1 – Dec 31, 2025", "355.62 kWh", "₱1,304.50", "Paid"],
];

let currentNotificationUser = "guest";
let notificationsCache = null;

function setNotificationUser(userId) {
  const next = userId || "guest";
  if (currentNotificationUser !== next) {
    currentNotificationUser = next;
    notificationsCache = null;
    updateNotificationBadge();
  }
}

function getNotificationsStorageKey() {
  return currentNotificationUser === "guest"
    ? "smartwatts-notifications-guest"
    : `smartwatts-notifications-${currentNotificationUser}`;
}

const defaultNotifications = [
  { id: "notif-seed-1", icon: "triangle-alert", title: "Sample Usage Alert", message: "Sample: this month's usage is 12% higher than last month.", time: "9:15 AM", timestamp: Date.now() - 3600000, read: false },
  { id: "notif-seed-2", icon: "receipt-text", title: "Bill is Ready", message: "Your May 2026 bill is now available.", time: "Yesterday", timestamp: Date.now() - 86400000, read: false },
  { id: "notif-seed-3", icon: "circle-check", title: "Payment Received", message: "Thank you! Your payment of ₱1,150.00 was successful.", time: "Apr 15", timestamp: Date.now() - 172800000, read: false },
  { id: "notif-seed-4", icon: "receipt-text", title: "Bill Reminder", message: "Upload your latest bill to keep your history up to date.", time: "Apr 12", timestamp: Date.now() - 259200000, read: true },
];

function getNotifications() {
  if (notificationsCache) return notificationsCache;
  const key = getNotificationsStorageKey();
  let loaded = null;
  try {
    loaded = JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    loaded = null;
  }
  if (!Array.isArray(loaded) || !loaded.length) {
    loaded = defaultNotifications.map((n) => ({ ...n }));
    saveNotifications(loaded);
  }
  notificationsCache = loaded;
  return notificationsCache;
}

function saveNotifications(items) {
  notificationsCache = items;
  try {
    localStorage.setItem(getNotificationsStorageKey(), JSON.stringify(items));
  } catch {
    // Memory fallback
  }
  updateNotificationBadge();
}

function addNotification(icon, title, message) {
  const items = getNotifications();
  const isDuplicate = items.some(
    (n) => n.title === title && n.message === message && Date.now() - n.timestamp < 10000,
  );
  if (isDuplicate) return;

  const newItem = {
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    icon,
    title,
    message,
    time: "Just now",
    timestamp: Date.now(),
    read: false,
  };
  const updated = [newItem, ...items].slice(0, 30);
  saveNotifications(updated);
  if (currentPage === "notifications" || currentPage === "dashboard") {
    render();
  }
}

function markAllNotificationsRead() {
  const items = getNotifications().map((n) => ({ ...n, read: true }));
  saveNotifications(items);
  if (currentPage === "notifications" || currentPage === "dashboard") {
    render();
  }
}

function getUnreadNotificationCount() {
  return getNotifications().filter((n) => !n.read).length;
}

function updateNotificationBadge() {
  const badge = document.querySelector("#notificationBadge");
  if (!badge) return;
  const count = getUnreadNotificationCount();
  badge.textContent = String(count);
  badge.style.display = count > 0 ? "inline-block" : "none";
  refreshNotificationPopover();
}

function refreshNotificationPopover() {
  const popover = document.querySelector("#notificationPopover");
  if (!popover || popover.hidden) return;
  const items = getNotifications().slice(0, 5);
  popover.innerHTML = `<div class="notification-popover-head"><strong>Notifications</strong><button class="text-link" data-page="notifications">View all</button></div>${notificationList(items)}<div class="notification-popover-actions"><button class="btn btn-outline btn-small" data-action="markRead">Mark all as read</button></div>`;
}

function triggerBrowserDownload(filename, content, mimeType = "text/csv;charset=utf-8;") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let exportNoticeTimer = null;
function showExportNotice(message, status = "success") {
  const notice = document.querySelector("#exportNotice");
  if (!notice) return;
  clearTimeout(exportNoticeTimer);
  notice.hidden = false;
  notice.className = `export-notice ${status}`;
  notice.textContent = translateText(message);
  requestAnimationFrame(() => notice.classList.add("visible"));
  if (status !== "working") exportNoticeTimer = setTimeout(() => {
    notice.classList.remove("visible");
    setTimeout(() => { notice.hidden = true; }, 250);
  }, 3600);
}

async function downloadUsageRecord(index = 0) {
  toast("Preparing usage record download…");
  try {
    let bills = [];
    try {
      bills = await listBills();
    } catch {
      bills = [];
    }
    let period, kwh, amount, status, source;
    if (bills && bills[index]) {
      const b = bills[index];
      period = `${b.periodStart} to ${b.periodEnd}`;
      kwh = `${b.kwh} kWh`;
      amount = `₱${(b.amountCentavos / 100).toFixed(2)}`;
      status = "Recorded";
      source = b.source === "ocr" ? "Official utility bill (OCR)" : "Manual entry";
    } else {
      const record = historyRecords[index] || historyRecords[0];
      period = record[0];
      kwh = record[1];
      amount = record[2];
      status = record[3];
      source = "Sample household profile (no live meter connected)";
    }
    const csv = [
      "SmartWatts - Recent Usage Statement",
      `Billing Period,${period}`,
      `Consumption,${kwh}`,
      `Amount,${amount.replace("₱", "PHP ")}`,
      `Status,${status}`,
      `Data Source,${source}`,
      `Generated At,${new Date().toISOString()}`,
      `Note,Philippine residential electricity reference. Refer to official utility bill for final statement.`,
    ].join("\r\n");

    triggerBrowserDownload(`smartwatts-usage-record-${index + 1}.csv`, csv);
    toast("Usage history downloaded successfully.");
    addNotification("download", "Usage Record Downloaded", `Statement for ${period} (${kwh}) was downloaded.`);
  } catch {
    toast("Unable to download usage history. Please try again.");
  }
}

async function exportUsageHistory() {
  toast("Preparing usage history export…");
  try {
    let bills = [];
    try {
      bills = await listBills();
    } catch {
      bills = [];
    }
    const rows = [
      ["Billing Period", "Consumption (kWh)", "Estimated Cost (PHP)", "Status", "Data Source"],
    ];
    if (bills && bills.length > 0) {
      bills.forEach((b) => {
        rows.push([
          `"${b.periodStart} to ${b.periodEnd}"`,
          b.kwh,
          (b.amountCentavos / 100).toFixed(2),
          "Recorded",
          `"${b.source === "ocr" ? "Official utility bill (OCR)" : "Manual entry"}"`,
        ]);
      });
    } else {
      historyRecords.forEach(([period, usage, amount, status]) => {
        rows.push([
          `"${period}"`,
          parseFloat(usage),
          parseFloat(amount.replace(/[₱,]/g, "")),
          status,
          `"Sample household profile"`,
        ]);
      });
    }
    const csvContent = rows.map((r) => r.join(",")).join("\r\n");
    triggerBrowserDownload(`smartwatts-usage-history-${new Date().toISOString().slice(0, 10)}.csv`, csvContent);
    toast("Usage history downloaded successfully.");
    addNotification("download", "Usage History Exported", "Complete usage history CSV report was downloaded.");
  } catch {
    toast("Unable to download usage history. Please try again.");
  }
}

async function exportAnalyticsReport(button) {
  const originalText = button ? button.textContent : "Export Report";
  if (button) {
    button.disabled = true;
    button.textContent = translateText("Exporting…");
  }
  showExportNotice("Preparing your Analytics report…", "working");
  try {
    const bills = await listBills().catch(() => []);
    const savedBills = [...bills].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
    const billTotalKwh = savedBills.reduce((sum, bill) => sum + Number(bill.kwh || 0), 0);
    const billTotalCentavos = savedBills.reduce((sum, bill) => sum + Number(bill.amountCentavos || 0), 0);
    const rows = [
      ["SmartWatts - Energy Analytics Report"],
      ["Generated Month", new Date().toLocaleDateString("en-PH", { month: "long", year: "numeric" })],
      ["Generated At", new Date().toISOString()],
      ["Data Basis", savedBills.length ? "Saved personal bill records; appliance split below is a sample estimate" : "Sample household consumption profile and appliance breakdown"],
      [],
      ["Metric", "Value", "Unit", "Note"],
      ["Total Recorded Usage", (savedBills.length ? billTotalKwh : 342.18).toFixed(2), "kWh", savedBills.length ? `${savedBills.length} saved bills` : "Sample month"],
      ["Recorded Bill Amount", (savedBills.length ? billTotalCentavos / 100 : 1256.34).toFixed(2), "PHP", savedBills.length ? "Sum of saved bill amounts" : "Sample estimate"],
      ["Largest Consumer", "38%", "Air Conditioner", "129.23 kWh estimated"],
      ["Month-over-Month Change", "+12.4%", "vs last month", "Historical comparison"],
      [],
      ["Device / Appliance", "Usage (kWh)", "Share of Total (%)"],
      ...devices.map(([_, name, usage, pct]) => [`"${name}"`, usage, `"${pct}"`]),
      [],
      ["Saved Bill Period", "Consumption (kWh)", "Bill Amount (PHP)", "Source"],
      ...(savedBills.length ? savedBills.map((bill) => [
        `${bill.periodStart} to ${bill.periodEnd}`,
        Number(bill.kwh).toFixed(2),
        (bill.amountCentavos / 100).toFixed(2),
        bill.source === "ocr" ? "Reviewed OCR" : "Manual entry",
      ]) : [["No saved bill records", "", "", "Sample profile used"]]),
      [],
      ["Privacy & Accuracy Notice", "SmartWatts does not connect to meters or IoT hardware. All estimates are calculated from user schedules or sample profiles."],
    ];
    const csv = rows.map((r) => r.join(",")).join("\r\n");
    await new Promise((r) => setTimeout(r, 400));
    triggerBrowserDownload(`smartwatts-analytics-report-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    showExportNotice("Analytics report generated and downloaded.", "success");
    addNotification("chart-pie", "Analytics Report Ready", "Your SmartWatts analytics CSV was generated and downloaded.");
  } catch {
    showExportNotice("Unable to export analytics report. Please try again.", "failure");
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

// Inline SVG paths keep the icon set dependency-free.
const iconPaths = {
  "layout-dashboard": `<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>`,
  activity: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  history: `<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>`,
  "chart-no-axes-column-increasing": `<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>`,
  "chart-pie": `<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>`,
  "plug-zap": `<path d="m13 2-3 8h7l-6 12 1-9H5l3-8"/>`,
  "credit-card": `<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M7 15h2"/>`,
  "receipt-text": `<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 8h8M8 12h8M8 16h4"/>`,
  "badge-dollar-sign": `<circle cx="12" cy="12" r="10"/><path d="M16 8h-5a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4H8M12 6v12"/>`,
  bell: `<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>`,
  "user-round-cog": `<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="m19.4 15.4.4-.2a1 1 0 0 1 1.4 1.4l-.2.4.2.4a1 1 0 0 1-1.4 1.4l-.4-.2-.4.2a1 1 0 0 1-1.4-1.4l.2-.4-.2-.4a1 1 0 0 1 1.4-1.4z"/>`,
  "message-circle-question": `<path d="M7.9 20A9 9 0 1 1 12 21H3z"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>`,
  "users-round": `<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`,
  zap: `<path d="M13 2 4 14h7l-1 8 10-13h-7l1-7Z" />`,
  target: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`,
  trophy: `<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4"/>`, 
  gauge: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/><path d="M8 19h8"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  receipt: `<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 8h8M8 12h5"/>`,
  snowflake: `<path d="m10 20 2-8 2 8M12 12l-6 5M12 12l6 5M4.93 10.93 12 12l-7.07 1.07M12 12l-2-8M12 12l6-5M4.93 13.07 6 17M18 7l1.07 3.93M19.07 13.07 18 17M6 7l-1.07 3.93M14 4l-2 8-2-8"/>`,
  refrigerator: `<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 10h14M9 6v1M9 14v2"/>`,
  tv: `<rect x="3" y="5" width="18" height="13" rx="2"/><path d="m7 21 5-3 5 3M8 2l4 3 4-3"/>`,
  "washing-machine": `<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M8 6h.01M12 6h.01M16 6h.01"/>`,
  package: `<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9"/>`,
  "triangle-alert": `<path d="m10.3 3.9-8.1 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.8-3.1l-8.1-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>`,
  info: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>`,
  "circle-check": `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  radio: `<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>`,
  "trending-up": `<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>`,
  "trending-down": `<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>`,
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
};

// App state and shared rendering helpers
let currentPage = "dashboard";
let charts = [];

const $ = (selector) => document.querySelector(selector);

function icon(name, size = 20) {
  const paths = iconPaths[name];
  if (!paths) {
    throw new Error(`Unknown icon: ${name}`);
  }

  return `<svg class="icon" aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function renderNavigation() {
  $("#navigation").innerHTML = currentNavigation()
    .map(
      (group) => `
        <div class="nav-group">
          <div class="nav-label">${group.label}</div>
          ${group.items
            .map(
              ([id, iconName, label]) => `
                <button class="nav-link ${id === currentPage ? "active" : ""}" data-page="${id}">
                  <span class="nav-icon">${icon(iconName)}</span>${label}
                </button>`,
            )
            .join("")}
        </div>`,
    )
    .join("");
}

function renderPageHeading() {
  const [title, subtitle] = pageTitles[currentPage];
  $("#pageTitle").textContent = currentPage === "dashboard" ? greeting() : title;
  $("#pageSubtitle").textContent = subtitle;
}

function pageHead(title, subtitle, actions = "") {
  return `
    <div class="page-heading">
      <div><h2>${title}</h2><p>${subtitle}</p></div>
      <div class="toolbar">${actions}</div>
    </div>`;
}

function stat(iconName, label, value, unit, foot, trend = "") {
  return `
    <article class="stat-card">
      <div class="stat-icon">${icon(iconName, 22)}</div>
      <div class="stat-copy">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value} <small>${unit}</small></div>
        <div class="stat-foot">${foot} ${trend ? `<span class="trend">${trend}</span>` : ""}</div>
      </div>
    </article>`;
}

function panel(title, body, extra = "") {
  return `
    <section class="panel">
      <div class="panel-head"><h3>${title}</h3>${extra}</div>
      ${body}
    </section>`;
}

function chartCanvas(id, className = "") {
  return `<div class="chart-wrap ${className}"><canvas id="${id}"></canvas></div>`;
}

function detail(label, value) {
  return `<div class="detail-row"><span>${label}</span><b>${value}</b></div>`;
}

function legend(names, values) {
  return names
    .map(
      (name, index) => `
        <div class="legend-item">
          <span class="dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>
          <div><b>${name}</b>${values[index]}</div>
        </div>`,
    )
    .join("");
}

function tableRows(rows) {
  return `<table class="table"><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

// Chart setup
function lineChart(id, labels, data, label = "Usage (kW)") {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const dark = document.body.classList.contains("theme-dark");
  const textColor = dark ? "#e4d8c6" : "#776d61";

  charts.push(
    new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label,
            data,
            borderColor: "#ff7a00",
            backgroundColor: (context) => {
              const area = context.chart.chartArea;
              if (!area) return "rgba(255,122,0,.18)";
              const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
              gradient.addColorStop(0, "rgba(255,122,0,.42)");
              gradient.addColorStop(1, "rgba(255,200,0,0)");
              return gradient;
            },
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 8,
            pointHoverBackgroundColor: "#ffc800",
            pointHoverBorderColor: dark ? "#29251f" : "#2b2140",
            pointHoverBorderWidth: 3,
            borderWidth: 4,
            borderCapStyle: "round",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: dark ? "#3a342b" : "#2b2140", padding: 12, cornerRadius: 14, displayColors: false, titleFont: { weight: "800" }, bodyFont: { weight: "700" } },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: textColor, maxTicksLimit: 9 },
          },
          y: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: dark ? "#494236" : "#f3e6cc" },
            ticks: { color: textColor },
          },
        },
      },
    }),
  );
}

function doughnut(id, labels, data) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const dark = document.body.classList.contains("theme-dark");

  charts.push(
    new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: labels.map((label) => translateText(label)),
        datasets: [
          {
            data,
            backgroundColor: CHART_COLORS,
            borderWidth: 4,
            borderColor: dark ? "#24211c" : "#fff",
            borderRadius: 10,
            spacing: 2,
            hoverOffset: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "66%",
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: dark ? "#3a342b" : "#2b2140", padding: 12, cornerRadius: 14, titleFont: { weight: "800" }, bodyFont: { weight: "700" } },
        },
      },
    }),
  );
}

const usageRanges = {
  today: { labels: ["12 AM", "3 AM", "6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM", "12 AM"], values: [0.25, 0.16, 0.18, 0.42, 1.32, 1.02, 0.88, 1.12, 0.62] },
  last24: { labels: ["12 AM", "4 AM", "8 AM", "12 PM", "4 PM", "8 PM"], values: [0.25, 0.18, 0.42, 1.32, 0.88, 0.62] },
  week: { labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], values: [10.2, 11.4, 9.8, 12.1, 13.2, 10.7, 11.45] },
  month: { labels: ["1", "5", "10", "15", "20", "25", "30"], values: [10.2, 11.4, 9.8, 12.1, 13.2, 10.7, 11.45] },
  quarter: { labels: ["Mar", "Apr", "May"], values: [304.42, 318.75, 342.18] },
  year: { labels: ["Jan", "Mar", "May", "Jul", "Sep", "Nov"], values: [289.1, 318.75, 342.18, 326.4, 311.8, 335.2] },
  last30: { labels: Array.from({ length: 30 }, (_, index) => `Day ${index + 1}`), values: [9, 8, 11, 12, 10, 14, 13, 16, 12, 11, 10, 13, 15, 12, 9, 11, 14, 13, 12, 10, 11, 15, 16, 13, 12, 11, 10, 12, 14, 11] },
  last7: { labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], values: [9, 11, 10, 13, 15, 12, 11] },
  last12: { labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], values: [289, 319, 304, 325, 342, 326, 311, 335, 328, 318, 336, 329] },
};

function selectedUsageRange() {
  const select = document.querySelector(`[data-chart-range="${currentPage}"]`);
  return usageRanges[select && select.value] || usageRanges.today;
}

function renderCharts() {
  if (typeof Chart === "undefined") return; // Chart.js CDN unavailable (offline): the rest of the UI still works
  Chart.defaults.font.family = "Nunito, system-ui, sans-serif";
  Chart.defaults.font.weight = "700";
  if (currentPage === "dashboard") {
    const range = selectedUsageRange();
    lineChart("usageChart", range.labels.map((label) => translateText(label)), range.values, translateText("Usage (kW)"));
    doughnut("usageDonut", ["Air Conditioner", "Refrigerator", "Lighting", "Others"], [38, 22, 15, 25]);
  }

  if (currentPage === "realtime") {
    const range = selectedUsageRange();
    lineChart("realtimeChart", range.labels.map((label) => translateText(label)), range.values, translateText("Usage (kW)"));
  }

  if (currentPage === "history") {
    const range = selectedUsageRange();
    lineChart("historyChart", range.labels.map((label) => translateText(label)), range.values, translateText("Consumption (kWh)"));
  }

  if (currentPage === "breakdown") {
    doughnut("breakDonut", ["Air Conditioner", "Refrigerator", "Lighting", "Others"], [38, 22, 15, 25]);
    lineChart("breakLine", ["Jan", "Feb", "Mar", "Apr", "May"].map((label) => translateText(label)), [289, 319, 304, 325, 342], "kWh");
  }
}

// Shared screen content
function deviceTable() {
  return `
    <table class="table">
      <thead><tr><th>Device</th><th>Usage (kWh)</th><th>%</th></tr></thead>
      <tbody>
        ${devices
          .map(
            ([iconName, name, usage, percent]) => `
              <tr>
                <td>
                  <div class="device-name">
                    <span class="device-icon">${icon(iconName, 19)}</span>
                    <div>${name}<div class="bar" style="width:160px"><span style="width:${parseInt(percent, 10)}%"></span></div></div>
                  </div>
                </td>
                <td>${usage}</td><td>${percent}</td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function notificationList(items = getNotifications()) {
  if (!items || !items.length) {
    return `<p class="muted-note" style="padding:15px;text-align:center">No notifications yet.</p>`;
  }
  return items
    .map(
      (n) => `
        <div class="alert ${n.read ? "alert-read" : "alert-unread"}" data-notif-id="${n.id}">
          <div class="alert-icon">${icon(n.icon, 18)}</div>
          <div style="flex:1">
            <time>${n.time}</time><strong>${n.title}</strong><p>${n.message}</p>
          </div>
          ${!n.read ? `<span class="unread-dot" title="Unread" style="width:8px;height:8px;border-radius:50%;background:var(--orange);display:inline-block;align-self:center;margin-left:8px"></span>` : ""}
        </div>`,
    )
    .join("");
}

function historyTable() {
  return `
    <table class="table">
      <thead><tr><th>Billing Period</th><th>Consumption</th><th>Amount</th><th>Status</th><th>Statement</th></tr></thead>
      <tbody>
        ${historyRecords
          .map(
            ([period, usage, amount, status], index) => `
              <tr>
                <td>${period}</td><td>${usage}</td><td><b>${amount}</b></td>
                <td><span class="status">${status}</span></td>
                <td><button class="btn btn-outline" data-action="download" data-record-index="${index}">${icon("download", 15)} Download</button></td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function dashboardPage() {
  const usageLegend = legend(
    ["Air Conditioner", "Refrigerator", "Lighting", "Others"],
    ["38% (129.23 kWh)", "22% (75.28 kWh)", "15% (51.33 kWh)", "25% (86.34 kWh)"],
  );

  return `
    <div class="grid stats">
      ${stat("gauge", "Typical Load", "0.62", "kW", "Sample profile, not a live reading", "Sample")}
      ${stat("chart-no-axes-column-increasing", "Today's Consumption", "11.45", "kWh", "vs yesterday", `${icon("trending-down", 13)} 8.6%`)}
      ${stat("chart-pie", "This Month", "342.18", "kWh", "vs last month", `${icon("trending-up", 13)} 12.4%`)}
      ${stat("receipt", "Est. Bill Amount", "₱1,256.34", "", "Due on May 20, 2026", "")}
    </div>
    ${gamificationCard()}
    <div class="dashboard-layout">
      <div class="left-stack">
        ${panel("Usage Profile", chartCanvas("usageChart", "tall"), `<span class="kind-badge kind-sample">Sample data</span><select class="select" data-chart-range="dashboard" aria-label="Usage time range"><option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="quarter">Quarterly</option><option value="year">Yearly</option></select>`)}
        <div class="two-panels">
          ${panel("Usage Breakdown <small>(This Month)</small>", `<div class="donut-layout"><div class="donut-wrap"><canvas id="usageDonut"></canvas></div><div class="legend">${usageLegend}</div></div><button class="btn btn-outline" data-page="breakdown">View Full Breakdown</button>`)}
          ${panel("Top Appliances <small>(Sample estimate)</small>", deviceTable())}
        </div>
      </div>
      <div class="right-stack">
        ${panel("Account Overview", `<div class="detail-list">${detail("Account Name", escapeHtml(userProfile().name || "—"))}${detail("Account Number", "1234 5678 9012")}${detail("Service Address", "123 Main St., Brgy. 123, Makati City, Metro Manila")}${detail("Rate", "Residential")}</div><button class="btn btn-outline" style="width:100%;margin-top:17px" data-page="account">View Account Details</button>`)}
        ${panel("Alerts & Notifications", notificationList(getNotifications().slice(0, 3)), `<button class="text-link" data-page="notifications">View all</button>`)}
        ${panel("Bill Estimate", `<div class="stat-label">Based on your current usage</div><div class="bill-amount">₱1,256.34</div><div class="progress"><span></span></div><div class="detail-list" style="margin:13px 0">${detail("Due Date", "May 20, 2026")}${detail("Billing Period", "Apr 1 – Apr 30, 2026")}</div><button class="btn btn-primary" style="width:100%" data-page="billing">View Bill & Pay</button>`)}
      </div>
    </div>`;
}

// Individual screen templates
function realtimePage() {
  return `
    ${pageHead("Usage patterns", "A sample daily load profile. SmartWatts does not connect to meters, cameras, or smart devices.", `<span class="kind-badge kind-sample">Sample data</span><select class="select" data-chart-range="realtime" aria-label="Usage time range"><option value="today">Today</option><option value="last24">Last 24 hours</option><option value="week">This Week</option><option value="month">This Month</option><option value="quarter">Quarterly</option><option value="year">Yearly</option></select>`)}
    <div class="grid stats">
      ${stat("zap", "Typical Load", "0.62", "kW", "Sample profile", "")}
      ${stat("clock", "Typical Peak", "1.32", "kW", "Around 7:30 AM", "")}
      ${stat("chart-no-axes-column-increasing", "Daily Energy", "11.45", "kWh", "Sample day", "")}
      ${stat("gauge", "Average Load", "0.48", "kW", "Sample day", "")}
    </div>
    ${panel("Sample Usage Trend", chartCanvas("realtimeChart", "tall"))}
    <div class="grid card-grid" style="margin-top:14px">
      ${panel("Data Source", `<span class="kind-badge kind-sample">Sample data</span><p class="stat-foot">No meter is connected. Add your official bills to track real consumption.</p><button class="btn btn-outline" data-page="bills">Add a bill</button>`)}
      ${panel("Estimate Your Appliances", `<p class="stat-foot">Register appliances and schedules to see where your electricity likely goes.</p><button class="btn btn-outline" data-page="devices">My Appliances</button>`)}
      ${panel("Plan Savings", `<p class="stat-foot">Try schedule changes in the savings simulator.</p><button class="btn btn-outline" data-page="simulator">Open simulator</button>`)}
    </div>`;
}

function historyPage() {
  return `
    ${pageHead("Consumption history", "Explore your energy consumption over time.", `<select class="select" data-chart-range="history" aria-label="Usage time range"><option value="last30">Last 30 days</option><option value="last7">Last 7 days</option><option value="last12">Last 12 months</option><option value="quarter">Quarterly</option><option value="year">Yearly</option></select><button class="btn btn-outline" data-action="export">${icon("download", 15)} Export CSV</button>`)}
    <div class="grid stats">
      ${stat("chart-no-axes-column-increasing", "Total Consumption", "342.18", "kWh", "Current month", "")}
      ${stat("activity", "Daily Average", "11.41", "kWh", "This month", "")}
      ${stat("trending-up", "Highest Day", "16.82", "kWh", "May 8, 2026", "")}
      ${stat("trending-down", "Lowest Day", "7.24", "kWh", "May 2, 2026", "")}
    </div>
    ${panel("Daily Consumption", chartCanvas("historyChart", "tall"))}
    <div style="margin-top:14px">${panel("Recent Usage Records", historyTable())}</div>`;
}

function analyticsPage() {
  const applianceLegend = legend(
    ["Air Conditioner", "Refrigerator", "Lighting", "Others"],
    ["129.23 kWh", "75.28 kWh", "51.33 kWh", "86.34 kWh"],
  );

  return `
    ${pageHead("Energy analytics", "Analyze your electricity usage by category and time.", `<select class="select"><option>May 2026</option><option>April 2026</option></select><button class="btn btn-outline" data-action="export">Export Report</button>`)}
    <div class="grid stats">
      ${stat("chart-no-axes-column-increasing", "Total Usage", "342.18", "kWh", "This month", "")}
      ${stat("badge-dollar-sign", "Estimated Cost", "₱1,256.34", "", "Current estimate", "")}
      ${stat("snowflake", "Largest Consumer", "38%", "", "Air Conditioner", "")}
      ${stat("trending-up", "Compared to Last Month", "12.4%", "", "Consumption increase", "")}
    </div>
    <div class="two-panels">
      ${panel("Usage by Appliance", `<div class="donut-layout"><div class="donut-wrap"><canvas id="breakDonut"></canvas></div><div class="legend">${applianceLegend}</div></div>`)}
      ${panel("Monthly Consumption Trend", chartCanvas("breakLine"))}
    </div>
    <div style="margin-top:14px">${panel("Appliance Consumption Details", deviceTable())}</div>`;
}

function billingPage() {
  const breakdownRows = [
    ["Generation Charge", "₱715.20"],
    ["Transmission Charge", "₱105.30"],
    ["Distribution Charge", "₱220.40"],
    ["Taxes & Other Charges", "₱215.44"],
    ["<b>Total Amount</b>", "<b>₱1,256.34</b>"],
  ];

  return `
    ${pageHead("Billing & Payments", "Your current bill summary and payment information.")}
    <div class="grid stats">
      ${stat("badge-dollar-sign", "Total Amount Due", "₱1,256.34", "", "Due May 20, 2026", "")}
      ${stat("credit-card", "Billing Period", "Apr 1–30", "", "May 2026 statement", "")}
      ${stat("chart-no-axes-column-increasing", "Energy Used", "342.18", "kWh", "This billing period", "")}
      ${stat("circle-check", "Last Payment", "₱1,150.00", "", "Received Apr 15, 2026", "")}
    </div>
    <div class="two-panels">
      ${panel("Current Bill", `<div class="stat-label">Estimated amount due</div><div class="bill-amount">₱1,256.34</div><p class="stat-foot">Due date: May 20, 2026</p><div class="progress"><span></span></div><p class="stat-foot">Your estimated bill is based on current consumption.</p><button class="btn btn-primary" style="margin-top:15px" data-action="pay">How to pay your utility</button>`)}
      ${panel("Bill Breakdown", tableRows(breakdownRows))}
    </div>
    <div class="two-panels" style="margin-top:14px">
      ${panel("Watts Coins Discount", `<div class="coin-lock-state"><strong>🔒 Locked · Pending for Next Bill</strong><p>${formatCoins(coinBalanceCents())} Watts Coins (₱${formatCoins(coinBalanceCents())}) are saved. They can only be applied during the bill payment or subscription renewal window.</p><button class="btn btn-outline" disabled>Apply coins at payment</button></div>`)}
      ${panel("Payment Methods", `<div class="detail-row"><span>Available payment channels</span><b>Online banking · E-wallet · Payment centers</b></div><p class="stat-foot">Payments are simulated in this UI demo. No real transaction will be made.</p>`)}</div>`;
}

function ratesPage() {
  const rateRows = [
    ["Charge Category", "Description", "Estimated Amount"],
    ["Generation", "Cost of electricity generation", "₱715.20"],
    ["Transmission", "Delivery through transmission network", "₱105.30"],
    ["Distribution", "Local distribution and service", "₱220.40"],
    ["Taxes & Other Charges", "Applicable taxes and adjustments", "₱215.44"],
    ["<b>Total</b>", "<b>Estimated bill</b>", "<b>₱1,256.34</b>"],
  ];

  return `
    ${pageHead("Rates overview", "A sample breakdown of residential electricity charges.")}
    <div class="grid stats">
      ${stat("badge-dollar-sign", "Estimated Average Rate", "₱3.67", "/kWh", "Illustrative rate", "")}
      ${stat("chart-no-axes-column-increasing", "Current Usage", "342.18", "kWh", "This month", "")}
      ${stat("receipt", "Estimated Bill", "₱1,256.34", "", "Before final statement", "")}
      ${stat("credit-card", "Rate Category", "Residential", "", "Account tariff", "")}
    </div>
    ${panel("Sample Charge Breakdown", tableRows(rateRows))}
    <p class="stat-foot">Rates and amounts shown are sample UI data only. Refer to your official MERALCO bill for actual rates.</p>`;
}

function notificationsPage() {
  const allNotifications = getNotifications();
  return `
    ${pageHead("Alerts & notifications", "Recent updates about your electricity account.", `<button class="btn btn-outline" data-action="markRead">Mark all as read</button>`)}
    ${panel("Recent Activity", notificationList(allNotifications))}`;
}

function accountPage() {
  return `
    ${pageHead("Account settings", "Manage your account details and preferences.")}
    <div style="margin-bottom:14px">${panel("Sign-in & security", `<div data-slot="account-security"><p class="muted-note">Loading…</p></div>`)}</div>
    <div class="settings-layout">
      <div class="panel settings-menu">
        <button class="active">Personal Information</button>
        <button>Service Details</button>
        <button>Security</button>
        <button>Preferences</button>
      </div>
      ${panel("Personal Information", `
        <form class="form-grid" id="accountForm">
          <div class="field"><label>First Name</label><input value="Rean Justine"></div>
          <div class="field"><label>Last Name</label><input value="Baulite"></div>
          <div class="field"><label>Email Address</label><input type="email" value="rean.justine@example.com"></div>
          <div class="field"><label>Mobile Number</label><input value="+63 9XX XXX XXXX"></div>
          <div class="field full"><label>Service Address</label><input value="123 Main St., Brgy. 123, Makati City, Metro Manila"></div>
          <div class="field"><label>Account Number</label><input value="1234 5678 9012" disabled></div>
          <div class="field"><label>Rate Category</label><input value="Residential" disabled></div>
          <div class="field full"><button class="btn btn-primary">Save Changes</button></div>
        </form>`)}
    </div>`;
}

function supportPage() {
  const contacts = [
    ["Hotline", "Dial (02) 16211", "tel:+63216211"],
    ["Email", "customercare@meralco.com.ph", "mailto:customercare@meralco.com.ph"],
    ["Mobile", "Dial (02) 16211 on Mobile", "tel:+63216211"],
    ["Facebook", "@meralco", "https://www.facebook.com/meralco/"],
    ["Twitter", "Meralco", "https://twitter.com/meralco"],
    ["YouTube", "Meralco YouTube", "https://www.youtube.com/user/meralcoph"],
    ["Instagram", "@meralco", "https://www.instagram.com/meralcoph/?hl=en"],
    ["Meralco Messenger", "Message us", "https://m.me/147245968622316"],
  ];

  return `
    ${pageHead("Help & Support", "We're here to help you manage your electricity.")}
    <div class="grid card-grid">
      ${panel("Frequently Asked Questions", `<h3>How is my bill estimated?</h3><p class="stat-foot">Your estimate uses recent consumption and sample rates. Your official bill is the final reference.</p><h3>Can my landlord see my appliances?</h3><p class="stat-foot">No. Appliances, schedules, savings plans, and AI chats are private to your account, even when you rent through SmartWatts Rentals.</p>`)}
      ${panel("Contact Support", `
        <p class="contact-intro"><strong>General Contact Information</strong><span>Your feedback means a lot to us</span></p>
        <div class="contact-options">
          ${contacts.map(([label, value, href]) => {
            const external = href.startsWith("https:");
            return `<a class="contact-option" href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>
              <span>${label}</span><strong>${value}</strong>
            </a>`;
          }).join("")}
        </div>`)}
      ${panel("Meralco Business Centers", `<p class="stat-foot">Search the official list of Meralco Business Centers, see published branch contacts, and get directions.</p><button class="btn btn-primary" data-page="business-centers">Find a Business Center</button>`)}
      ${panel("System Information", `<div class="detail-list">${detail("Application", "SmartWatts UI Demo")}${detail("Version", "1.0.0")}${detail("Status", "<span class='status'>Operational</span>")}</div>`)}
    </div>`;
}

function aboutPage() {
  return `
    ${pageHead("About the SmartWatts team", "A clearer way to understand everyday electricity use.")}
    <div class="about-hero panel">
      <span class="about-mark">${icon("zap", 42)}</span>
      <div>
        <p class="eyebrow">MONITOR. SAVE. SMARTER.</p>
        <h2>Energy insights made easier.</h2>
        <p>SmartWatts is a dashboard concept for helping households monitor electricity use, explore usage patterns, and stay on top of bills.</p>
      </div>
    </div>
    <div class="grid card-grid about-cards">
      ${panel("Our purpose", `<div class="about-card-icon">${icon("chart-pie", 22)}</div><h3>Make usage easier to understand</h3><p>Bring consumption, device breakdowns, and billing estimates together in one approachable place.</p>`)}
      ${panel("Our approach", `<div class="about-card-icon">${icon("activity", 22)}</div><h3>Turn data into useful insights</h3><p>Present sample energy information in clear charts and summaries that help people make informed decisions.</p>`)}
      ${panel("Our team", `<div class="about-card-icon">${icon("users-round", 22)}</div><h3>Project team</h3><div class="team-member-item"><strong>Rolex Esto</strong><span class="muted-note">Lead Developer / Engineering</span></div><p class="stat-foot" style="margin-top:8px">Additional team member names and designated responsibilities are omitted pending official confirmation (status: NEEDS USER DATA).</p>`)}
    </div>
    <p class="about-note">This demo uses sample account and usage data. It is not affiliated with or an official service of MERALCO.</p>`;
}

const pageRenderers = {
  dashboard: dashboardPage,
  realtime: realtimePage,
  history: historyPage,
  breakdown: analyticsPage,
  goals: goalsPage,
  rewards: rewardsPage,
  billing: billingPage,
  rates: ratesPage,
  notifications: notificationsPage,
  account: accountPage,
  support: supportPage,
  about: aboutPage,
};

// Page rendering and navigation
let loadSequence = 0;
const pageState = {};

const pageContext = {
  pageHead: (...args) => pageHead(...args),
  panel: (...args) => panel(...args),
  stat: (...args) => stat(...args),
  icon: (...args) => icon(...args),
  escape: escapeHtml,
  toast: (message) => toast(message),
  navigate: (page) => navigate(page),
  render: () => render(),
  translate: (root) => translateTree(root, getLanguage()),
  state: pageState,
  accountChanged: () => refreshWorkspaces(),
};

function renderWorkspaceSwitcher() {
  const container = $("#workspaceSwitcher");
  if (!container) return;
  const choices = workspaceOptions();
  const workspace = getWorkspace();
  if (choices.length < 2) {
    container.innerHTML = "";
    return;
  }
  const selected = workspace.type === "personal" ? "personal" : workspace.propertyId;
  container.innerHTML = `<label for="workspaceSelect">Workspace</label>
    <select id="workspaceSelect" class="select" translate="no">${choices
      .map((choice) => `<option value="${escapeHtml(choice.value)}"${choice.value === selected ? " selected" : ""}>${escapeHtml(choice.label)}</option>`)
      .join("")}</select>`;
}

// Loaders finish asynchronously. Each one gets a root that goes inert as soon as
// a newer render starts, so a slow, stale loader can never overwrite fresh content.
function guardedRoot(element, sequence) {
  const live = () => sequence === loadSequence;
  return {
    querySelector: (selector) => (live() ? element.querySelector(selector) : null),
    querySelectorAll: (selector) => (live() ? element.querySelectorAll(selector) : []),
    insertAdjacentHTML: (position, html) => {
      if (live()) element.insertAdjacentHTML(position, html);
    },
    get isStale() {
      return !live();
    },
  };
}

function runPageLoader(content) {
  const sequence = ++loadSequence;
  const loader = modulePages[currentPage]?.load ?? personalLoaders[currentPage];
  if (!loader) return;
  const root = guardedRoot(content, sequence);
  Promise.resolve()
    .then(() => loader(pageContext, root))
    .catch((error) => {
      if (sequence !== loadSequence) return;
      const message = error instanceof Error ? error.message : "Could not load this page.";
      root.querySelectorAll("[data-slot] > .muted-note").forEach((node) => {
        if (node.textContent === "Loading…") node.textContent = "Not available.";
      });
      root.insertAdjacentHTML("afterbegin", `<div class="notice notice-danger" role="alert">${escapeHtml(message)}</div>`);
    })
    .finally(() => {
      if (sequence === loadSequence) translateTree(content, getLanguage());
    });
}

let lastAccountKey = null;

async function refreshWorkspaces({ force = true } = {}) {
  const memberships = await loadWorkspaces();
  const account = currentAccount();
  const key = JSON.stringify([account.permanent, account.email, account.emailVerified, memberships]);
  const changed = key !== lastAccountKey;
  lastAccountKey = key;
  // A background anonymous sign-in changes nothing visible (the Account page included);
  // re-rendering would wipe a half-typed email and password or any other form.
  if (!force && !changed) return;
  const allowed = new Set([...pageIdsOf(currentNavigation()), ...alwaysAvailable]);
  if (!allowed.has(currentPage)) currentPage = workspaceHome[getWorkspace().type];
  render();
}

function render() {
  charts.forEach((chart) => chart.destroy());
  charts = [];

  renderWorkspaceSwitcher();
  renderNavigation();
  renderPageHeading();
  const modulePage = modulePages[currentPage];
  const content = $("#content");
  content.innerHTML = modulePage ? modulePage.render(pageContext) : pageRenderers[currentPage]();
  document.body.classList.toggle("workspace-rental", getWorkspace().type !== "personal");
  renderCharts();
  renderGameChrome(currentPage);
  updateNotificationBadge();
  animateNumbers();
  const language = getLanguage();
  document.documentElement.lang = language;
  applyTheme(document.body.classList.contains("theme-dark") ? "dark" : "light");
  document.title = "SmartWatts | Energy Dashboard";
  translateTree(document.documentElement, language);
  runPageLoader(content);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = translateText(message);
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2600);
}

function applyTheme(theme) {
  const dark = theme === "dark";
  document.body.classList.toggle("theme-dark", dark);
  const button = $("#themeToggle");
  button.textContent = dark ? "☀️" : "🌙";
  button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  button.title = dark ? "Switch to light mode" : "Switch to dark mode";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#191714" : "#fffaf2");
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#menuToggle").setAttribute("aria-expanded", "false");
}

function navigate(page) {
  if (!pageTitles[page]) return;
  const workspace = getWorkspace();
  if (!pageIdsOf(currentNavigation()).has(page) && !alwaysAvailable.has(page)) {
    if (pageIdsOf(personalNavigation).has(page)) setWorkspace(null);
    else if (workspace.type === "personal") page = "rentals-start";
    else return;
  }

  currentPage = page;
  navigationEpoch += 1;
  render();
  closeSidebar();
  window.scrollTo(0, 0);
}

// Saves finish asynchronously. If the person has moved to another page by then, a late
// "redraw" from the finished action must not rebuild that page and wipe what they typed.
let navigationEpoch = 0;
function actionContext() {
  const startedAt = navigationEpoch;
  return { ...pageContext, render: () => { if (startedAt === navigationEpoch) render(); } };
}

// Global interactions
const actionMessages = {
  export: "Demo export prepared. Connect a backend to download real records.",
  download: "Sample statement download is not connected yet.",
  pay: "SmartWatts does not process payments. Pay through your electric utility's official channels.",
  markRead: "All notifications marked as read.",
  challengeDone: "You have already completed today's sample challenge.",
};

document.addEventListener("click", (event) => {
  const actButton = event.target.closest("[data-act]");
  if (actButton) {
    const handler = personalActions[actButton.dataset.act] ?? rentalActions[actButton.dataset.act] ?? locatorActions[actButton.dataset.act] ?? calendarActions[actButton.dataset.act];
    if (handler) {
      event.preventDefault();
      actButton.disabled = true;
      Promise.resolve(handler(actButton, actionContext()))
        .catch((error) => toast(error instanceof Error ? error.message : "Something went wrong."))
        .finally(() => {
          if (actButton.isConnected) actButton.disabled = false;
        });
    }
    return;
  }

  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    if (pageButton.closest("#notificationPopover")) {
      $("#notificationPopover").hidden = true;
      $("#notificationsBtn").setAttribute("aria-expanded", "false");
    }
    navigate(pageButton.dataset.page);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const action = actionButton.dataset.action;
    if (action === "checkin") {
      checkIn(actionButton);
      return;
    }
    if (action === "coin-history") {
      event.preventDefault();
      document.querySelector("#coin-ledger")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action === "download") {
      downloadUsageRecord(Number(actionButton.dataset.recordIndex || 0));
      return;
    }
    if (action === "export") {
      if (currentPage === "breakdown") {
        exportAnalyticsReport(actionButton);
      } else {
        exportUsageHistory();
      }
      return;
    }
    if (action === "markRead") {
      markAllNotificationsRead();
      toast(actionMessages.markRead);
      return;
    }
    toast(actionMessages[action] || "Action selected.");
  }

  const coinTab = event.target.closest("[data-coin-tab]");
  if (coinTab) {
    window.__smartWattsCoinTab = coinTab.dataset.coinTab;
    render();
    return;
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "dailyHabitCheck") {
    const button = document.querySelector('[data-action="checkin"]');
    if (button) button.disabled = !event.target.checked;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches?.("[data-locator]")) handleLocatorInput(event.target);
});

document.addEventListener("change", (event) => {
  const changed = event.target;
  if (changed.matches("[data-locator]")) {
    handleLocatorInput(changed);
    return;
  }
  if (changed.id === "workspaceSelect") {
    setWorkspace(changed.value === "personal" ? null : { propertyId: changed.value });
    navigate(workspaceHome[getWorkspace().type]);
    return;
  }
  if (changed.matches("[data-ocr]")) {
    if (changed.dataset.ocr === "personal-bill") handlePersonalBillOcr(changed, pageContext);
    else if (changed.dataset.ocr === "appliance-label") handleApplianceLabelScan(changed, pageContext);
    else handleRentalOcr(changed.dataset.ocr, changed, pageContext);
    return;
  }
  if (changed.id === "ui-language") {
    setLanguage(changed.value);
    return;
  }
  if (changed.matches("[data-chart-range]")) {
    charts.forEach((chart) => chart.destroy());
    charts = [];
    renderCharts();
  }
});

window.addEventListener("smartwatts-language-change", (event) => {
  const language = typeof event.detail === "string" ? event.detail : "en";
  $("#ui-language").value = language;
  const unsaved = captureFormValues();
  render();
  restoreFormValues(unsaved);
  // Keep the preference with the account (users/{uid}) so it follows the person across devices.
  savePreferredLanguage(language).catch(() => toast("Your language changed for this session, but SmartWatts could not save the preference."));
});

// On sign-in, adopt the account's saved language only if this browser has no choice of its own.
let languageRestoredFor = null;
async function restoreAccountLanguage() {
  const { uid, permanent } = currentAccount();
  if (!permanent || !uid || languageRestoredFor === uid) return;
  languageRestoredFor = uid;
  let hasLocalChoice = true;
  try {
    hasLocalChoice = localStorage.getItem("smartwatts-language") !== null;
  } catch {
    hasLocalChoice = true;
  }
  if (hasLocalChoice) return;
  const saved = await loadPreferredLanguage();
  if (saved && saved !== getLanguage()) setLanguage(saved);
}

// Changing the interface language re-renders the page; carry unsaved form input across it.
function captureFormValues() {
  return [...document.querySelectorAll("#content form[data-form] [name]")]
    .filter((field) => field.type !== "file" && field.type !== "hidden")
    .map((field) => ({
      form: field.form?.dataset.form,
      name: field.name,
      value: field.value,
      checked: field.checked,
      type: field.type,
    }));
}

function restoreFormValues(saved) {
  for (const entry of saved) {
    const field = document.querySelector(`#content form[data-form="${CSS.escape(entry.form ?? "")}"] [name="${CSS.escape(entry.name)}"]`);
    if (!field) continue;
    if (entry.type === "checkbox" || entry.type === "radio") field.checked = entry.checked;
    else field.value = entry.value;
  }
}

window.addEventListener("smartwatts-translation-error", (event) => {
  const detail = event.detail;
  toast(`Translation unavailable: ${typeof detail === "string" ? detail : "Please try again."}`);
});

window.addEventListener("smartwatts-translation-complete", (event) => {
  if (event.detail !== getLanguage()) return;
  charts.forEach((chart) => chart.destroy());
  charts = [];
  renderCharts();
});

window.addEventListener("smartwatts-languages-loaded", (event) => {
  const languages = event.detail;
  if (!Array.isArray(languages) || !languages.length) return;
  const selector = $("#ui-language");
  const selected = languages.some((language) => language.code === getLanguage()) ? getLanguage() : "en";
  selector.replaceChildren(...languages.map((language) => new Option(language.name, language.code)));
  selector.value = selected;
  // Only re-render when the language actually changes. Re-rendering for an unchanged language
  // (this list loads asynchronously after startup) wiped half-filled forms at random moments.
  if (selected !== getLanguage()) setLanguage(selected);
});

$("#themeToggle").addEventListener("click", () => {
  const theme = document.body.classList.contains("theme-dark") ? "light" : "dark";
  try {
    localStorage.setItem("smartwatts-theme", theme);
  } catch {
    toast("Theme changed for this session; browser storage is unavailable.");
  }
  applyTheme(theme);
  render();
});

document.addEventListener("submit", (event) => {
  const formName = event.target.dataset?.form;
  const formHandler = formName && (personalForms[formName] ?? rentalForms[formName]);
  if (formHandler) {
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('[type="submit"], button:not([type])');
    if (submit) submit.disabled = true;
    Promise.resolve(formHandler(form, actionContext()))
      .catch((error) => toast(error instanceof Error ? error.message : "Something went wrong."))
      .finally(() => {
        if (submit?.isConnected) submit.disabled = false;
      });
    return;
  }
  if (event.target.id === "energyGoalForm") {
    event.preventDefault();
    const form = event.target;
    const target = Number(new FormData(form).get("target"));
    if (!Number.isFinite(target) || target < 50 || target > 2000) {
      toast("Choose a monthly target from 50 to 2,000 kWh.");
      return;
    }
    const persisted = saveMonthlyEnergyTarget(target);
    addNotification("target", "Energy Goal Updated", `Monthly energy target set to ${target} kWh.`);
    render();
    toast(persisted ? "Monthly energy target updated." : "Target updated for this session; browser storage is unavailable.");
    return;
  }

  if (event.target.id === "accountForm") {
    event.preventDefault();
    toast("Account changes saved in this demo.");
  }
});

$("#menuToggle").addEventListener("click", () => {
  const isOpen = $("#sidebar").classList.toggle("open");
  $("#menuToggle").setAttribute("aria-expanded", String(isOpen));
});

$("#notificationsBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  const button = event.currentTarget;
  const popover = $("#notificationPopover");
  const open = popover.hidden;
  popover.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) refreshNotificationPopover();
});

document.addEventListener("click", (event) => {
  const wrap = $("#notificationWrap");
  if (!wrap?.contains(event.target)) {
    const popover = $("#notificationPopover");
    if (popover && !popover.hidden) {
      popover.hidden = true;
      $("#notificationsBtn")?.setAttribute("aria-expanded", "false");
    }
  }
});

// The mobile tab bar's "More" button opens the same navigation drawer as the top menu button.
$("#mobileMore").addEventListener("click", () => {
  $("#sidebar").classList.add("open");
  $("#menuToggle").setAttribute("aria-expanded", "true");
});

$("#closeSidebar").addEventListener("click", closeSidebar);
$("#sidebarBackdrop").addEventListener("click", closeSidebar);

let savedTheme = "light";
try {
  savedTheme = localStorage.getItem("smartwatts-theme") === "dark" ? "dark" : "light";
} catch {
  savedTheme = "light";
}
applyTheme(savedTheme);
$("#ui-language").value = getLanguage();

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSidebar();
    $("#notificationPopover").hidden = true;
    $("#notificationsBtn").setAttribute("aria-expanded", "false");
  }
});

setGameCallbacks({ render, toast, pageHead, stat, panel, language: getLanguage });
if (readInviteFromHash()) currentPage = "join";
lastAccountKey = JSON.stringify([false, null, false, []]);
onAccountChange((state) => {
  setGameUser(state.uid);
  setNotificationUser(state.uid);
  renderPageHeading();
  updateNotificationBadge();
  refreshWorkspaces({ force: false }).catch(() => toast("SmartWatts could not refresh your account workspace. Try again shortly."));
  restoreAccountLanguage().catch(() => toast("SmartWatts could not load your saved language preference."));
});

window.addEventListener("smartwatts-appliance-saved", (event) => {
  addNotification("plug-zap", "Appliance Saved", `${event.detail || "Appliance"} was registered to your household.`);
});

window.addEventListener("smartwatts-bill-saved", async (event) => {
  const detail = event.detail;
  const period = detail ? `${detail.periodStart} – ${detail.periodEnd}` : "";
  addNotification("receipt-text", "Electricity Bill Saved", `Bill for ${period} was recorded.`);
  if (detail?.verified === true && detail?.kwh != null && detail?.periodStart && detail?.periodEnd) {
    try {
      const bills = (await listBills()).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
      const previous = bills.filter((bill) => bill.periodEnd < detail.periodStart).at(-1);
      if (previous) {
        const awarded = awardMonthlyReduction(Number(detail.kwh), previous.kwh, detail.periodEnd.slice(0, 7));
        if (awarded > 0) addNotification("circle-check", "Monthly kWh Bonus Earned", `You earned ${formatCoins(awarded)} Watts Coins for reducing usage by ${(previous.kwh - Number(detail.kwh)).toFixed(2)} kWh.`);
      }
    } catch {
      // A saved bill remains recorded even when a local bonus comparison cannot run.
    }
  }
});

window.addEventListener("smartwatts-coins-expiring", (event) => {
  const amount = formatCoins(event.detail.amountCents);
  const date = new Date(event.detail.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
  addNotification("clock", "Watts Coins Expiring Soon", `${amount} coin(s) expire on ${date}. Use them during your next eligible bill payment or renewal window.`);
});

window.addEventListener("smartwatts-coins-expired", (event) => {
  addNotification("circle-minus", "Watts Coins Expired", `${formatCoins(event.detail.amountCents)} Watts Coins expired after the three-month validity period.`);
});

window.addEventListener("smartwatts-plan-saved", (event) => {
  addNotification("trending-down", "Savings Plan Saved", `Savings plan "${event.detail}" was created.`);
});

// Reconcile expiry while the app is open and whenever the user returns to the tab.
window.addEventListener("focus", () => getCoinState());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") getCoinState();
});
window.setInterval(() => getCoinState(), 60_000);
render();

loadSupportedLanguages()
  .then((languages) => {
    window.dispatchEvent(new CustomEvent("smartwatts-languages-loaded", { detail: languages }));
  })
  .catch((error) => {
    window.dispatchEvent(new CustomEvent("smartwatts-languages-loaded", {
      // Without Google Cloud Translation, offer every language with a local dictionary.
      detail: getSupportedLanguages(),
    }));
    const message = error instanceof Error ? error.message : "Could not load supported languages.";
    window.dispatchEvent(new CustomEvent("smartwatts-translation-error", { detail: message }));
  });
