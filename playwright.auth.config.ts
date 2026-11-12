import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "auth.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5179" },
  webServer: {
    command: "npx vite --host localhost --port 5179 --strictPort",
    url: "http://localhost:5179",
    env: {
      VITE_USE_FIREBASE_EMULATORS: "true",
      VITE_FIREBASE_PROJECT_ID: "demo-smartwatts",
      VITE_FIREBASE_EMULATOR_HOST: "127.0.0.1",
      VITE_FIREBASE_AUTH_EMULATOR_PORT: "19099",
      VITE_FIREBASE_FIRESTORE_EMULATOR_PORT: "18080",
      VITE_FIREBASE_API_KEY: "",
      VITE_FIREBASE_AUTH_DOMAIN: "",
      VITE_FIREBASE_APP_ID: "",
      VITE_MAPBOX_ACCESS_TOKEN: "",
    },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
