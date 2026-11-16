# SmartWatts on Cloudflare

One public HTTPS origin serves the whole app: Cloudflare serves the website and forwards `/api/*` to the FastAPI
backend on Google Cloud Run. Firebase Authentication and Cloud Firestore (project `smartwatts-266cc`) stay as they are.

```text
 browser / NFC card ──► https://<public host>   (smartwatts.<sub>.workers.dev or a custom domain)
                              │
                     Cloudflare Worker  cloudflare/worker.js → cloudflare/app.js
                     ├── /, /login, /register, /forgot-password, /reset-password, /dashboard, /nfc
                     │       → Workers Static Assets (dist/), security headers, 120 page loads/min/IP
                     ├── every other file (JS, CSS, images, sw.js, manifest) → asset store directly (dist/_headers)
                     └── /api/*, /__t, /__v, /__c.js  → 240 calls/min/IP → HTTPS proxy
                              │   + x-smartwatts-proxy (shared secret), x-smartwatts-client-ip, x-smartwatts-host
                     FastAPI on Cloud Run (Dockerfile, asia-southeast1)
                     ├── refuses requests without the proxy secret (the *.run.app URL cannot skip the edge)
                     ├── Firebase ID-token verification, memberships, subscriptions, platform admin (unchanged)
                     └── Firestore + Firebase Auth Admin via the Cloud Run service account (no key files)
```

## Why not a Python Worker for the backend

Cloudflare Python Workers run on Pyodide (WebAssembly). The backend needs things Pyodide cannot provide:

- `firebase-admin` and `google-cloud-firestore` require **grpcio**, a native C extension
  (`grpc/_cython/cygrpc.*.so`). It is not a Pyodide package, so Firestore and the Admin SDK cannot load.
- The backend uses OS threads (`threading`, `asyncio.to_thread`, sync routes in a thread pool) and starts the email
  mailer as a Node subprocess (`backend/app/email_otp.py`).

Rewriting every Firestore call against the REST API would change the most security-sensitive code (memberships,
transactions, subscriptions) for no user benefit, so the backend runs unchanged on Cloud Run and Cloudflare is the
single public edge. The Worker contains no business logic and holds no Google credentials.

## Files

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Worker + Static Assets config; `development` (top level), `preview`, `production` environments |
| `cloudflare/worker.js`, `cloudflare/app.js` | Entry module and routing/proxy/cron logic |
| `cloudflare/security-headers.json` | Security headers (identical to `backend/app/security/headers.py`, enforced by a test) |
| `cloudflare/worker.test.ts` | Worker unit tests (`npm test`) |
| `scripts/cloudflare-build.mjs` | `npm run build:cloudflare`: production build with the Firebase config guard, then `cloudflare-assets.mjs` |
| `scripts/cloudflare-assets.mjs` | Writes `dist/_headers`, `dist/.assetsignore`; checks pages exist and Workers asset limits |
| `scripts/cloudflare-preflight.mjs` | Refuses to deploy an environment without a backend URL or a fresh guarded build |
| `scripts/cloudflare-local-check.mjs` | Full local stack: emulators → FastAPI (production mode) → `wrangler dev` → checks |
| `Dockerfile`, `.gcloudignore`, `.dockerignore` | Cloud Run image for the API only (no website, no secrets) |
| `.dev.vars.example` | Template for local Worker secrets (`.dev.vars` is git-ignored) |

Backend changes made for this deployment: `PROXY_SHARED_SECRET` (`backend/app/security/settings.py`,
`middleware.py`); public `/api/health`; durable state in Firestore in production (`backend/app/persistence.py`):
notification outbox, preferences and due-date reminder registry, email verification codes, verified-account
registry (previously process memory or a local JSON file, which loses data on Cloud Run). The outbox is not
processed while `EMAIL_DELIVERY=disabled` (items stay queued) and is claimed atomically, so two instances never
send the same email. On Cloud Run, password-reset codes use the attached service account (no key file).

## Configuration

