# NFC demo data (Owner + Tenant) — emulator only

Fixture: `fixtures/smartwatts_nfc_demo_data.json` (synthetic; labelled "Demo Data" in the UI).
Seeder: `scripts/seed_demo_data.py` → `backend/app/rentals/demo_seed.py` (writes only through `RentalService`).

## One command (local demo)
```bash
npm run demo:emulator        # emulators (auth 9399, firestore 8380) + seed + API :8021 + web :5190
# open http://127.0.0.1:5190/nfc and sign in as one of the fixture emails
# emulator password: smartwatts-demo-emulator (or $DEMO_EMULATOR_PASSWORD) — accepted only by the local emulator
```
Requires Java (`brew install openjdk@21`). Emulator data is discarded on exit; the next start re-seeds.

## Manual
```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9399
backend/.venv/bin/python scripts/seed_demo_data.py --project demo-smartwatts --create-emulator-accounts   # dry run
backend/.venv/bin/python scripts/seed_demo_data.py --project demo-smartwatts --create-emulator-accounts --apply
backend/.venv/bin/python scripts/seed_demo_data.py --project demo-smartwatts --rollback                  # fixture records only
```
Optional `--expect-uid owner=<uid>` fails unless the account resolves to that UID (also used as the UID on creation).

## What gets created
1 property, 2 units (101 occupied via accepted invitation, 102 vacant), 2 individual meters + assignments,
8 readings, 6 utility bills (the fixture's 3 property bills split per meter; per-period sums equal the fixture),
3 published statements for Unit 101, an active subscription via `request` → `administrative_grant` (actor
`demo-seed-operator`, 30 days). No custom claims, no email delivery (outbox sandboxed, `EMAIL_DELIVERY=disabled`).

## Guarantees / refusals
- Refuses non-`demo-` projects and non-local emulator hosts; production seeding is not supported.
- Re-running a complete seed is a no-op; an incomplete seed must be rolled back first.
- Rollback refuses if non-fixture members joined the demo property.

Tests: `npm run test:backend` (backend/tests/test_demo_seed.py), `npm run test:e2e:demo`.
