import { defineConfig, devices } from "@playwright/test";

// Full-stack SmartWatts Rentals test: browser -> Vite -> FastAPI -> Firebase emulators.
// Run with: npm run test:e2e:rentals (starts the Auth and Firestore emulators first).
const emulatorEnv = {
  FIREBASE_PROJECT_ID: "demo-smartwatts",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  GCLOUD_PROJECT: "demo-smartwatts",
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
      env: { VITE_USE_FIREBASE_EMULATORS: "true", SMARTWATTS_API_PROXY: "http://127.0.0.1:8001", VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_AUTH_DOMAIN: "", VITE_FIREBASE_PROJECT_ID: "", VITE_FIREBASE_APP_ID: "" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
