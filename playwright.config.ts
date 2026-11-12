import { defineConfig, devices } from "@playwright/test";

// Default e2e suite: local demo mode, no Firebase, and NO Mapbox token (tests the directory fallback).
// It always starts its own Vite server so a developer's .env token can't leak into these tests.
export default defineConfig({
  testDir: "./e2e",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5176" },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5176 --strictPort",
    url: "http://127.0.0.1:5176",
    env: { VITE_MAPBOX_ACCESS_TOKEN: "" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
