# SmartWatts — Firebase setup, data model, and deployment runbook

**Project:** `smartwatts-266cc` — treated as **production** until proven otherwise.
**Status (2026-11-12):** nothing has been deployed or read from this project by the agent; no Firebase login or service credential was available. Everything below is verified locally in the Firebase Emulator Suite only.

## 1. Who reads and writes what

| Path | Written by | Read by | Enforced by |
|---|---|---|---|
| `users/{uid}` (profile: `preferredLanguage`, `displayName`) | Browser (owner only) | Owner only | `firestore.rules` |
| `users/{uid}/appliances/{id}` | Browser (owner only) | Owner only | `firestore.rules` |
| `users/{uid}/bills/{id}` | Browser (owner only) | Owner only | `firestore.rules` |
| `users/{uid}/savingsPlans/{id}` | Browser (owner only) | Owner only | `firestore.rules` |
| `users/{uid}/readings/{id}` | Browser (owner only) | Owner only | `firestore.rules` |
| `properties/{pid}` and its subcollections | FastAPI (Admin SDK) only | FastAPI only | `backend/app/rentals/service.py` |
| `memberships/{pid}_{uid}` | FastAPI only | FastAPI only | service |
| `subscriptions/{pid}` | FastAPI only (staff claim to activate) | FastAPI only | service |
| `invitations/{sha256(token)}` | FastAPI only | FastAPI only | service |

Property subcollections: `units`, `meters`, `meterAssignments`, `meterReadings`, `utilityBills`, `allocationAgreements`, `statements`, `billingRuns`, `occupancies`, `auditLogs`.

Browsers have **no** direct access to any rental collection (catch-all deny). The Admin SDK bypasses rules, so every rental request is authorized in `RentalService` (identity → membership → role → subscription entitlement). Landlords cannot reach `users/{uid}/**` through either path.

Firestore creates collections when the first document is written; no placeholder documents are needed or created.

## 2. Differences from the reference architecture (kept on purpose)

| Reference | Actual | Why it was not renamed |
|---|---|---|
| `users/{uid}/personalBills` | `users/{uid}/bills` | Already implemented, tested, and used by the UI. |
| `users/{uid}/usageRecords` | `users/{uid}/readings` | Pre-existing path from the original app. |
| `users/{uid}/savingsScenarios` | not stored | Simulations are computed on demand; only saved plans persist. |
| `properties/{pid}/members/{uid}` | `memberships/{pid}_{uid}` (top level) | "Which properties am I in?" is a single-field query; no collection-group index needed. |
| `properties/{pid}/invitations` | `invitations/{tokenHash}` (top level) | A tenant redeems a token before knowing the property. |
| `properties/{pid}/auditEvents` | `properties/{pid}/auditLogs` | Naming only. Subscription changes are audited here too (no separate `subscriptionEvents`). |
| `subscriptions/{subscriptionId}` | `subscriptions/{propertyId}` | Exactly one subscription per property. |

Not stored yet (optional additions, no code depends on them): property `status`, meter `status`, an itemized charge breakdown on **rental** utility bills (personal bills have one), user `email`/account status in the profile (available from Firebase Auth; not duplicated).

## 3. Indexes

Every query is equality-only with no ordering or range filter (`backend/app/rentals/store.py`), and the browser reads whole per-user subcollections. Firestore's automatic single-field indexes serve all of them, so `firestore.indexes.json` is intentionally empty.

**Caution before deploying indexes:** if the live project already has composite indexes, deploying an empty file makes the CLI offer to delete them. Run `npx firebase firestore:indexes --project smartwatts-266cc` first and merge anything that exists into `firestore.indexes.json`. Never pass `--force`.

## 4. Migration

No migration is prepared because the live database could not be inspected. The new rules affect existing data as follows:
- `users/{uid}/readings` — same path as before; documents may now only contain `kwh` and `createdAt` (unchanged from the old rules' intent).
- Any other pre-existing client-readable collection would become unreadable from browsers (catch-all deny) — the previous rules already denied everything except `readings`.
If inspection finds other collections with real data, stop and design a migration before deploying rules.

## 5. One-time setup (requires you)

1. `npx firebase login` (interactive; the agent cannot do this for you).
2. `bash scripts/firebase-inspect.sh` — read-only: confirms access, lists apps, database ID/region, existing indexes, and dry-runs the deployment.
3. In the console, check Authentication → Sign-in method: enable **Anonymous**, **Email/Password**, and **Google** if they are not already.
4. Web app config → `.env` (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID=smartwatts-266cc`, `VITE_FIREBASE_APP_ID`). `npx firebase apps:sdkconfig web --project smartwatts-266cc` prints these.
5. Backend: set `FIREBASE_PROJECT_ID=smartwatts-266cc` and provide a service account through `GOOGLE_APPLICATION_CREDENTIALS` (a file path outside the repo; `*.service-account.json` is git-ignored). Roles needed: Firebase Authentication Admin (verify tokens), Cloud Datastore User (Firestore), and Storage Object Admin only if bill documents are stored.
6. Staff activation uses the custom claim `platformAdmin: true`, set with the Admin SDK for specific staff accounts.

## 6. Production deployment (needs explicit approval each time)

```bash
# 1. See what is deployed now and validate without changing anything
bash scripts/firebase-inspect.sh
# 2. Deploy ONLY rules and indexes (and storage rules if a bucket exists)
npx firebase deploy --only firestore:rules,firestore:indexes,storage --project smartwatts-266cc
```

Effects: replaces Firestore rules (takes effect within about a minute for all clients), replaces Storage rules with deny-all, makes no data changes. Rollback: Firestore → Rules → history in the console lets you restore the previous release.

There is no separate development or staging Firebase project. Creating one (for example `smartwatts-dev`) is recommended so deployments can be rehearsed away from production.

## 7. Tests (emulator, project id `demo-smartwatts`)

```bash
npm run test:rules             # Firestore + Storage rules, allowed and denied cases
npm run test:backend           # authorization, entitlements, billing
npm run test:backend:emulator  # real Firestore store implementation
npm run test:e2e:rentals       # browser → API → emulators, owner and tenant
```
