import { estimateMonthlyKwh, effectiveRateCentavosPerKwh } from "./estimates";
import type { Appliance, PersonalBill } from "./store";

export interface MonthOption {
  key: string; // "YYYY-MM"
  label: string; // e.g. "May 2026"
}

export interface ApplianceBreakdownItem {
  id: string;
  name: string;
  category: string;
  icon: string;
  kwh: number;
  percent: number;
  basis: string;
}

export interface DonutLegendItem {
  name: string;
  kwhText: string;
  percentText: string;
}

export interface MonthlyTrendPoint {
  monthKey: string;
  label: string;
  kwh: number | null;
  isMissing: boolean;
}

export interface PersonalAnalyticsData {
  selectedMonth: string; // "YYYY-MM"
  monthLabel: string; // "May 2026"
  availableMonths: MonthOption[];

  totalUsage: {
    kwh: number | null;
    displayValue: string;
    unit: string;
    foot: string;
    basis: "billed" | "modeled" | "empty";
  };

  estimatedCost: {
    amountPesos: number | null;
    displayValue: string;
    foot: string;
    basis: "billed" | "modeled" | "empty";
  };

  largestConsumer: {
    name: string;
    percent: number | null;
    displayPercent: string;
    kwh: number | null;
    foot: string;
    icon: string;
  };

  comparedToLastMonth: {
    percentChange: number | null;
    displayText: string;
    trendDirection: "up" | "down" | "flat" | "none";
    trendText: string;
    foot: string;
  };

  donut: {
    labels: string[];
    values: number[];
    legend: DonutLegendItem[];
    hasData: boolean;
  };

  trend: {
    labels: string[];
    values: (number | null)[];
    hasData: boolean;
    points: MonthlyTrendPoint[];
  };

  tableRows: ApplianceBreakdownItem[];
  matchedBill: PersonalBill | null;
}

/** Parse a "YYYY-MM" string into { year, month } */
export function parseMonthKey(monthKey: string): { year: number; month: number } | null {
  if (!monthKey || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey)) return null;
  const [y, m] = monthKey.split("-").map(Number);
  return { year: y, month: m };
}

/** Format "YYYY-MM" to user-facing string using Asia/Manila timezone (e.g. "May 2026" or "May") */
export function formatMonthLabel(monthKey: string, format: "long" | "short" = "long"): string {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return monthKey;
  // Use day 15 to stay safely within calendar month boundaries in Asia/Manila (UTC+8)
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, 15, 12, 0, 0));
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: format === "long" ? "long" : "short",
    year: format === "long" ? "numeric" : undefined,
  }).format(date);
}

/** Get the immediately preceding month key (e.g. "2026-05" -> "2026-04", "2026-01" -> "2025-12") */
export function previousMonthKey(monthKey: string): string {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return monthKey;
  let { year, month } = parsed;
  month -= 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Return an array of consecutive month keys ending at endMonthKey */
export function getRollingMonthKeys(endMonthKey: string, count = 6): string[] {
  const keys: string[] = [];
  let curr = endMonthKey;
  for (let i = 0; i < count; i++) {
    keys.unshift(curr);
    curr = previousMonthKey(curr);
  }
  return keys;
}

/** Current calendar month in Asia/Manila ("YYYY-MM") */
export function currentManilaMonthKey(): string {
  const now = new Date();
  const manilaDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  }).format(now);
  return manilaDateStr.slice(0, 7);
}

