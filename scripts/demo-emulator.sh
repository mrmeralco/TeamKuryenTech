#!/usr/bin/env bash
# Local, isolated SmartWatts NFC demo: Firebase emulators (demo-smartwatts) + seeded fixture + API + dashboard.
# Nothing here touches a real Firebase project, sends email, or calls paid AI providers.
#   npm run demo:emulator          then open http://127.0.0.1:5190/nfc
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=demo-smartwatts
AUTH_PORT=9399 FS_PORT=8380 API_PORT=8021 WEB_PORT=5190
if ! command -v java >/dev/null 2>&1 && [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
  export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
fi
command -v java >/dev/null 2>&1 || { echo "Java is required for the Firestore emulator (brew install openjdk@21)."; exit 1; }

export FIRESTORE_EMULATOR_HOST="127.0.0.1:$FS_PORT" FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:$AUTH_PORT"
export GCLOUD_PROJECT=$PROJECT FIREBASE_PROJECT_ID=$PROJECT
# Real credentials from .env must never reach this environment; mail delivery is explicitly disabled.
export GOOGLE_APPLICATION_CREDENTIALS="" SMTP_USER="" SMTP_PASSWORD="" EMAIL_DELIVERY=disabled GEMINI_API_KEY=""

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

npx firebase emulators:start --config firebase.demo.json --only auth,firestore --project $PROJECT >/tmp/smartwatts-demo-emulators.log 2>&1 &
pids+=($!)
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$FS_PORT/" >/dev/null && curl -sf "http://127.0.0.1:$AUTH_PORT/" >/dev/null && break; sleep 1; done

backend/.venv/bin/python scripts/seed_demo_data.py --project $PROJECT --create-emulator-accounts --apply

backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port $API_PORT &
pids+=($!)
VITE_USE_FIREBASE_EMULATORS=true VITE_FIREBASE_PROJECT_ID=$PROJECT VITE_FIREBASE_EMULATOR_HOST=127.0.0.1 \
VITE_FIREBASE_AUTH_EMULATOR_PORT=$AUTH_PORT VITE_FIREBASE_FIRESTORE_EMULATOR_PORT=$FS_PORT \
VITE_FIREBASE_API_KEY="" VITE_FIREBASE_AUTH_DOMAIN="" VITE_FIREBASE_APP_ID="" VITE_MAPBOX_ACCESS_TOKEN="" \
SMARTWATTS_API_PROXY="http://127.0.0.1:$API_PORT" npx vite --host 127.0.0.1 --port $WEB_PORT --strictPort &
pids+=($!)
echo
echo "SmartWatts demo (EMULATOR ONLY) → http://127.0.0.1:$WEB_PORT/nfc   (Ctrl+C to stop; emulator data is discarded)"
wait
