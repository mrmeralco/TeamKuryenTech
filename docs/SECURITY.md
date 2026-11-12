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
