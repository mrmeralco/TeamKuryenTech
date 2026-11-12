# SmartWatts (Team KuryenTech) — Project Implementation Guide

> **Status:** Hackathon implementation specification, not proof of completed functionality.  
> **Last updated:** November 12, 2026  
> **Primary challenge:** Know Your Bill, Manage Your Usage (Challenge 2)  
> **Secondary inspiration:** Grid Intelligence from Connected Devices (Challenge 3); **no real-time grid or device monitoring is claimed**.  
> **GitHub repository:** https://github.com/mrmeralco/TeamKuryenTech.git  
> **Expected local working directory:** `~/Desktop/SmartWatts` (verify before use)

## 0. Instructions for the implementation agent

**Read this file after the one-shot SmartWatts implementation prompt and before modifying source code.** Follow the original user-journey flowchart and the Kuryentech proposal. This document is a persistent handoff and acceptance guide, not a command to rebuild a working project from scratch.

1. Locate the existing SmartWatts project on the Mac Desktop. Do not assume its path exists; verify it. If a different directory name contains the existing application, use that directory.
2. Locate the source references in `~/Downloads` or preferably `docs/references/` if copies have been placed in the repository:
   - `SmartWatts Energy Workflow Flowchart.png` — updated 20-step process; primary **user journey** reference.
   - `KURYENTECH_PROPOSAL.pdf` — product problem, household audience, assumptions, limits, bill OCR, simulator, and grounded advisor.
   - `Workflow.jpeg` — original seven-step household narrative.
   - `Additional_KURYENTECH_PROPOSAL.png` — customer tiers, translation, analytics, offline ideas; mostly proposed expansions.
   - `Reference-Flowchart.jpeg` — visual diagram style only; its purchasing-order subject is unrelated to this app.
3. Inspect the repository: source, configuration, routes, installed libraries, uncommitted changes, storage, tests, and available credentials **without printing secrets**.
4. Match the existing modules to the 20 flowchart activities. Mark each **complete, partial, missing, blocked, or deferred**. Preserve code that already works.
5. Establish baseline build, lint, typecheck, and tests; then implement in dependency order; fix root causes and rerun tests.
6. Respect the distinctions **proposed vs. implemented**, **estimated vs. measured**, **offline vs. network-dependent**, and **verified vs. assumed**.
7. Work autonomously on safe local changes. Do not push, overwrite remote branches, deploy, or perform destructive operations without the appropriate authorization.

### Source-of-truth priority

1. Updated SmartWatts flowchart for intended navigation and branching.
2. Kuryentech PDF for household-focused problem, key claims, and safeguards.
3. Original workflow image for the seven-step demo story.
4. Supplementary image for ideas about audiences, tiers, languages, analytics, and offline use.
5. Existing source code for actual implemented behavior and reusable architecture.
6. One-shot prompt plus this guide for implementation detail.

If sources conflict, document the exact conflict and take the smallest safe implementation approach, preserving the core household flow. Do not silently convert a speculative feature into a completed feature.

## 1. Product definition

**SmartWatts** is a mobile-friendly web application for Filipino households that turns information from an electricity bill and user-entered appliance habits into understandable **estimated** energy savings. A user can access it without creating a conventional account, scan or enter a Meralco bill, add appliances, try a usage change, obtain explained estimates, receive contextual AI advice, and save plans.

**Audience:** Ordinary Meralco-served households, including families, students, and workers. Tenant/landlord and business scenarios are **future** extensions unless already implemented and validated.

**Core constraint:** SmartWatts does not measure individual appliance consumption, read a live utility meter, or have access to a public Meralco customer-usage API. Neither a photo of a bill nor an appliance's rating label establishes actual historical consumption per appliance. Never invent readings or guarantee a lower future bill.

### Representative demo

