# SmartWatts — Household Electricity Savings Platform for Filipino Families

Hardware-free web app (PWA) that helps Meralco households see **what to change** to lower their bill.
It implements the 20-step *SmartWatts Energy Workflow Flowchart* (Kuryentech proposal).

| Flow | Route |
|---|---|
| 1 Open · 2 Language | `/`, `/language` |
| 3 Scan/upload or manual bill · 4–5 Review/confirm (Yes/No loop) · 6 Save | `/bill`, `/bill/review` |
| 7–8 Add appliance (+ label scan) · 9–10 Review/validate (Yes/No) · 11 Save | `/appliances`, `/appliances/new` |
| 12–13 What-If simulator · 15 Try another? · 16 Save plan | `/simulator` |
| 14 Energy Advisor (EN / Filipino / Taglish) | `/advisor` |
| 17 Trends (monthly/quarterly/yearly/seasonal) | `/analytics` |
| 18 Manage/compare/recalculate plans | `/plans` |
| 19 Advanced features (informational) · 20 Continue | `/more` |

Engineering checklist: [`PROJECT.md`](PROJECT.md) · current status per step: [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

## Architecture
- **frontend/** React 19 + TypeScript + Vite 8, Tailwind v4 + shadcn-style components, Recharts, vite-plugin-pwa.
  - `src/lib/energy.ts` — deterministic calculator (works offline). Spec shared with backend: `spec/calc-cases.json`.
  - Storage: **Firestore + Anonymous Auth + persistent IndexedDB cache** when `VITE_FIREBASE_*` is set (`firestore.rules` restricts data to `users/{uid}`); otherwise a **local-only mode** (browser storage, clearly labeled, no fake sync).
- **backend/** FastAPI: `/api/ocr/bill`, `/api/ocr/label` (Tesseract; images processed in memory, only confirmed-needed numbers returned), `/api/advisor/chat` (Gemini with a calculator tool; figures not matching computed numbers are flagged), `/api/calc/compare`, `/api/health`. CORS allow-list, upload type/size/pixel limits, per-IP rate limiting.

Rates are never silently assumed: the user picks the effective rate from their bill (total ÷ kWh), a rate they enter (with month), the proposal's labeled reference ₱12.43/kWh (DOE PH average, June 2026), or none (kWh only).

## Configuration (one root `.env`)
All configuration lives in **`SmartWatts/.env`** (git-ignored). `SmartWatts/.env.example` is the committed template with safe placeholders.
```bash
cp .env.example .env        # then edit .env; never commit it
```
- **Frontend (Vite)** reads it through `envDir` = repo root (`frontend/vite.config.ts`). Only `VITE_*` variables reach the browser.
- **Backend (FastAPI)** loads it by absolute path (`backend/app/config.py`), so the working directory doesn't matter. Variables already set in the process environment (shell, CI, host) take precedence.
- Template placeholders (`replace_with_…`) and empty values both count as **unset**.

| Variable | Used by | Required? | If missing |
|---|---|---|---|
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | Browser (Firebase web config — public identifiers) | All four or none | None → **local-only mode** (data stays in this browser, labeled in the UI). Partial → dev/build **fails** naming the missing keys |
| `VITE_API_BASE_URL` | Browser → API | No (default `/api`) | Must end with `/api`; production: `https://<backend>/api` |
| `SMARTWATTS_API_TARGET` | Vite dev/preview proxy (Node only) | No | `http://127.0.0.1:8000` |
| `GEMINI_API_KEY` | **Backend only — secret** | For the Energy Advisor | Advisor returns `503 ai_unavailable`; everything else works |
| `GEMINI_MODEL` | Backend | No | `gemini-2.5-flash` |
| `CORS_ORIGINS` | Backend | No | localhost:5173/4173; explicit origins only, no `*`, no paths |
| `MAX_UPLOAD_BYTES`, `OCR_RATE_PER_MINUTE`, `ADVISOR_RATE_PER_MINUTE`, `AI_TIMEOUT_SECONDS` | Backend | No | 8 MB, 20, 15, 25 s. Invalid values stop startup with a message naming the variable |

Safety checks built in:
- Any `VITE_*` name that looks like a secret (e.g. `VITE_GEMINI_API_KEY`) fails the build.
- `npm run check:secrets` scans `frontend/dist` for server secret values, the `GEMINI_API_KEY` name, private keys and unexpected Google API keys. It prints findings, never values.
- Startup logs say what is enabled or disabled and never print secret values.
- Firebase `storageBucket` and `messagingSenderId` are intentionally **not** used: the app uses neither Firebase Storage nor Cloud Messaging.

## Run locally
Prereqs: Node 20+, Python 3.11+, `brew install tesseract`.
```bash
cp .env.example .env                       # once, at the repo root; fill in what you have
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --port 8000 # reads ../.env automatically

cd ../frontend && npm install
npm run dev                                # http://localhost:5173 (proxies /api -> :8000)
```

## Tests
```bash
cd backend && .venv/bin/python -m pytest -q   # calculator spec, OCR (real Tesseract), API, advisor, config loading
cd frontend && npm run verify                 # typecheck + lint + unit/integration + build + bundle secret scan
npx playwright install chromium && npm run e2e
```
E2E always builds with Firebase and `GEMINI_API_KEY` blanked through the process environment. That keeps it deterministic, writes nothing to a real Firestore, and makes no paid AI calls, whatever your `.env` contains.

## Demo script
Start → English → upload `frontend/e2e/fixtures/sample-bill.png` → check values → choose a rate → Yes, save →
Add appliance: Electric fan, 65 W (or scan `fan-label.jpg`), 8 h/day, 30 days → Yes, save list →
Simulator: change to 6 h → **3.9 kWh / ₱48.48** at ₱12.43 → No, save plan → refresh → plan still there → Trends.

## Firebase setup (to enable cloud mode)
1. Create a Firebase project → add a Web app → copy `apiKey`, `authDomain`, `projectId`, `appId` into the root `.env` (`VITE_FIREBASE_*`).
2. Authentication → Sign-in method → enable **Anonymous** (and **Google** for account linking; add your domain to Authorized domains).
3. Firestore → create database → deploy rules: `npx firebase-tools deploy --only firestore:rules`.
4. Restart `npm run dev` (the terminal shows `[smartwatts env] storage mode: firestore`). Settings shows "Your private cloud space" when active.

## Deployment (prepared, not deployed)
- Frontend: Vercel (`frontend/vercel.json`, SPA rewrites). In the Vercel project settings, set `VITE_FIREBASE_*` and `VITE_API_BASE_URL=https://<backend>/api`; **never** add `GEMINI_API_KEY` to the frontend project.
- Backend: any host with Python + the `tesseract` binary; set `GEMINI_API_KEY` as a host secret and `CORS_ORIGINS` to the deployed frontend origin.

## Known limitations
- Advisor needs `GEMINI_API_KEY`; without it the app shows an honest "not available" state.
- Firestore mode needs a Firebase project (Anonymous Auth enabled, rules deployed). Account linking uses Google sign-in.
- First visit while offline in Firestore mode falls back to local storage for that session.
- Weather insights, tenant/landlord and business tiers are proposals only (no prices, no payments).
