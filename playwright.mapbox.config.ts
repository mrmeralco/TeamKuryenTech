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
    // Keep the Mapbox token from .env, but run in demo mode (no real Firebase project).
    env: { VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_AUTH_DOMAIN: "", VITE_FIREBASE_PROJECT_ID: "", VITE_FIREBASE_APP_ID: "" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