A parent has a **sample** ₱3,500 bill showing **sample** 280 kWh. They add a 65 W fan used 8 hours daily for 30 days, then ask what happens at 6 hours. Baseline **15.6 kWh**, scenario **11.7 kWh**, difference **3.9 kWh**. Using an explicitly **illustrative** ₱12.43/kWh rate yields **₱48.48 estimated savings**. Do not label this fixture as today's Meralco tariff.

## 2. Scope and delivery priorities

| Priority | Module | Definition of done |
|---|---|---|
| **P0** | Guest entry, language preference | Works on mobile and desktop; English/Filipino; no mandatory signup |
| **P0** | Bill manual entry and confirmation | Validates total, kWh, billing period; user can correct values |
| **P0** | Appliance registration | Add/edit/delete; name, rated watts, quantity, hours/day, days/period |
| **P0** | Deterministic savings engine | Correct unit-tested kWh and PHP calculations, assumptions displayed |
| **P0** | What-if simulator | Compare baseline/scenario without silently changing baseline |
| **P0** | Saved plans | Saved records remain after refresh; edit/delete works |
| **P0** | Privacy/error handling | No personal information needlessly retained; usable recovery states |
| **P1** | Bill and label OCR | Successful sample scans plus manual fallback and verification |
| **P1** | Grounded AI advice | Uses confirmed user data; calculator computes numeric figures |
| **P1** | Analytics | Real user history only; month/quarter/year; no fabricated data |
| **P1** | PWA and offline support | Cached app and local calculations; clear network-dependent failures |
| **P1** | Automated browser QA | End-to-end household workflow on desktop and mobile viewport |
| **P2** | Tenant/landlord and business | Permissions, verified inputs, multi-unit isolation |
| **P2** | Subscription billing | Real provider integration only after architecture/security work |
| **P2** | Seasonal/weather analytics | Sufficient real history, trustworthy source, careful interpretation |

**Hackathon release gate:** deliver a complete reliable P0 story before enhancing P1 or P2.

## 3. Intended technology choices

**Prefer existing working choices in the repository.** If starting from an empty project, use:

- **Frontend:** React, TypeScript, Vite, React Router.
- **UI:** Tailwind CSS and shadcn/ui; responsive, accessible, straightforward forms.
- **Form validation:** React Hook Form + Zod.
- **Charts:** Recharts.
- **Translations:** i18next/react-i18next with English and Filipino resources; chatbot can interpret Taglish.
- **Cloud state and guest identity:** Firebase Cloud Firestore + Firebase Anonymous Authentication.
- **Offline persistence:** Firestore persistent local cache (IndexedDB internally), where supported. Do **not** add a second Dexie store without a specific documented reason.
- **Core calculations:** pure TypeScript functions, independently unit tested, available without internet.
- **Backend:** Python FastAPI + Pydantic for image processing and grounded LLM access.
- **OCR:** Tesseract + image preprocessing (Pillow), subject to real-bill accuracy testing; **always** include manual input.
- **AI:** Gemini or another configured provider through the backend only; do not embed secrets in client code.
- **PWA:** vite-plugin-pwa / Workbox.
- **QA:** Vitest, React Testing Library, Pytest, Playwright.
- **Hosting:** established existing provider; Vercel for frontend and a compatible Python backend if no deployment target exists.

**Cost awareness:** source libraries may be free, but OCR hosting, cloud quotas, and AI API usage are not guaranteed to be free.

### Firebase constraints

- Anonymous sign-in is an account-free UX, **not** a transferable cross-device account. Support an upgrade/linking path before advertising cross-device account recovery.
- Firestore Security Rules must restrict reads/writes to the correct authenticated user or household membership; deny by default.
- Client `uid` or household IDs alone are not authorization. Validate membership or ownership in rules.
- Configure and test Firestore offline persistence. A browser can evict cached data and anonymous identity can be lost after local data clearing.
- Offline writes may queue and sync when online; handle conflicts and pending states honestly.
- Do not cache raw bill photographs or personal billing identifiers in Firestore. Delete temporary image data after extraction.
- For an unconfigured Firebase project, report the blocker; maintain a genuine usable local demo, without claiming cloud sync works.

