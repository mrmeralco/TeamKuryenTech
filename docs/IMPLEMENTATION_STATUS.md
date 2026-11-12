# SmartWatts — Implementation Status

Tracks `PROJECT.md` (the standing checklist; left unmodified) against the actual code.
Last verified: 2026-11-12. Statuses: COMPLETED = implemented **and** covered by passing tests.

## 20-step flowchart checklist

| # | Step | Status | Where | Evidence |
|---|---|---|---|---|
| 1 | Open SmartWatts (start/resume, guest) | COMPLETED | `pages/Welcome.tsx` | e2e journey (returning user), flow.test |
| 2 | Choose language (persisted) | COMPLETED | `pages/Language.tsx`, `i18n/`, `components/ProfileSync.tsx` | flow.test (FIL persists + profile), i18n.test |
| 3 | Photo/upload bill or manual | COMPLETED | `pages/BillCapture.tsx`, `backend/app/ocr.py` | e2e real Tesseract, type/size tests |
| 4 | Review & confirm (confidence, not-found hints) | COMPLETED | `pages/BillReview.tsx` | e2e, flow.test (low confidence, not found) |
| 5 | Decision: correct? No → edit/retake/manual | COMPLETED | `components/Decision.tsx`, `BillReview.tsx` | e2e, flow.test (focus first invalid) |
| 6 | Save bill (no PII, no image, no duplicates) | COMPLETED | `lib/data.tsx` (period dedupe), `main.py` | test_api PII test, flow.test |
| 7 | Add appliances (+ label OCR, confirm) | COMPLETED | `pages/ApplianceForm.tsx`, `/api/ocr/label` | e2e "Use 65 W" |
| 8 | Usage pattern (variable-power warning) | COMPLETED | `ApplianceForm.tsx`, `lib/validation.ts` | validation.test |
| 9 | Review appliance list (edit/delete/add) | COMPLETED | `pages/Appliances.tsx` | e2e manage test |
| 10 | Decision: complete & correct? | COMPLETED | `Appliances.tsx` | e2e, flow.test |
| 11 | Save appliance data (stable IDs) | COMPLETED | `lib/data.tsx` `confirmAppliances` | localRepo.test, e2e |
| 12 | What-if simulator (baseline untouched) | COMPLETED | `pages/Simulator.tsx`, `lib/energy.ts` | flow.test asserts stored baseline unchanged |
| 13 | View results (increase ≠ saving, no-rate → kWh only) | COMPLETED | `Simulator.tsx` | spec/calc-cases.json in both suites |
| 14 | Energy Advisor (grounded, calculator tool) | PARTIAL → BLOCKED live | `pages/Advisor.tsx`, `backend/app/advisor.py` | fake-provider tests pass; **live Gemini untested: no GEMINI_API_KEY** |
| 15 | Decision: another scenario? | COMPLETED | `Simulator.tsx` | flow.test (Yes resets) |
| 16 | Save plan (inputs, rate source, timestamp) | COMPLETED | `Simulator.tsx`, `lib/data.tsx` | e2e reload persistence |
| 17 | Trends (only real history) | COMPLETED (seasonal = calendar only) | `pages/Analytics.tsx`, `lib/analytics.ts` | analytics.test, e2e one-bill state |
| 18 | Manage plans (edit/delete/compare/recalc) | COMPLETED | `pages/Plans.tsx` | e2e manage test (8→10 h, recalc ₱96.95, delete) |
| 19 | Advanced features (informational) | COMPLETED as informational; tiers DEFERRED | `pages/More.tsx`, `config/tiers.ts` | e2e |
| 20 | Continue using SmartWatts | COMPLETED | Welcome resume, all CRUD | e2e |

## Cross-cutting

| Requirement | Status | Notes |
|---|---|---|
| Firestore + Anonymous Auth + offline cache | BLOCKED (verification) | Code in `lib/storage/firebase.ts`; no Firebase project config available. Local-only mode is used and labeled. |
| Firestore rules (owner-only, deny by default) | BLOCKED (verification) | `firestore.rules`; emulator needs Java (not installed). |
| Account upgrade (link Google) | BLOCKED (verification) | `Settings.tsx` → `linkWithPopup`; requires Firebase. |
| PWA / offline | COMPLETED | e2e offline test (SW reload, local calc, honest OCR/AI offline messages) |
| Keyboard / mobile viewport | COMPLETED | e2e manage test (keyboard), all e2e on Pixel 7 |
| Weather insights, tenant/landlord, business, payments | DEFERRED (P2) | Informational only, no prices |

## Decisions where PROJECT.md differs from the existing build

| PROJECT.md says | Built | Why |
|---|---|---|
| React Hook Form + Zod | Typed validators in `lib/validation.ts` | §3 "prefer existing working choices"; same rules, fully tested |
| i18next | Typed dictionary + `translate()` with EN fallback | Same; coverage test guarantees every FIL key |
| `/api/ocr/appliance`, `/api/advisor` | `/api/ocr/label`, `/api/advisor/chat` | §7 names are illustrative |
| Separate `SavingsScenario` + `SavingsPlan` (scenarioIds) | `Plan` freezes one scenario (baseline, proposed, rate, result, goal) | Flowchart step 16 saves one plan per scenario; all required fields preserved |
| `householdId` field on records | Ownership by path `users/{uid}/…` enforced in rules | §3/§5: client IDs are not authorization |
| Field names `totalPhp`, `billedKwh`, `ratedWatts` | `amountPhp`, `kwh`, `wattage` | Conceptual contract; renaming would churn working code |