**Frontend (public, inlined at build time from `.env`)**: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID`,
`VITE_FIREBASE_STORAGE_BUCKET`, optional `VITE_MAPBOX_ACCESS_TOKEN`. `npm run build:cloudflare` refuses to build
when any of the first four is missing or `VITE_USE_FIREBASE_EMULATORS=true`.

**Worker** (`wrangler.jsonc` vars per environment; secrets with `wrangler secret put`):

| Name | Kind | Value |
|---|---|---|
| `BACKEND_ORIGIN` | var | `https://smartwatts-api[-preview]-….asia-southeast1.run.app` (https only) |
| `PUBLIC_HOSTNAME` | var | public hostname; required in production (scheduler) |
| `PROXY_SHARED_SECRET` | **secret** | same value as the backend's; ≥ 32 chars |
| `CRON_API_KEY` | **secret**, production, optional | raw cron key; its SHA-256 is the backend's `CRON_API_KEY_SHA256` |

**Backend (Cloud Run)**: env vars `SMARTWATTS_ENV=production`, `FIREBASE_PROJECT_ID=smartwatts-266cc`,
`FIREBASE_STORAGE_BUCKET`, `ALLOWED_HOSTS` (the Worker's public hostname(s)), `APP_URL`, `EMAIL_DELIVERY=disabled`,
`GEMINI_MODEL`, optional `CRON_API_KEY_SHA256`; Secret Manager: `BOT_SECRET`, `PROXY_SHARED_SECRET`,
`GEMINI_API_KEY`, optional `GOOGLE_TRANSLATE_API_KEY`, `SMTP_USER`/`SMTP_PASSWORD` (only once email is approved).
Never set `GOOGLE_APPLICATION_CREDENTIALS`, emulator variables or `ALLOWED_ORIGINS` (same origin, no CORS needed).
All placeholders are listed in `.env.example`.

## Commands

Commands marked **PUBLISHES** or **CHANGES CLOUD** act on real infrastructure. Everything else is local.

### 1. Install and log in

```bash
npm install                      # installs wrangler (devDependency) and the build tools
npx wrangler --version           # 4.x
npx wrangler login               # browser OAuth to your Cloudflare account
npx wrangler whoami
gcloud auth login && gcloud config set project smartwatts-266cc    # for the Cloud Run backend
```

### 2. Local development

```bash
# terminal 1: backend (http://127.0.0.1:8000)
cd backend && .venv/bin/python -m uvicorn app.main:app --reload --port 8000
# terminal 2: Worker in front of a production-like build (http://127.0.0.1:8787)
cp .dev.vars.example .dev.vars    # then fill PROXY_SHARED_SECRET (same value as PROXY_SHARED_SECRET for the backend)
npm run build:cloudflare
npx wrangler dev
```

(For day-to-day UI work `npm run dev` with Vite on :5173 is unchanged.)

### 3. Build and checks

```bash
npm run typecheck && npm test               # includes the Worker unit tests
npm run test:backend                        # backend, incl. backend/tests/test_cloudflare_proxy.py
npm run build:cloudflare                    # dist/ + _headers + .assetsignore
# Full local stack (needs Java for the Firestore emulator, e.g. Homebrew openjdk@21):
PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" node scripts/cloudflare-local-check.mjs --browser
```

### 4. Backend on Cloud Run (**CHANGES CLOUD**, needs billing, see "Required approvals")

```bash
PROJECT=smartwatts-266cc; REGION=asia-southeast1; SA=smartwatts-api@$PROJECT.iam.gserviceaccount.com
BUCKET=<VITE_FIREBASE_STORAGE_BUCKET value>

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com --project $PROJECT
gcloud iam service-accounts create smartwatts-api --display-name "SmartWatts API (Cloud Run)" --project $PROJECT
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SA --role roles/datastore.user
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SA --role roles/firebaseauth.admin  # password reset
gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member serviceAccount:$SA --role roles/storage.objectAdmin

# Secrets: generated values never touch the shell history or the screen.
new() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
new | tr -d '\n' | gcloud secrets create smartwatts-bot-secret --data-file=- --project $PROJECT
PROXY=$(new)
printf %s "$PROXY" | gcloud secrets create smartwatts-proxy-secret --data-file=- --project $PROJECT
printf %s "$PROXY" | npx wrangler secret put PROXY_SHARED_SECRET --env preview      # after step 5's first deploy
printf %s "$PROXY" | npx wrangler secret put PROXY_SHARED_SECRET --env production   # (or a separate value per env)
unset PROXY
read -rs GEMINI && printf %s "$GEMINI" | gcloud secrets create smartwatts-gemini-key --data-file=- --project $PROJECT; unset GEMINI
for s in smartwatts-bot-secret smartwatts-proxy-secret smartwatts-gemini-key; do
  gcloud secrets add-iam-policy-binding $s --member serviceAccount:$SA --role roles/secretmanager.secretAccessor --project $PROJECT
done

# Deploy (Cloud Build builds ./Dockerfile; only backend/, mailer/, knowledge/ are uploaded, see .gcloudignore).
# --allow-unauthenticated: the Worker has no Google identity; the proxy secret is what protects the service.
gcloud run deploy smartwatts-api-preview --source . --region $REGION --project $PROJECT \
  --service-account $SA --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --concurrency 40 --cpu 1 --memory 512Mi --timeout 60 --cpu-boost \
  --set-env-vars "^;^SMARTWATTS_ENV=production;FIREBASE_PROJECT_ID=$PROJECT;FIREBASE_STORAGE_BUCKET=$BUCKET;EMAIL_DELIVERY=disabled;GEMINI_MODEL=gemini-3-flash-preview;ALLOWED_HOSTS=smartwatts-preview.<sub>.workers.dev;APP_URL=https://smartwatts-preview.<sub>.workers.dev" \
  --set-secrets "BOT_SECRET=smartwatts-bot-secret:latest,PROXY_SHARED_SECRET=smartwatts-proxy-secret:latest,GEMINI_API_KEY=smartwatts-gemini-key:latest"
gcloud run services describe smartwatts-api-preview --region $REGION --format 'value(status.url)'   # → BACKEND_ORIGIN
```

Production is the same command with service name `smartwatts-api`, the production hostnames, and (optionally) a
higher `--max-instances`. Both services use the one Firebase project, so a preview backend reads and writes the
same production data: test with your own accounts only.

### 5. Preview deployment (**PUBLISHES**)

1. Put the Cloud Run URL into `env.preview.vars.BACKEND_ORIGIN` in `wrangler.jsonc`.
2. Build and deploy:

   ```bash
   npm run build:cloudflare
   npm run cf:check:preview          # preflight + wrangler dry run (nothing uploaded)
   npm run cf:deploy:preview         # wrangler deploy --env preview → prints https://smartwatts-preview.<sub>.workers.dev
   printf %s "<proxy secret>" | npx wrangler secret put PROXY_SHARED_SECRET --env preview   # first time only
   ```

3. Firebase Console → Authentication → Settings → **Authorized domains** → add `smartwatts-preview.<sub>.workers.dev`
   (wildcards are not accepted). Set the same hostname in the backend's `ALLOWED_HOSTS` and `APP_URL`
   (`gcloud run services update smartwatts-api-preview --region $REGION --update-env-vars ...`).
4. If a Mapbox token is used, add the hostname to its URL restrictions.

### 6. Production deployment (**PUBLISHES**)

```bash
# wrangler.jsonc env.production: BACKEND_ORIGIN = smartwatts-api URL, PUBLIC_HOSTNAME = public host
# (custom domain: uncomment "routes" with custom_domain: true; the zone must be on Cloudflare)
npm run build:cloudflare
npm run cf:check:production
npm run cf:deploy:production
printf %s "<proxy secret>" | npx wrangler secret put PROXY_SHARED_SECRET --env production
# Optional notification scheduler (Cron Trigger, daily 00:05 Asia/Manila):
KEY=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
printf %s "$KEY" | npx wrangler secret put CRON_API_KEY --env production
gcloud run services update smartwatts-api --region $REGION --update-env-vars \
  CRON_API_KEY_SHA256=$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1); unset KEY
```

Add the production hostname to Firebase authorized domains, `ALLOWED_HOSTS` and `APP_URL`, as for preview.

### 7. Verify a deployment

```bash
H=https://smartwatts-preview.<sub>.workers.dev
curl -sS $H/api/health                                                    # {"status":"ok"}
for p in / /login /register /forgot-password /reset-password /dashboard /nfc; do
  curl -sS -o /dev/null -w "%{http_code} $p\n" $H$p; done                  # all 200
curl -sSI $H/landing/login.html | grep -i '^location'                     # /login (301)
curl -sSI $H/nfc | grep -iE 'content-security-policy|strict-transport'    # headers present
curl -sS -o /dev/null -w "%{http_code}\n" <cloud run url>/api/health      # 403: the edge cannot be skipped
```

Then in a browser: Google sign-in on `/login`; as the property owner open `/nfc` (→ Property Overview); as a tenant
open `/nfc` (→ My Statements); signed out, open `/nfc` (→ `/login`, back to `/nfc` after sign-in).

### 8. Logs, debugging, rollback

```bash
npx wrangler tail --env preview                               # live Worker logs (proxy errors, scheduler runs)
npx wrangler deployments list --env production
npx wrangler rollback --env production                        # PUBLISHES the previous Worker version
gcloud run services logs read smartwatts-api-preview --region asia-southeast1 --limit 100
gcloud run revisions list --service smartwatts-api --region asia-southeast1
gcloud run services update-traffic smartwatts-api --region asia-southeast1 --to-revisions <REVISION>=100
```

A `503 {"detail":"Service unavailable"}` from `/api/*` means `BACKEND_ORIGIN` or `PROXY_SHARED_SECRET` is missing
on the Worker; `403 {"detail":"Forbidden"}` from every API call means the two secrets differ; `400 Bad request`
means the public hostname is not in the backend's `ALLOWED_HOSTS`.

## NFC cards

Write only the HTTPS URL `https://<public host>/nfc` (NDEF URI record). Never a token, UID or claim. QR fallback:
`node scripts/nfc-qr.mjs https://<public host>/nfc`. Access is decided after sign-in from server-side memberships
(`GET /api/account/workspaces`). See `docs/NFC_CARD_DEMO.md`.

## Alternative backend host without Google Cloud billing

The Worker only needs an HTTPS `BACKEND_ORIGIN`. The existing Vercel setup (`vercel.json`, Python function) can be
that origin: set `PROXY_SHARED_SECRET`, `ALLOWED_HOSTS=<worker host>`, `BOT_SECRET`, `FIREBASE_PROJECT_ID`,
`EMAIL_DELIVERY=disabled` and `GOOGLE_APPLICATION_CREDENTIALS_JSON` (a Workload Identity Federation config, or a
service-account key as a last resort) on Vercel, and use `https://<project>.vercel.app` as `BACKEND_ORIGIN`.
Limits: Vercel Hobby is for non-commercial use, the Node email mailer is not available in the Python function,
and a credential must be stored on Vercel. Cloud Run avoids all three.

## Required approvals and costs

- **Google Cloud billing** (Blaze plan) on `smartwatts-266cc`: Cloud Run, Cloud Build, Artifact Registry and Secret
  Manager require it (currently billing is off and those APIs are disabled). Expected usage is within the free
  tiers for a small app, but set a budget alert. Firebase Auth/Firestore usage is unchanged.
- **Cloudflare**: Workers Free plan covers this (static asset requests are free; Worker invocations are only pages
  and API calls). Rate Limiting bindings and Cron Triggers are available on Workers plans; check the dashboard.
- Organisation policies that forbid `allUsers` on Cloud Run would block `--allow-unauthenticated`.

## Known limitations

- The page-level browser challenge runs only on the API (cookie), as on Vercel. Use Cloudflare Bot Fight Mode / WAF
  rules for page-level bot protection.
- Email stays disabled (`EMAIL_DELIVERY=disabled`) until sending is verified: email/password accounts cannot
  complete SmartWatts' own email verification and password-reset codes fall back to Firebase's reset email.
  Google accounts are verified by Firebase.
- Per-IP counters in the backend are per instance (strikes and bans are shared through Firestore); the edge limits
  are per Cloudflare location. Set `UPSTASH_REDIS_REST_URL`/`TOKEN` for exact global counters.
- Landing templates use placeholder attributes such as `onClick="{{toggleTheme}}"`; browsers report them as blocked
  inline handlers under the CSP. They are bound by `landing/support.js` and work (verified); no CSP change needed.
- Optional: Firestore TTL policies on `security_bans.expiresAt`; expired `email_otp_codes` documents are harmless
  (codes are single-use and time-limited) but are not deleted automatically.