## 4. Full user flow mapped to the image (20 steps)

### Swimlane 01 — User onboarding and bill setup

1. **Open SmartWatts:** Show clear start / resume, mobile-first PWA; no mandatory conventional registration.
2. **Choose language:** English or Filipino selection, persisted between visits.
3. **Take a picture of Meralco bill:** Capture/upload image **or enter values manually**; preview, size/type validation.
4. **Review & confirm bill details:** OCR proposes billing period, amount, kWh and identifiable charges; user checks every field.
5. **Decision — Are bill details correct?** **No:** edit or retake photo, return to review; **Yes:** proceed.
6. **Save bill data:** Store necessary confirmed fields, avoid name/address/account number; dispose of temporary image; prevent duplicates.

### Swimlane 02 — Appliance and usage setup

7. **Add appliances:** Fan, air conditioner, fridge, TV or custom; watts and quantity. Rating-label OCR optional, with explicit confirmation.
8. **Set usage pattern:** Hours per day, days in billing period. Variable-wattage appliance estimates are especially uncertain.
9. **Review appliance list:** Show all confirmed entries; edit, delete, add.
10. **Decision — Is information complete and correct?** **No:** return to editing; **Yes:** proceed.
11. **Save appliance data:** Persist records with stable IDs; recalculate dependent estimates when changed.

### Swimlane 03 — Savings simulation and advice

12. **Run What-if simulator:** User chooses appliance, modifies hours or days; original baseline stays intact.
13. **View results:** Show baseline kWh, scenario kWh, kWh difference, illustrative PHP change when a confirmed applicable rate exists, and stated assumptions. Higher use is an increase, not a saving.
14. **Ask Energy Advisor:** Ground response in confirmed bill/appliance/scenario data. Numerical results come from deterministic code, not an LLM guess. Explain missing information and service outages.
15. **Decision — Try another scenario?** **Yes:** return to Step 12; **No:** continue.
16. **Save plan:** Preserve inputs, period, assumptions, rate source, calculation, timestamp; support edits and deletion.

### Swimlane 04 — Track, analytics, and more

17. **View electricity trends:** Display monthly/quarterly/yearly summaries **only when enough real billing records exist**. Label saved scenario projections separately. Seasonal/weather features are optional extensions.
18. **Manage saved plans:** View, revise, remove and compare saved scenarios.
19. **Decision — Want advanced features?** **Yes:** show clearly marked planned options for household, tenant/landlord and business tiers; **No:** continue. Do not represent plans/payment as active if not integrated.
20. **Continue using SmartWatts:** Resume household, add new bills, update appliances, rerun simulations; preserve data and surface any syncing limitations.

### Essential recovery paths

- Bill OCR unreadable -> retry or manual entry -> review again.
- Appliance wattage missing -> manual input -> validation -> review again.
- No valid rate -> show kWh estimate only or request a labeled rate; no fabricated peso estimate.
- AI unavailable -> present service error; keep calculator and saved plans working.
- Internet unavailable -> app shell/locally supported actions still work if cached; OCR/AI may not.
- Bad form submission -> focus first invalid field; retain valid inputs.
- Repeat clicks -> prevent duplicate bills, appliances, plans and requests.

## 5. Core data contract (conceptual)

Define typed schemas (Zod + Pydantic as needed), stable IDs and migrations. Recommended collections/entities:

| Entity | Key fields | Notes |
|---|---|---|
| `HouseholdProfile` | `id`, `ownerUid`, `language`, `createdAt` | Guest profile; no need for personal name/address |
| `ElectricityBill` | `id`, `householdId`, `periodStart`, `periodEnd`, `totalPhp`, `billedKwh`, `charges?`, `createdAt` | User-confirmed data, not raw image |
| `Appliance` | `id`, `householdId`, `name`, `category`, `ratedWatts`, `quantity`, `hoursPerDay`, `daysPerPeriod` | User-entered assumptions |
| `RateReference` | `id`, `phpPerKwh`, `source`, `rateMonth`, `rateType` | Distinguish published rate vs. bill-derived effective rate |
| `SavingsScenario` | `id`, `householdId`, `applianceId`, `baseline`, `proposed`, `rateReference`, `results`, `createdAt` | Frozen, reproducible what-if inputs |
| `SavingsPlan` | `id`, `householdId`, `scenarioIds`, `notes?`, `createdAt`, `updatedAt` | No fake confirmed savings |

Design Firestore paths and authorization policies to match the actual ownership model. Never use an unvalidated client-provided household ID to access another user's records.

## 6. Energy calculation rules

For **constant-power** appliances with explicit assumptions:

```text
estimatedKwh = ratedWatts * quantity * hoursPerDay * daysUsed / 1000
estimatedCostPhp = estimatedKwh * applicablePhpPerKwh
kwhDifference = baselineKwh - scenarioKwh
pesoDifference = kwhDifference * applicablePhpPerKwh
```

- Validate finite numeric inputs, positive watts/quantity, 0–24 daily hours, and appropriate period-length days.
- Use precise intermediate values and consistent display rounding; do not compound rounded intermediates.
- Display **estimated** use/savings; actual utility bills include varied charges and consumption behavior.
- Never assume an inverter AC or cycling refrigerator runs at its nameplate watts continuously.
- If the rate is unknown, calculate kWh only and show a helpful explanation.
- The **AI advisor must call or consume this engine's results** for peso and kWh claims.

**Required unit-test fixture:** 65 W × 8 h/day × 30 days = 15.6 kWh; 65 W × 6 × 30 = 11.7 kWh; savings = 3.9 kWh; at hypothetical ₱12.43/kWh = ₱48.48 displayed after rounding.

## 7. Backend boundaries and privacy

Suggested API operations (names are illustrative, adapt to existing architecture):

- `POST /api/ocr/bill` -> parsed candidate fields with confidence/uncertainty; do **not** persist the image.
- `POST /api/ocr/appliance` -> candidate watts/label information; optional P1.
- `POST /api/advisor` -> grounded response using validated bill, appliance and calculator output.
- Optional rate-reference endpoint only with a trustworthy maintained source.

Implement request size/type checks, timeouts, safe OCR temp files, CORS allowlist, credentials only in backend environment variables, non-sensitive logs, client-facing recovery errors, and reasonable abuse controls. Do not assert formal legal compliance without review.

## 8. Interface and navigation expectations

Use a functional, readable utility-product design instead of nonfunctional decorative UI. Views: Welcome, Language, Bill Entry, Bill Review, Appliances, Simulator, Results, Advisor, Plans, Analytics, Settings/Privacy, optional Future Tiers. Each button must work. Accessible labels, focus on invalid fields, clear loading/errors, mobile-first layouts, and no invented chart entries.

## 9. Implementation sequence / dependency gates

1. **Discovery:** audit repository, reference files, current Git state and baseline checks.
2. **Schemas:** define types, bill/appliance/plan schemas, validation and ownership boundaries.
3. **Core UX:** onboarding, language, bill manual entry and correction.
4. **Appliances:** full CRUD and usage validation.
5. **Calculator:** unit tests and scenarios before any LLM integration.
6. **Simulator:** compare baseline/scenario, rate/period explanation.
7. **Persistence:** Firebase Auth and Firestore with offline cache, security rules, CRUD, conflict handling.
8. **Plans and analytics:** local/confirmed history, empty states, edit/delete.
9. **OCR:** bill extraction tested with representative consented samples and reliable manual fallback.
10. **AI:** server-side provider integration and calculator-grounded answers with graceful degradation.
11. **PWA and localization:** offline app-shell checks, no fake AI/OCR offline claims.
12. **End-to-end QA:** browser tests, security review, mobile and deployed smoke tests.