/** Collect available month options for dropdown from saved bills and current window */
export function getAvailableMonths(bills: PersonalBill[] = [], referenceMonthKey?: string): MonthOption[] {
  const ref = referenceMonthKey && parseMonthKey(referenceMonthKey) ? referenceMonthKey : currentManilaMonthKey();
  const monthSet = new Set<string>();

  // Include 6 rolling months ending at reference month
  for (const m of getRollingMonthKeys(ref, 6)) {
    monthSet.add(m);
  }

  // Include any month with saved bill records
  for (const bill of bills) {
    if (bill.periodEnd && bill.periodEnd.length >= 7) {
      const k = bill.periodEnd.slice(0, 7);
      if (parseMonthKey(k)) monthSet.add(k);
    }
    if (bill.periodStart && bill.periodStart.length >= 7) {
      const k = bill.periodStart.slice(0, 7);
      if (parseMonthKey(k)) monthSet.add(k);
    }
  }

  // Sort descending: newest month first
  const sorted = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
  return sorted.map((key) => ({
    key,
    label: formatMonthLabel(key, "long"),
  }));
}

/** Icon name lookup for appliance categories matching app.js iconPaths */
export function categoryToIcon(category: string): string {
  const norm = (category || "").toLowerCase().trim();
  if (norm.includes("cool") || norm.includes("aircon") || norm.includes("ac")) return "snowflake";
  if (norm.includes("refrig") || norm.includes("fridge")) return "refrigerator";
  if (norm.includes("tv") || norm.includes("entertain")) return "tv";
  if (norm.includes("laund") || norm.includes("wash")) return "washing-machine";
  if (norm.includes("light")) return "zap";
  if (norm.includes("comput")) return "zap";
  return "package";
}

/** User-friendly category display name */
export function categoryToLabel(category: string): string {
  const norm = (category || "").toLowerCase().trim();
  switch (norm) {
    case "cooling":
      return "Air Conditioner / Cooling";
    case "refrigeration":
      return "Refrigerator";
    case "lighting":
      return "Lighting";
    case "entertainment":
      return "Television & Entertainment";
    case "laundry":
      return "Washing Machine & Laundry";
    case "cooking":
      return "Cooking";
    case "computing":
      return "Computing";
    case "other":
    case "others":
      return "Others";
    case "unattributed":
      return "Other Household Usage";
    default:
      return category ? category.charAt(0).toUpperCase() + category.slice(1) : "Other";
  }
}

