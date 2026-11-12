import { defineConfig, devices } from "@playwright/test";

// NFC Tap-to-Dashboard browser tests: real Firebase Auth (emulator, "demo-" project) + Vite.
// The Rentals API is stubbed per test from the signed-in emulator UID; backend authorization for the
// same contract is covered by backend/tests/test_nfc_entry.py.
// Run with: npm run test:e2e:nfc (starts the Auth emulator first; no Java/Firestore needed).
const authPort = process.env.NFC_E2E_AUTH_PORT ?? "9099";

export default defineConfig({
  testDir: "./e2e-nfc",
  timeout: 60_000,
  workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5181" },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5181 --strictPort",
    url: "http://127.0.0.1:5181",
    env: {
      VITE_USE_FIREBASE_EMULATORS: "true", VITE_FIREBASE_PROJECT_ID: "demo-smartwatts",
      VITE_FIREBASE_EMULATOR_HOST: "127.0.0.1", VITE_FIREBASE_AUTH_EMULATOR_PORT: authPort,
      VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_AUTH_DOMAIN: "", VITE_FIREBASE_APP_ID: "", VITE_MAPBOX_ACCESS_TOKEN: "",
      // Nothing must reach a real backend from these tests.
      SMARTWATTS_API_PROXY: "http://127.0.0.1:9",
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
