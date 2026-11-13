# SmartWatts

SmartWatts is a responsive electricity dashboard with the classic SmartWatts UI and its interactive energy-saving game. The dashboard uses its original HTML, CSS, JavaScript, and Chart.js presentation; the multilingual AI chat is a React and TypeScript widget bundled by Vite.

## Requirements

- Node.js 20+
- Python 3.10+
- A Firebase project with Anonymous Authentication and Cloud Firestore enabled
- A Gemini API key configured only on the backend

## Configure Firebase, Gemini, and translations

1. Copy `.env.example` to `.env`.
2. Fill in the `VITE_FIREBASE_*` values from your Firebase web app.
3. Enable **Anonymous** sign-in in Firebase Authentication and create a Firestore database.
4. Deploy `firestore.rules` to the Firestore database.
5. Set `FIREBASE_PROJECT_ID` and configure Google Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS` for the FastAPI server. The backend verifies Firebase anonymous ID tokens before accepting chat requests.
6. Set `GEMINI_API_KEY` and, optionally, `GEMINI_MODEL` in the backend process environment. The Gemini key must not use a `VITE_` prefix or be placed in frontend code. Rotate any key previously pasted into chat.
7. Enable the Google Cloud Translation API and set `GOOGLE_TRANSLATE_API_KEY` in the backend environment. Restrict this key to the Translation API; it is used only by FastAPI and must never be exposed in frontend code.
8. For production, set `ALLOWED_ORIGINS` to the exact frontend origin(s).

Without Firebase settings the dashboard runs with sample data. Firestore guest accounts use per-user paths and Firestore's IndexedDB cache for offline reading access and writes.

## Run locally

In the project root:

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal (usually `http://localhost:5173`). Do not open the React source with `file://`.

To serve the app through XAMPP/Apache instead, run `npm run build` first, make sure Apache's `mod_rewrite` is enabled and `.htaccess` overrides are allowed, then open the project folder through XAMPP. The project `.htaccess` serves the production build from `dist`; if the build is missing, it shows setup instructions instead of a blank page.

In a second terminal from the project root, create and activate a Python environment, install backend requirements, and run FastAPI:

```powershell
python -m venv backend\.venv
.\backend\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
uvicorn app.main:app --app-dir backend --reload
```

The Vite development server proxies `/api` requests to FastAPI on `127.0.0.1:8000`. Once Firebase and Google Cloud Translation are configured, the language selector lists the languages supported by the Translation API; dashboard and chat text are translated on demand through the backend. English and Tagalog remain available as local options if the translation service is not configured. OCR runs in the browser using Tesseract.js; review extracted kWh values or enter them manually before saving.

## Checks

```powershell
npm test
npm run build
python -m pytest
npm run test:e2e
```

Playwright may require `npx playwright install chromium` on a new machine.

## Included features

- Dashboard, real-time/history views, analytics, device monitor, goals, rewards, billing, notifications, account, help, and about pages
- Recharts usage visualizations and deterministic TypeScript calculation helpers
- Firebase anonymous guest authentication, user-scoped Firestore readings, and IndexedDB offline cache
- Gemini chat through FastAPI; the API key remains server-side
- Browser OCR bill-entry flow with manual-entry fallback
- Installable PWA app shell with offline caching
- Five claimable energy challenges, Watts points, streaks, levels, and eight locally saved badges

Electricity usage, bills, appliance breakdowns, and challenges are sample/demo values unless explicitly saved by a signed-in guest. This is not an official utility service and does not process payments.

## Two-tier product (branch `feature/two-tier-business-model`)

- **Tier 1 — SmartWatts Personal (free forever):** bill upload with in-browser OCR, appliance inventory and label scanner, savings simulator with a deterministic billing engine, grounded AI advisor, consumption calendar.
- **Tier 2 — SmartWatts Rentals (proposed ₱299 per property per month, up to 10 units):** properties, units, QR/NFC tenant invitations, meters, readings, official bills, tenant statements. Tenants never pay SmartWatts. Online payment is not implemented; staff activate subscriptions manually.
- There is no Tier 3 and no IoT hardware.

Tenant billing workflows require legal and regulatory review before production use.

### Extra environment variables

| Variable | Purpose |
|---|---|
| `VITE_MAPBOX_ACCESS_TOKEN` | Optional public (`pk.*`) Mapbox token for the Business Center map. Restrict it to your domains. |
| `VITE_USE_FIREBASE_EMULATORS` | `true` to use the local Firebase emulators (tests). |
| `FIREBASE_STORAGE_BUCKET` | Optional bucket for rental bill documents (backend only). |
| `RENTALS_PRICE_CENTAVOS`, `RENTALS_UNIT_LIMIT`, `RENTALS_TRIAL_DAYS` | Rentals plan price, unit limit, and optional development trial (defaults 29900, 10, 0). |

### Checks

```bash
npm run typecheck          # TypeScript
npm test                   # frontend unit tests
npm run test:backend       # FastAPI tests
npm run build              # production build
npm run test:e2e           # browser tests, demo mode, no Mapbox token
# The next four need Java 11+ (Firebase emulators):
npm run test:rules
npm run test:backend:emulator
npm run test:e2e:rentals
npm run test:e2e:mapbox    # needs a real Mapbox token in .env
```

See `docs/BUSINESS_CENTERS.md` for the Business Center data source and refresh steps.