/** Format currency in Philippine Pesos */
export function formatPeso(amountPesos: number): string {
  return `₱${amountPesos.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface ComputeAnalyticsParams {
  selectedMonth: string;
  bills?: PersonalBill[];
  appliances?: Appliance[];
  rateCentavosPerKwh?: number | null;
}

/**
 * Centralized, pure calculation function for Personal Energy Analytics.
 * Computes all metrics, card values, donut slices, rolling trend points,
 * and table rows for the specified reporting month.
 */
export function computePersonalAnalytics({
  selectedMonth,
  bills = [],
  appliances = [],
  rateCentavosPerKwh = null,
}: ComputeAnalyticsParams): PersonalAnalyticsData {
  const monthKey = parseMonthKey(selectedMonth) ? selectedMonth : currentManilaMonthKey();
  const monthLabel = formatMonthLabel(monthKey, "long");
  const availableMonths = getAvailableMonths(bills, monthKey);

  // 1. Identify bill(s) matching selectedMonth
  const matchingBills = bills.filter(
    (b) =>
      (b.periodEnd && b.periodEnd.slice(0, 7) === monthKey) ||
      (!b.periodEnd && b.periodStart && b.periodStart.slice(0, 7) === monthKey),
  );

  let matchedBill: PersonalBill | null = null;
  let billedKwh = 0;
  let billedCentavos = 0;

  if (matchingBills.length > 0) {
    // Primary bill or consolidated record
    matchedBill = matchingBills[0];
    billedKwh = matchingBills.reduce((acc, b) => acc + (Number(b.kwh) || 0), 0);
    billedCentavos = matchingBills.reduce((acc, b) => acc + (Number(b.amountCentavos) || 0), 0);
  }

  // 2. Identify effective rate from selected bill, other bills, or explicit param
  let effectiveRateCentavos = rateCentavosPerKwh;
  if (!effectiveRateCentavos && billedKwh > 0 && billedCentavos > 0) {
    effectiveRateCentavos = effectiveRateCentavosPerKwh({ kwh: billedKwh, amountCentavos: billedCentavos });
  }
  if (!effectiveRateCentavos) {
    // Check latest saved bill
    const latestBill = [...bills]
      .filter((b) => b.kwh > 0 && b.amountCentavos > 0)
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
    if (latestBill) {
      effectiveRateCentavos = effectiveRateCentavosPerKwh(latestBill);
    }
  }

  // 3. Compute appliance estimates
  const validAppliances = appliances.filter((a) => {
    try {
      return estimateMonthlyKwh(a) >= 0;
    } catch {
      return false;
    }
  });

  const applianceRows: ApplianceBreakdownItem[] = validAppliances.map((a) => {
    const kwh = estimateMonthlyKwh(a);
    return {
      id: a.id,
      name: a.name || categoryToLabel(a.category),
      category: a.category || "other",
      icon: categoryToIcon(a.category),
      kwh,
      percent: 0, // calculated below
      basis: "Estimated schedule",
    };
  });

  const totalApplianceKwh = applianceRows.reduce((acc, r) => acc + r.kwh, 0);

  // 4. Determine total usage & basis
  let totalUsageKwh: number | null = null;
  let totalUsageDisplay = "—";
  let totalUsageFoot = "No usage records for this month";
  let totalUsageBasis: "billed" | "modeled" | "empty" = "empty";

  if (billedKwh > 0) {
    totalUsageKwh = billedKwh;
    totalUsageDisplay = billedKwh.toFixed(2);
    totalUsageBasis = "billed";
    totalUsageFoot =
      matchedBill?.periodStart && matchedBill?.periodEnd
        ? `From bill: ${matchedBill.periodStart} – ${matchedBill.periodEnd}`
        : "Recorded bill consumption";
  } else if (totalApplianceKwh > 0) {
    totalUsageKwh = totalApplianceKwh;
    totalUsageDisplay = totalApplianceKwh.toFixed(2);
    totalUsageBasis = "modeled";
    totalUsageFoot = "Estimated appliance schedule (no bill for this month)";
  }

  // 5. Determine estimated cost & basis
  let costPesos: number | null = null;
  let costDisplay = "—";
  let costFoot = "No billing data";
  let costBasis: "billed" | "modeled" | "empty" = "empty";

  if (billedCentavos > 0) {
    costPesos = billedCentavos / 100;
    costDisplay = formatPeso(costPesos);
    costBasis = "billed";
    costFoot = "Billed amount";
  } else if (totalUsageKwh && totalUsageKwh > 0 && effectiveRateCentavos && effectiveRateCentavos > 0) {
    costPesos = (totalUsageKwh * effectiveRateCentavos) / 100;
    costDisplay = formatPeso(costPesos);
    costBasis = "modeled";
    costFoot = `Modeled at ₱${(effectiveRateCentavos / 100).toFixed(2)}/kWh`;
  } else if (totalUsageBasis === "modeled") {
    costFoot = "No bill or rate recorded";
  }

  // 6. Compared to Last Month
  const prevKey = previousMonthKey(monthKey);
  const prevBills = bills.filter(
    (b) =>
      (b.periodEnd && b.periodEnd.slice(0, 7) === prevKey) ||
      (!b.periodEnd && b.periodStart && b.periodStart.slice(0, 7) === prevKey),
  );
  const prevKwh = prevBills.reduce((acc, b) => acc + (Number(b.kwh) || 0), 0);

  let percentChange: number | null = null;
  let displayText = "Not available";
  let trendDirection: "up" | "down" | "flat" | "none" = "none";
  let trendText = "Not available";
  let comparedFoot = "Insufficient prior data";

  if (totalUsageKwh != null && totalUsageKwh > 0 && prevKwh > 0) {
    const diff = totalUsageKwh - prevKwh;
    percentChange = (diff / prevKwh) * 100;
    const rounded = Math.round(percentChange * 10) / 10;
    if (rounded > 0) {
      displayText = `+${rounded.toFixed(1)}%`;
      trendDirection = "up";
      trendText = "Consumption increase";
    } else if (rounded < 0) {
      displayText = `${rounded.toFixed(1)}%`;
      trendDirection = "down";
      trendText = "Consumption decrease";
    } else {
      displayText = "0.0%";
      trendDirection = "flat";
      trendText = "No change";
    }
    comparedFoot = `vs ${formatMonthLabel(prevKey)} (${prevKwh.toFixed(2)} kWh)`;
  }

  // 7. Reconcile breakdown items, percentages, and unattributed usage
  const effectiveTotal = totalUsageKwh != null && totalUsageKwh > 0 ? totalUsageKwh : totalApplianceKwh;
  const tableRows: ApplianceBreakdownItem[] = [];

  if (effectiveTotal > 0) {
    for (const row of applianceRows) {
      row.percent = Math.round((row.kwh / effectiveTotal) * 1000) / 10;
      tableRows.push(row);
    }

    // If billed kWh exceeds the sum of appliance estimates, account for the unattributed difference
    if (billedKwh > totalApplianceKwh) {
      const unattributedKwh = Math.round((billedKwh - totalApplianceKwh) * 100) / 100;
      const unattributedPct = Math.round((unattributedKwh / billedKwh) * 1000) / 10;
      tableRows.push({
        id: "unattributed-remainder",
        name: "Other Household Usage",
        category: "unattributed",
        icon: "package",
        kwh: unattributedKwh,
        percent: unattributedPct,
        basis: "Billed remainder",
      });
    }
  }

  // Sort table rows descending by kWh
  tableRows.sort((a, b) => b.kwh - a.kwh);

  // 8. Identify Largest Consumer
  let largestConsumerName = "—";
  let largestConsumerPercent: number | null = null;
  let largestConsumerDisplay = "—";
  let largestConsumerKwh: number | null = null;
  let largestConsumerFoot = "No appliances registered";
  let largestConsumerIcon = "snowflake";

  if (tableRows.length > 0 && tableRows[0].kwh > 0) {
    const top = tableRows[0];
    largestConsumerName = top.name;
    largestConsumerPercent = top.percent;
    largestConsumerDisplay = `${Math.round(top.percent)}%`;
    largestConsumerKwh = top.kwh;
    largestConsumerFoot = `${top.kwh.toFixed(2)} kWh estimated`;
    largestConsumerIcon = top.icon;
  }

  // 9. Build Donut Category Aggregation
  const categoryMap = new Map<string, { label: string; kwh: number }>();
  for (const row of tableRows) {
    const cat = row.category || "other";
    const existing = categoryMap.get(cat) ?? { label: categoryToLabel(cat), kwh: 0 };
    existing.kwh += row.kwh;
    categoryMap.set(cat, existing);
  }

  const donutLabels: string[] = [];
  const donutValues: number[] = [];
  const donutLegend: DonutLegendItem[] = [];

  for (const [, item] of categoryMap) {
    if (item.kwh > 0) {
      donutLabels.push(item.label);
      const roundedKwh = Math.round(item.kwh * 100) / 100;
      donutValues.push(roundedKwh);
      const pct = effectiveTotal > 0 ? (item.kwh / effectiveTotal) * 100 : 0;
      donutLegend.push({
        name: item.label,
        kwhText: `${roundedKwh.toFixed(2)} kWh`,
        percentText: `${pct.toFixed(1)}%`,
      });
    }
  }

  // 10. Build 6-Month Rolling Trend
  const trendKeys = getRollingMonthKeys(monthKey, 6);
  const trendPoints: MonthlyTrendPoint[] = trendKeys.map((k) => {
    const monthBills = bills.filter(
      (b) =>
        (b.periodEnd && b.periodEnd.slice(0, 7) === k) ||
        (!b.periodEnd && b.periodStart && b.periodStart.slice(0, 7) === k),
    );
    const hasBill = monthBills.length > 0;
    const kwh = hasBill ? monthBills.reduce((acc, b) => acc + (Number(b.kwh) || 0), 0) : null;
    return {
      monthKey: k,
      label: formatMonthLabel(k, "short"),
      kwh: kwh != null ? Math.round(kwh * 100) / 100 : null,
      isMissing: !hasBill,
    };
  });

  const trendHasData = trendPoints.some((p) => p.kwh !== null);

  return {
    selectedMonth: monthKey,
    monthLabel,
    availableMonths,
    totalUsage: {
      kwh: totalUsageKwh,
      displayValue: totalUsageDisplay,
      unit: "kWh",
      foot: totalUsageFoot,
      basis: totalUsageBasis,
    },
    estimatedCost: {
      amountPesos: costPesos,
      displayValue: costDisplay,
      foot: costFoot,
      basis: costBasis,
    },
    largestConsumer: {
      name: largestConsumerName,
      percent: largestConsumerPercent,
      displayPercent: largestConsumerDisplay,
      kwh: largestConsumerKwh,
      foot: largestConsumerFoot,
      icon: largestConsumerIcon,
    },
    comparedToLastMonth: {
      percentChange,
      displayText,
      trendDirection,
      trendText,
      foot: comparedFoot,
    },
    donut: {
      labels: donutLabels,
      values: donutValues,
      legend: donutLegend,
      hasData: donutValues.length > 0,
    },
    trend: {
      labels: trendPoints.map((p) => p.label),
      values: trendPoints.map((p) => p.kwh),
      hasData: trendHasData,
      points: trendPoints,
    },
    tableRows,
    matchedBill,
  };
}

/** Generate standard CSV export content for the selected month's analytics */
export function generateAnalyticsCsv(data: PersonalAnalyticsData): string {
  const rows: (string | number)[][] = [
    ["SmartWatts - Energy Analytics Report"],
    ["Reporting Month", data.monthLabel],
    ["Period Key", data.selectedMonth],
    ["Generated At", new Date().toISOString()],
    ["Data Basis", data.totalUsage.foot],
    [],
    ["Metric", "Value", "Unit", "Note"],
    [
      "Total Usage",
      data.totalUsage.kwh != null ? data.totalUsage.kwh.toFixed(2) : "N/A",
      "kWh",
      data.totalUsage.foot,
    ],
    [
      "Estimated / Billed Cost",
      data.estimatedCost.amountPesos != null ? data.estimatedCost.amountPesos.toFixed(2) : "N/A",
      "PHP",
      data.estimatedCost.foot,
    ],
    [
      "Largest Consumer",
      `"${data.largestConsumer.name.replace(/"/g, '""')}"`,
      data.largestConsumer.displayPercent,
      data.largestConsumer.foot,
    ],
    [
      "Month-over-Month Change",
      data.comparedToLastMonth.displayText,
      data.comparedToLastMonth.trendText,
      data.comparedToLastMonth.foot,
    ],
    [],
    ["Device / Appliance", "Category", "Usage (kWh)", "Share of Total (%)", "Basis"],
    ...data.tableRows.map((r) => [
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.category}"`,
      r.kwh.toFixed(2),
      `"${r.percent.toFixed(1)}%"`,
      `"${r.basis}"`,
    ]),
    [],
  ];

  if (data.matchedBill) {
    const b = data.matchedBill;
    rows.push(
      ["Saved Bill Period", "Consumption (kWh)", "Bill Amount (PHP)", "Source"],
      [
        `"${b.periodStart} to ${b.periodEnd}"`,
        Number(b.kwh).toFixed(2),
        (b.amountCentavos / 100).toFixed(2),
        b.source === "ocr" ? "Reviewed OCR" : "Manual entry",
      ],
      [],
    );
  }

  rows.push([
    "Privacy & Accuracy Notice",
    "SmartWatts does not connect to meters or IoT hardware. All estimates are calculated from user schedules or sample profiles.",
  ]);

  return rows.map((r) => r.join(",")).join("\r\n");
}
