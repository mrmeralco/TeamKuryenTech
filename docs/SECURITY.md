# SmartWatts security

How the production site is protected, how to configure it, and what to do during an attack.
The app itself (FastAPI, `backend/app/security/`) handles headers, request rules, validation, rate limits,
bans and the browser check. The edge (Vercel Firewall) is what stops a large DDoS: the app can't.

## Deployment shape (Vercel)

`vercel.json` defines two services:

| Service | What | Public? |
|---|---|---|
| `web` | the static build (`npm run build && node scripts/prepare-hosting.mjs` → `dist/`) | **No** (no rewrite targets it) |
| `app` | FastAPI (`backend/`, entrypoint `app.main:app`) | Yes: `/(.*)` → `app` |

Every request (pages and API) reaches FastAPI first. After the guards pass, pages and files are fetched from
`web` through the service binding `WEB_URL` (`backend/app/security/site.py`).

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Required in production | Value |
|---|---|---|
| `BOT_SECRET` | **yes** (≥ 32 chars) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_HOSTS` | **yes** | `smartwatts.vercel.app` (comma-separate extra domains). The deployment's own `*.vercel.app` URLs are always accepted. |
| `FIREBASE_PROJECT_ID` | yes (auth + shared bans) | `smartwatts-266cc` |
| `GEMINI_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`, `SMTP_*`, … | feature keys | as before |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | no | only if you add Redis later |
| `CRON_API_KEY_SHA256` | no | SHA-256 of the key a scheduler sends in `x-api-key` |
| `ATTACK_MODE` | no | `1` forces the app's own attack mode on |

Production refuses to start when `BOT_SECRET` is missing or short, or `ALLOWED_HOSTS` is missing, and the
error says which variable and how to generate it. `WEB_URL` is injected by Vercel; never set it yourself.

Also add `smartwatts.vercel.app` to Firebase Console → Authentication → Settings → **Authorized domains**,
and restrict the Firebase web API key (Google Cloud Console → APIs & Services → Credentials) to your domain.

Firestore: add a TTL policy on collection `security_bans`, field `expiresAt`
(Firebase Console → Firestore → TTL), so old strike/ban documents delete themselves.

## Edge protection: Vercel Firewall (step 10)

Do these in the Vercel dashboard. Nothing here changes code. Plan limits apply. Custom rules and
Attack Mode are on every plan, persistent actions need Pro or Enterprise.

### 1. Rate-limit the API and sign-in endpoints at the edge
1. Open the project → **Firewall** (sidebar).
2. **⋯** (top right) → **Configure** → **Add New…** → **Rule**.
3. Name: `API rate limit`. You can type in the natural-language box: *"Rate limit /api to 240 requests per
   minute per IP"* → **Generate Rule**, or set it by hand:
   - **If** `Request Path` `starts with` `/api/`
   - **Then** `Rate Limit`: fixed window **60 s**, limit **240**, key **IP**; follow-up action **429**.
4. **Save Rule**.
5. Add a second rule `Auth brute force`: **If** `Request Path` `starts with` `/api/auth/` **AND**
   `Method` `equals` `POST` → **Rate Limit** 60 s / **10**, key IP, action **Deny**;
   if available, **Add Persistent Action** → **15 minutes**.
6. Add `Scanner paths`: **If** `Request Path` `ends with` `.env` OR `.git` OR `.php` OR `.bak` → **Deny**.
7. Top right: **Review Changes** → **Publish**.
8. Start each new rule as **Log**, watch the Firewall overview (10-minute live traffic) for false
   positives, then switch it to Rate Limit / Deny.

### 2. Bot protection
1. Firewall → **Configure** → **Bot Management**: turn on **Bot Protection** (challenge non-browser bots)
   and the **AI Bots** ruleset (deny). Verified search engines stay allowed.
2. Review the Firewall overview after a day for anything legitimate being challenged.

*BotID* needs Vercel's JavaScript server SDK (Next.js, Nuxt, SvelteKit…); it does not plug into this
FastAPI backend, so the app's own browser check (step 13) covers that role.

### 3. During an attack (emergency)
1. Project → **Firewall** → **⋯** (top right) → **Enable Attack Mode** → **Enable for 1 Hour**
   (or 6 / 24 hours from the menu next to the button). Every visitor must pass Vercel's challenge;
   search engines and your own functions are allowed through. It switches off by itself.
2. Optionally also set `ATTACK_MODE=1` in the environment variables and redeploy: the app's own limits drop
   to a quarter and the browser puzzle gets harder.
3. To turn it off: **Firewall** → **⋯** → **Disable Attack Mode**.
4. If one network is the source: Firewall → **Configure** → **Add New…** → **IP Blocking** for the
   IP / CIDR shown in the Firewall overview.

## Hardening report

| Step | What was added | File | Protects against |
|---|---|---|---|
| 1 Secrets | Startup validation; production refuses to start without `BOT_SECRET` (≥32) / `ALLOWED_HOSTS`; no secret fallbacks; `.env.*` ignored | `backend/app/security/settings.py` | Weak / missing secrets, leaked config |
| 2 Headers | CSP, HSTS, nosniff, DENY, referrer, permissions, COOP/CORP, no `Server`; inline scripts moved to files; Chart.js bundled | `security/headers.py`, `security/middleware.py`, `vercel.json` | XSS, clickjacking, MIME sniffing, info leaks |
| 3 Request rules | Method allow-list (405), URL > 2000 (414), TE+CL (400), Host allow-list (400), 100 KB body limit (413), safe file serving | `security/rules.py`, `security/site.py` | Smuggling, Host poisoning, oversized bodies, path traversal |
| 4 Validation | Allow-list for every API path/query parameter; escaped raw HTML spots; fixed outgoing hosts, 10 s timeouts | `security/validation.py`, `app.js`, `personal.js` | Injection, stored XSS, SSRF |
| 5 Rate limits | Pages 120/min, API 240/min + 40/5 s, enumeration, auth 5/15 min per IP and account; 3 strikes = 15 min ban; honeypots; 50k caps | `security/limits.py`, `security/store.py`, `public/robots.txt` | Brute force, scraping, floods |
| 6 Auth | Cron key (SHA-256, header only) or platform admin for jobs (**fixed privilege bug**); forged tokens = strikes; API `no-store`; no OpenAPI in prod | `auth.py`, `notifications/router.py` | Privilege escalation, key guessing, cache leaks |
| 7 Errors/logs | Access log (no secrets), short 422s, generic 500s, real 404s | `security/middleware.py`, `main.py` | Info disclosure |
| 8 Server | Hardened uvicorn launcher for non-Vercel hosting | `backend/serve.py` | Slowloris, header floods |
| 9 Bots | AI crawlers disallowed, `X-Robots-Tag: noai, noimageai`, search engines allowed | `public/robots.txt`, `security/headers.py` | AI scraping |
| 10 Edge | Vercel Firewall runbook | `docs/SECURITY.md` | Large DDoS (edge only) |
| 11 Dependencies | nodemailer 6 → 10.5, pytest ≥ 9.0.3 (dev only), tzdata | `package.json`, `backend/requirements*.txt` | Known CVEs |
| 12 Client side | Request filters + UA lists, in-page deterrents, obfuscated build with hidden markup | `security/filters.py`, `public/deterrents.js`, `scripts/protect-build.mjs` | Lazy scrapers, scanners, casual copying |
| 13 Browser check | PoW challenge, HMAC cookie bound to UA, API requires cookie, attack mode, in-app re-check | `security/shield.py`, `public/shield-client.js` | Bots that can't run JS, floods |

Client-side protections (12) only slow people down; steps 1-11 are the real defense.

## Not covered yet

- Email OTP on Vercel: the Python function can't run `node mailer/send.mjs`, and OTP codes live in memory per instance. Move sending to Python SMTP and codes to Firestore before relying on email verification in production.
- `backend/data/verified_users.json` is written to disk: read-only on Vercel. Move it to Firestore.
- Rate-limit counters are per instance without Redis (bans are shared via Firestore). Add Upstash if traffic grows.
- Firebase sign-in itself is throttled by Google, not by this app; consider Firebase App Check.
- The landing page runtime needs `'unsafe-eval'`; replacing it with a built React page would allow a stricter CSP.
- Dev-tool npm advisories (firebase-tools, workbox-build) remain until upstream fixes.
- Run `npm run build:prod` and test the deployed preview (sign-in, dashboard, bill scan, map) before switching production traffic.
