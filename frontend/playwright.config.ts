import { defineConfig, devices } from '@playwright/test'

// Runs against a production build (vite preview) + the real FastAPI backend with real Tesseract OCR.
// Process env overrides the root .env in both Vite and FastAPI, so these runs are deterministic whatever
// the developer's .env contains: Firebase is blanked (local-only storage, no real cloud writes) and
// GEMINI_API_KEY is blanked so the honest "AI unavailable" path is exercised and no paid API is called.
const LOCAL_ONLY_ENV = 'VITE_FIREBASE_API_KEY= VITE_FIREBASE_AUTH_DOMAIN= VITE_FIREBASE_PROJECT_ID= VITE_FIREBASE_APP_ID= VITE_API_BASE_URL=/api'
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'cd ../backend && GEMINI_API_KEY= .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000',
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `${LOCAL_ONLY_ENV} npx vite build --logLevel warn && ${LOCAL_ONLY_ENV} npx vite preview --host 127.0.0.1 --port 4173 --strictPort`,
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
