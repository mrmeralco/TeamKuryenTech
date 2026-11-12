import { defineConfig, devices } from "@playwright/test";

// Default e2e suite: local demo mode, no Firebase, and NO Mapbox token (tests the directory fallback).
// It always starts its own Vite server so a developer's .env token can't leak into these tests.
export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/auth.spec.ts",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5176" },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5176 --strictPort",
    url: "http://127.0.0.1:5176",
    // Blank Firebase config = local demo mode. These tests must never touch the real project in .env.
    env: { VITE_MAPBOX_ACCESS_TOKEN: "", VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_AUTH_DOMAIN: "", VITE_FIREBASE_PROJECT_ID: "", VITE_FIREBASE_APP_ID: "" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
