// Chart.js, bundled with the app instead of loaded from a CDN (strict CSP, pinned version).
// app.js uses the global `Chart`; module scripts run in document order, so this runs first.
import Chart from "chart.js/auto";

(window as unknown as { Chart: typeof Chart }).Chart = Chart;
