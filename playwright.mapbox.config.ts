import { defineConfig, devices } from "@playwright/test";

// Live Mapbox test: requires VITE_MAPBOX_ACCESS_TOKEN in .env and network access to api.mapbox.com.
// Run with: npm run test:e2e:mapbox
export default defineConfig({
  testDir: "./e2e-mapbox",
  timeout: 90_000,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5177" },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5177 --strictPort",
    url: "http://127.0.0.1:5177",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
