import { defineConfig, devices } from "@playwright/test";

// Full-stack SmartWatts Rentals test: browser -> Vite -> FastAPI -> Firebase emulators.
// Run with: npm run test:e2e:rentals (starts the Auth and Firestore emulators first).
// Ports default to firebase.json; override with RENTALS_E2E_AUTH_PORT / RENTALS_E2E_FIRESTORE_PORT
// (e.g. when another emulator already holds 8080) together with a matching emulator config.
const authPort = process.env.RENTALS_E2E_AUTH_PORT ?? "9099";
const firestorePort = process.env.RENTALS_E2E_FIRESTORE_PORT ?? "8080";
const emulatorEnv = {
  FIREBASE_PROJECT_ID: "demo-smartwatts",
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
  GCLOUD_PROJECT: "demo-smartwatts",
  // Never call a real AI provider from tests (the backend also loads .env): the assistant answers deterministically.
  GEMINI_API_KEY: "",
};

export default defineConfig({
  testDir: "./e2e-emulator",
  timeout: 120_000,
  workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5174" },
  webServer: [
    {
      command: "backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8001",
      url: "http://127.0.0.1:8001/api/health",
      env: emulatorEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npx vite --host 127.0.0.1 --port 5174 --strictPort",
      url: "http://127.0.0.1:5174",
      // Emulator mode with a demo project; blank out any real project config from .env.
      env: {
        VITE_USE_FIREBASE_EMULATORS: "true", SMARTWATTS_API_PROXY: "http://127.0.0.1:8001",
        VITE_FIREBASE_EMULATOR_HOST: "127.0.0.1", VITE_FIREBASE_AUTH_EMULATOR_PORT: authPort, VITE_FIREBASE_FIRESTORE_EMULATOR_PORT: firestorePort,
        VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_AUTH_DOMAIN: "", VITE_FIREBASE_PROJECT_ID: "demo-smartwatts", VITE_FIREBASE_APP_ID: "", VITE_MAPBOX_ACCESS_TOKEN: "",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
