import {
  animateNumbers,
  claimQuest,
  CHART_COLORS,
  gamificationCard,
  goalsPage,
  saveMonthlyEnergyTarget,
  renderGameChrome,
  rewardsPage,
  setGameCallbacks,
} from "./game.js";
import { getLanguage, loadSupportedLanguages, setLanguage, translateText, translateTree } from "./i18n.js";

// Navigation and screen copy
const navigationGroups = [
  {
    label: "MONITOR",
    items: [
      ["dashboard", "layout-dashboard", "Dashboard"],
      ["realtime", "activity", "Real-time Monitor"],
      ["history", "history", "Usage History"],
      ["breakdown", "chart-no-axes-column-increasing", "Analytics"],
      ["devices", "plug-zap", "Device Monitor"],
    ],
  },
  {
    label: "SAVE & EARN",
    items: [
      ["goals", "target", "Energy Goals"],
      ["rewards", "trophy", "Rewards & Badges"],
    ],
  },
  {
    label: "BILLING",
    items: [
      ["billing", "credit-card", "Billing & Payments"],
      ["bills", "receipt-text", "Bill History"],
      ["rates", "badge-dollar-sign", "Rates Overview"],
    ],
  },
  {
    label: "SETTINGS",
    items: [
      ["notifications", "bell", "Notifications"],
      ["account", "user-round-cog", "Account Settings"],
      ["support", "message-circle-question", "Help & Support"],
    ],
  },
  {
    label: "MORE",
    items: [["about", "users-round", "About Team"]],
  },
];

const pageTitles = {
  dashboard: ["Good morning, Rean Justine!", "Here's what's happening with your electricity today."],
  realtime: ["Real-time Monitor", "Track your electricity usage as it happens."],
  history: ["Usage History", "Review and compare your past electricity consumption."],
  breakdown: ["Analytics", "Understand where your electricity is being consumed."],
  devices: ["Device Monitor", "Monitor connected appliances and their energy usage."],
  goals: ["Energy Goals", "Build better habits and track your household energy targets."],
  rewards: ["Rewards & Badges", "Celebrate the small steps that help you use energy wisely."],
  billing: ["Billing & Payments", "Review your estimated bill and payment details."],
  bills: ["Bill History", "View your previous statements and payments."],
  rates: ["Rates Overview", "Understand your electricity rate and charges."],
  notifications: ["Notifications", "Stay updated with usage alerts and account activity."],
  account: ["Account Settings", "Manage your profile and account preferences."],
  support: ["Help & Support", "Find answers or contact the SmartWatts support team."],
  about: ["About Team", "Meet the people and purpose behind SmartWatts."],
};

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

const notificationItems = [
  ["triangle-alert", "High Usage Alert", "Your usage is 20% higher than yesterday at this time.", "9:15 AM"],
  ["receipt-text", "Bill is Ready", "Your May 2026 bill is now available.", "Yesterday"],
  ["circle-check", "Payment Received", "Thank you! Your payment of ₱1,150.00 was successful.", "Apr 15"],
  ["plug-zap", "Device Connected", "A new device was added to your monitor.", "Apr 12"],
];

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
  $("#navigation").innerHTML = navigationGroups
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
  $("#pageTitle").textContent = title;
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

function notificationList(items = notificationItems) {
  return items
    .map(
      ([iconName, title, message, time]) => `
        <div class="alert">
          <div class="alert-icon">${icon(iconName, 18)}</div>
          <div style="flex:1">
            <time>${time}</time><strong>${title}</strong><p>${message}</p>
          </div>
        </div>`,
    )
    .join("");
}

function deviceCards() {
  return `
    <div class="grid card-grid">
      ${devices
        .map(
          ([iconName, name, usage, percent], index) => `
            <article class="panel device-card">
              <div class="device-card-top">
                <span class="stat-icon">${icon(iconName, 22)}</span>
                <span class="status ${index === 4 ? "off" : ""}">${index === 4 ? "Standby" : "Online"}</span>
              </div>
              <h3>${name}</h3>
              <p>Device energy consumption</p>
              <div class="stat-value">${usage} <small>kWh</small></div>
              <div class="bar"><span style="width:${parseInt(percent, 10)}%"></span></div>
              <div class="stat-foot">${percent} of total usage</div>
              <button class="btn btn-outline" style="margin-top:13px" data-action="device">View Details</button>
            </article>`,
        )
        .join("")}
    </div>`;
}

