import { defineConfig, devices } from "@playwright/test";

// NFC demo verification on the isolated emulator stack: browser → Vite → FastAPI → Firebase emulators
// (firebase.demo.json ports, "demo-" project). The fixture is seeded by scripts/seed_demo_data.py in
// globalSetup. Run with: npm run test:e2e:demo   (Java must be on PATH for the Firestore emulator).
const emulatorEnv = {
  FIREBASE_PROJECT_ID: "demo-smartwatts",
  GCLOUD_PROJECT: "demo-smartwatts",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8380",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399",
  // The backend also loads .env: blank real credentials and disable mail delivery explicitly.
  GOOGLE_APPLICATION_CREDENTIALS: "", SMTP_USER: "", SMTP_PASSWORD: "", EMAIL_DELIVERY: "disabled", GEMINI_API_KEY: "",
};

export default defineConfig({
  testDir: "./e2e-demo",
  timeout: 120_000,
  workers: 1,
  globalSetup: "./e2e-demo/global-setup.ts",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5190" },
  webServer: [
    {
      command: "backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8021",
      url: "http://127.0.0.1:8021/api/health",
      env: emulatorEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npx vite --host 127.0.0.1 --port 5190 --strictPort",
      url: "http://127.0.0.1:5190",
      env: {
        VITE_USE_FIREBASE_EMULATORS: "true", SMARTWATTS_API_PROXY: "http://127.0.0.1:8021",
        VITE_FIREBASE_EMULATOR_HOST: "127.0.0.1", VITE_FIREBASE_AUTH_EMULATOR_PORT: "9399", VITE_FIREBASE_FIRESTORE_EMULATOR_PORT: "8380",
        VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_AUTH_DOMAIN: "", VITE_FIREBASE_PROJECT_ID: "demo-smartwatts", VITE_FIREBASE_APP_ID: "", VITE_MAPBOX_ACCESS_TOKEN: "",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