At every gate, run focused tests and retain evidence. Do not replace a working app to satisfy a preferred folder structure.

## 10. Acceptance tests

### Calculation test

- Given a single 65 W fan, 8 h/day, 30 days and a hypothetical ₱12.43/kWh rate, changing to 6 h/day results in **3.9 kWh** and **₱48.48 estimated** saving.
- An increased-use scenario displays added cost, not savings.
- Unknown rate displays kWh difference without an unsupported peso amount.
- Zero and invalid inputs are handled deliberately.

### Full end-to-end demo

1. Start as guest; choose English or Filipino.
2. Enter a **sample** ₱3,500, 280 kWh bill manually or via OCR and confirm it.
3. Add a 65 W electric fan, quantity 1, 8 hours/day, 30 days.
4. Change scenario to 6 hours/day; verify displayed values and assumptions.
5. Ask chatbot a grounded question (or verify unavailable-service recovery).
6. Save the plan; reload; verify persistence and that calculations remain unchanged.
7. Open analytics: show actual existing records or honest first-bill empty state.
8. Edit an appliance, verify dependent results; delete a saved plan safely.
9. Test narrow mobile viewport, keyboard interaction, invalid form, no network and image upload failure.
10. Run build, typecheck, lint, unit tests, integration tests and Playwright flows; document failures accurately.

## 11. GitHub repository and safe source control workflow

**Canonical remote:** `https://github.com/mrmeralco/TeamKuryenTech.git`  
**Repository web page:** https://github.com/mrmeralco/TeamKuryenTech

The public GitHub page **appeared empty on November 12, 2026**. Re-check before any Git operations; do not assume the remote remains empty or that you have push authorization.

In the verified local project directory:

```bash
pwd
git status --short
git remote -v
git branch --show-current
```

If no Git repository exists, initialize **only after confirming this is the correct local SmartWatts source directory**. If `origin` is absent, add the supplied URL; if `origin` already points somewhere else, inspect and report rather than blindly overwriting it. Example:

```bash
git remote add origin https://github.com/mrmeralco/TeamKuryenTech.git
```

Do not run that command if `origin` already exists. Use the existing default branch; never force-push or reset a branch to fit this guide. If the remote contains work, fetch and reconcile safely with local uncommitted changes. Never create a second project copy unnecessarily.

### Never commit

- `.env`, `.env.local`, `.env.production` or actual secrets/tokens
- Firebase service-account JSON/private keys
- Gemini/API credentials
- Raw personal utility bills or account identifiers
- Temporary uploaded images or test fixtures containing personal information
- `node_modules`, build output, caches, virtual environments

Include `.env.example` with **placeholder names only** and a robust `.gitignore`. Firebase frontend configuration identifiers are not secret by themselves, but Firestore rules and access control still must be secure.

**No automatic push, deletion, history rewrite, or deployment** unless the user has explicitly approved the action and the tool has permission.

## 12. Handoff and final reporting

At completion, report a 20-step checklist with **COMPLETED / PARTIAL / BLOCKED / DEFERRED / FAILED**, source file paths, tests run, build output, and remaining limitations. Report any missing Firebase/OCR/AI credentials and precise setup instructions. Include working commands to run the app. Do not report success based only on compilation or screenshots.

**Definition of hackathon-ready:** a user can open the app, enter/confirm a bill, add a fan, compare 8 vs. 6 hours, see a reproducible calculation, save the result, reload and continue; OCR and AI are valuable enhancements but must not block the reliable household workflow.

---

## Follow-on instruction to agent

After reading `PROJECT.md`, resume the one-shot implementation prompt. Do the real repository inspection and build work. Use this document as the standing engineering checklist, updating completion states and documenting decisions as work proceeds. No placeholder claims; no fabricated live data; no unnecessary changes to working code.