function historyTable() {
  return `
    <table class="table">
      <thead><tr><th>Billing Period</th><th>Consumption</th><th>Amount</th><th>Status</th><th>Statement</th></tr></thead>
      <tbody>
        ${historyRecords
          .map(
            ([period, usage, amount, status]) => `
              <tr>
                <td>${period}</td><td>${usage}</td><td><b>${amount}</b></td>
                <td><span class="status">${status}</span></td>
                <td><button class="btn btn-outline" data-action="download">${icon("download", 15)} Download</button></td>
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
      ${stat("gauge", "Current Usage", "0.62", "kW", "As of 10:24 AM", `${icon("radio", 13)} Live`)}
      ${stat("chart-no-axes-column-increasing", "Today's Consumption", "11.45", "kWh", "vs yesterday", `${icon("trending-down", 13)} 8.6%`)}
      ${stat("chart-pie", "This Month", "342.18", "kWh", "vs last month", `${icon("trending-up", 13)} 12.4%`)}
      ${stat("receipt", "Est. Bill Amount", "₱1,256.34", "", "Due on May 20, 2026", "")}
    </div>
    ${gamificationCard()}
    <div class="dashboard-layout">
      <div class="left-stack">
        ${panel("Real-time Usage", chartCanvas("usageChart", "tall"), `<span class="live">${icon("radio", 13)} Live</span><select class="select" data-chart-range="dashboard" aria-label="Usage time range"><option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="quarter">Quarterly</option><option value="year">Yearly</option></select>`)}
        <div class="two-panels">
          ${panel("Usage Breakdown <small>(This Month)</small>", `<div class="donut-layout"><div class="donut-wrap"><canvas id="usageDonut"></canvas></div><div class="legend">${usageLegend}</div></div><button class="btn btn-outline" data-page="breakdown">View Full Breakdown</button>`)}
          ${panel("Top Devices <small>(This Month)</small>", deviceTable())}
        </div>
      </div>
      <div class="right-stack">
        ${panel("Account Overview", `<div class="detail-list">${detail("Account Name", "Rean Justine O. Baulite")}${detail("Account Number", "1234 5678 9012")}${detail("Service Address", "123 Main St., Brgy. 123, Makati City, Metro Manila")}${detail("Rate", "Residential")}</div><button class="btn btn-outline" style="width:100%;margin-top:17px" data-page="account">View Account Details</button>`)}
        ${panel("Alerts & Notifications", notificationList(notificationItems.slice(0, 3)), `<button class="text-link" data-page="notifications">View all</button>`)}
        ${panel("Bill Estimate", `<div class="stat-label">Based on your current usage</div><div class="bill-amount">₱1,256.34</div><div class="progress"><span></span></div><div class="detail-list" style="margin:13px 0">${detail("Due Date", "May 20, 2026")}${detail("Billing Period", "Apr 1 – Apr 30, 2026")}</div><button class="btn btn-primary" style="width:100%" data-page="billing">View Bill & Pay</button>`)}
      </div>
    </div>`;
}

// Individual screen templates
function realtimePage() {
  return `
    ${pageHead("Live electricity consumption", "Your meter usage updates in real time.", `<span class="live">${icon("radio", 13)} Live</span><select class="select" data-chart-range="realtime" aria-label="Usage time range"><option value="today">Today</option><option value="last24">Last 24 hours</option><option value="week">This Week</option><option value="month">This Month</option><option value="quarter">Quarterly</option><option value="year">Yearly</option></select>`)}
    <div class="grid stats">
      ${stat("zap", "Current Load", "0.62", "kW", "Live reading", `${icon("radio", 13)} Active`)}
      ${stat("clock", "Peak Today", "1.32", "kW", "At 7:30 AM", "")}
      ${stat("chart-no-axes-column-increasing", "Today's Energy", "11.45", "kWh", "Since 12:00 AM", "")}
      ${stat("gauge", "Average Load", "0.48", "kW", "Today's average", "")}
    </div>
    ${panel("Live Usage Trend", chartCanvas("realtimeChart", "tall"))}
    <div class="grid card-grid" style="margin-top:14px">
      ${panel("Meter Status", `<span class="status">Connected</span><p class="stat-foot">Last sync: Just now</p>`)}
      ${panel("Today's Peak", `<div class="bill-amount">1.32 kW</div><p class="stat-foot">Recorded at 7:30 AM</p>`)}
      ${panel("Energy Today", `<div class="bill-amount">11.45 kWh</div><p class="stat-foot">Estimated daily usage</p>`)}
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

function devicesPage() {
  return `
    ${pageHead("Connected devices", "Track appliance activity and energy consumption.", `<button class="btn btn-primary" data-action="addDevice">${icon("plus", 16)} Add Device</button>`)}
    <div class="grid stats">
      ${stat("plug-zap", "Total Devices", "5", "", "Connected appliances", "")}
      ${stat("radio", "Currently Online", "4", "", "Active devices", "")}
      ${stat("zap", "Combined Load", "0.62", "kW", "Current demand", "")}
      ${stat("chart-no-axes-column-increasing", "Device Usage", "342.18", "kWh", "This month", "")}
    </div>
    ${deviceCards()}`;
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
      ${panel("Current Bill", `<div class="stat-label">Estimated amount due</div><div class="bill-amount">₱1,256.34</div><p class="stat-foot">Due date: May 20, 2026</p><div class="progress"><span></span></div><p class="stat-foot">Your estimated bill is based on current consumption.</p><button class="btn btn-primary" style="margin-top:15px" data-action="pay">Proceed to Payment</button>`)}
      ${panel("Bill Breakdown", tableRows(breakdownRows))}
    </div>
    <div style="margin-top:14px">${panel("Payment Methods", `<div class="detail-row"><span>Available payment channels</span><b>Online banking · E-wallet · Payment centers</b></div><p class="stat-foot">Payments are simulated in this UI demo. No real transaction will be made.</p>`)}</div>`;
}

function billsPage() {
  return `
    ${pageHead("Bill history", "Your statements and payment records.", `<select class="select"><option>All years</option><option>2026</option><option>2025</option></select><button class="btn btn-outline" data-action="export">Export</button>`)}
    ${panel("Previous Statements", historyTable())}`;
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
  const allNotifications = [...notificationItems, ...notificationItems.slice(0, 2)];
  return `
    ${pageHead("Alerts & notifications", "Recent updates about your electricity account.", `<button class="btn btn-outline" data-action="markRead">Mark all as read</button>`)}
    ${panel("Recent Activity", notificationList(allNotifications))}`;
}

function accountPage() {
  return `
    ${pageHead("Account settings", "Manage your account details and preferences.")}
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
      ${panel("Frequently Asked Questions", `<h3>How is my bill estimated?</h3><p class="stat-foot">Your estimate uses recent consumption and sample rates. Your official bill is the final reference.</p><h3>How do I monitor a device?</h3><p class="stat-foot">Open Device Monitor to review connected appliance usage.</p>`)}
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
      ${panel("Our team", `<div class="about-card-icon">${icon("users-round", 22)}</div><h3>Project team</h3><p>Team member names and roles are omitted until verified details are available.</p>`)}
    </div>
    <p class="about-note">This demo uses sample account and usage data. It is not affiliated with or an official service of MERALCO.</p>`;
}

const pageRenderers = {
  dashboard: dashboardPage,
  realtime: realtimePage,
  history: historyPage,
  breakdown: analyticsPage,
  devices: devicesPage,
  goals: goalsPage,
  rewards: rewardsPage,
  billing: billingPage,
  bills: billsPage,
  rates: ratesPage,
  notifications: notificationsPage,
  account: accountPage,
  support: supportPage,
  about: aboutPage,
};

// Page rendering and navigation
function render() {
  charts.forEach((chart) => chart.destroy());
  charts = [];

  renderNavigation();
  renderPageHeading();
  $("#content").innerHTML = pageRenderers[currentPage]();
  renderCharts();
  renderGameChrome(currentPage);
  animateNumbers();
  const language = getLanguage();
  document.documentElement.lang = language;
  applyTheme(document.body.classList.contains("theme-dark") ? "dark" : "light");
  document.title = "SmartWatts | Energy Dashboard";
  translateTree(document.documentElement, language);
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

  currentPage = page;
  render();
  closeSidebar();
  window.scrollTo(0, 0);
}

// Global interactions
const actionMessages = {
  export: "Demo export prepared. Connect a backend to download real records.",
  download: "Sample statement download is not connected yet.",
  pay: "Payment is a demo action. No transaction was made.",
  addDevice: "Device pairing is ready for backend integration.",
  device: "Device details opened in demo mode.",
  markRead: "All notifications marked as read.",
  challengeDone: "You have already completed today's sample challenge.",
};

document.addEventListener("click", (event) => {
  const questButton = event.target.closest("[data-quest]");
  if (questButton) {
    claimQuest(questButton.dataset.quest, questButton);
    return;
  }

  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    navigate(pageButton.dataset.page);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    toast(actionMessages[actionButton.dataset.action] || "Action selected.");
  }
});

document.addEventListener("change", (event) => {
  const changed = event.target;
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
  render();
});

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
  if (selected !== getLanguage()) setLanguage(selected);
  else window.dispatchEvent(new CustomEvent("smartwatts-language-change", { detail: selected }));
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
  if (event.target.id === "energyGoalForm") {
    event.preventDefault();
    const form = event.target;
    const target = Number(new FormData(form).get("target"));
    if (!Number.isFinite(target) || target < 50 || target > 2000) {
      toast("Choose a monthly target from 50 to 2,000 kWh.");
      return;
    }
    const persisted = saveMonthlyEnergyTarget(target);
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
  if (event.key === "Escape") closeSidebar();
});

setGameCallbacks({ render, toast, pageHead, stat, panel, language: getLanguage });
render();

render();

loadSupportedLanguages()
  .then((languages) => {
    window.dispatchEvent(new CustomEvent("smartwatts-languages-loaded", { detail: languages }));
  })
  .catch((error) => {
    window.dispatchEvent(new CustomEvent("smartwatts-languages-loaded", {
      detail: [
        { code: "en", name: "English" },
        { code: "tl", name: "Tagalog" },
      ],
    }));
    const message = error instanceof Error ? error.message : "Could not load supported languages.";
    window.dispatchEvent(new CustomEvent("smartwatts-translation-error", { detail: message }));
  });
