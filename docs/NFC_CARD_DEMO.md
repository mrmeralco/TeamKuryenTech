# SmartWatts NFC Card — Programming & Live Demo Runbook

The NFC card is a **navigation shortcut, not a login**. It stores one plain HTTPS URL. Whoever is
signed in on the phone decides what opens; the backend decides which property/unit they may see.

## 1. The card URL

```
https://<verified-smartwatts-domain>/nfc
```

- **Status: PENDING DEPLOYMENT.** As of 2026-11-13 no production domain is verified: Firebase Hosting
  `https://smartwatts-266cc.web.app` returns 404 (nothing deployed) and no other domain is configured
  in the repo. Do not program a card until `https://<domain>/nfc` opens the SmartWatts page in a phone browser.
- Never use `localhost`, `127.0.0.1`, an `http://` URL, or a URL containing tokens, emails, UIDs or roles.
- Optional property-specific card: `https://<domain>/nfc?p=<propertyId>`. The `p` hint only picks among
  properties the signed-in user already belongs to; it grants nothing. One common card (no `p`) is
  recommended for the demo.

### Hosting status (verified read-only 2026-11-13 05:00 PHT)
- `smartwatts-266cc.web.app` / `.firebaseapp.com` return 404 because the Hosting site has **zero releases**
  (nothing was ever deployed). Firebase's reserved `/__/auth/*` handler is served (200), so Google popup sign-in works.
- The Cloud Run Admin API is not enabled in `smartwatts-266cc`: **the FastAPI backend has no production host.**
  `/nfc` needs `GET /api/account/workspaces`, so a static deploy alone cannot complete the NFC flow.
- `firebase.json` now has a `hosting` block (public `dist`, explicit rewrites for `/`, `/login`, `/register`,
  `/forgot-password`, `/reset-password`, `/dashboard`, `/nfc`; `/api/**` → Cloud Run `smartwatts-api`
  in `asia-southeast1`, which is a placeholder until the backend is deployed). Predeploy: `npm run build` + `node scripts/prepare-hosting.mjs`
  (copies the unbundled landing pages into `dist/landing`). Tested locally with `firebase serve --only hosting`:
  all routes 200, `/nfc` → `/login#next=nfc`, no sources or `.env` exposed.
- Fixed: `landing/firebase-config.js` crashed when served without Vite (`import.meta.env` undefined), which broke
  `/login` on Apache and on any static host.

### Hosting requirements for `/nfc`
- Vite build emits `dist/nfc.html` (`npm run build`).
- Apache (`.htaccess`): `/nfc` → `dist/nfc.html`, `/branding/*` → `dist/branding/*` (rules included).
- Any other host: rewrite `/nfc` and `/nfc/` to `nfc.html`; serve `/api/*` from FastAPI on the same origin.
- Add the domain to Firebase Auth → Settings → **Authorized domains** (required for Google Sign-In) and to
  backend `ALLOWED_ORIGINS`.

## 2. Program the card (NTAG213/215/216, writable, unlocked)

Use any NDEF writer, e.g. **NFC Tools** (Android/iOS) by wakdev.

1. Open NFC Tools → **Write** → **Add a record** → **URL / URI**.
2. Enter the full URL `https://<domain>/nfc` (the app stores `https://` as the URI prefix byte; that is expected).
3. Tap **Write** and hold the card flat on the phone's NFC antenna (Android: middle of the back;
   iPhone: top edge) until it confirms. NTAG213 has 144 bytes — ample for this URL.
4. **Do not** use "Lock tag" / "Make read-only" during testing. Locking is permanent.
5. Verify: NFC Tools → **Read** → tap the card → confirm one record: `URI: https://<domain>/nfc`,
   type `U`, and nothing else (no extra records, no app-launch AAR needed).

## 3. Test with phones

| Phone | Behaviour | Notes |
|---|---|---|
| Android (NFC on) | Tap with screen unlocked → notification or browser opens the URL | Settings → Connected devices → NFC must be on. |
| iPhone XS or newer | Tap near top edge with screen on → banner "Open in Safari" → tap banner | Background tag reading; no app needed. iPhone 7–X need the Control Center NFC reader. |

**Telling reader errors from app errors**
- Nothing happens / "No supported app" / "empty tag" → card or phone problem: re-read the card with NFC Tools,
  check NFC is on, rewrite the URL record.
- Browser opens but shows a 404, DNS or certificate error → hosting problem (deployment/rewrite/domain).
- SmartWatts NFC page shows "Can't reach SmartWatts", "Access denied" or "No Rentals access" → the app
  is working; the message describes the account/server state.

## 4. QR fallback (same URL, same access flow)

```
node scripts/nfc-qr.mjs https://<verified-smartwatts-domain>/nfc
```
Writes `docs/nfc/smartwatts-nfc-qr.svg` and `.png`. The script refuses non-HTTPS, local, credential-bearing
or non-`/nfc` URLs. Print it next to the card; scanning it runs exactly the same sign-in and authorization flow.

## 5. What the page does

1. "Opening SmartWatts" → restores the Firebase session on this device.
2. Signed out / guest → existing login (`/login#next=nfc`). After email or Google sign-in it returns to `/nfc`.
   Only the fixed key `nfc` is honoured; any other `next` value goes to `/dashboard`.
3. Email-code accounts must be verified (same check as the dashboard guard).
4. `GET /api/account/workspaces` (verified ID token) returns only **active** memberships.
5. One membership → dashboard opens on **Property Overview** (owner/admin) or **My Statements** (tenant).
   Several → property chooser. None → "No Rentals access" (or the pending invitation flow).
6. Subscription restrictions, tenant isolation and staff-only tools stay enforced by the API and dashboard.

## 6. Demo prerequisites (read-only audit, 2026-11-13)

| Item | State | Action needed |
|---|---|---|
| Staff `schoolproware@gmail.com` | verified, `platformAdmin: true`, no Rentals memberships | none |
| Owner `rolexesto0001@gmail.com` | verified Google account, active **owner** of "Rolex Esto" (`95a91e6b075f3fc4d9f4`) | none |
| Owner subscription | `active` (administrative grant) — **period ends 2026-11-13 23:59:59 PHT** | If demoing later, staff use Platform · Rentals Subscriptions → **Extend** |
| Property units | **0 units** | Owner creates a unit (Units & Tenants) |
| Tenant `rolexesto001@gmail.com` | verified Google account, **no membership, no invitation** | Owner invites the tenant to the unit; tenant accepts |

Tenant onboarding (legitimate flow, done by the people involved — not by scripts):
1. Owner (Device A) → Units & Tenants → add a unit (e.g. "Unit 1").
2. Owner → invite **tenant** for that unit (optionally bound to `rolexesto001@gmail.com`) → share the invitation
   link/QR with the tenant.
3. Tenant (Device B) opens the invitation link, signs in with Google as `rolexesto001@gmail.com`, accepts.
4. Tenant now has an active tenant membership; tapping the card opens **My Statements**.

## 7. Live demo checklist

**Owner (Device A)**
1. Sign in as the owner at `https://<domain>/login`.
2. Tap the SmartWatts card → "Opening SmartWatts" → "Checking property access".
3. Property Overview for **Rolex Esto** opens; workspace switcher shows "Rolex Esto · Owner".
4. Account Settings shows the owner's own profile.

**Tenant (Device B)**
1. Sign in as the tenant.
2. Tap the same card → **My Statements** for Rolex Esto · Unit 1.
3. Confirm only the tenant's own unit/statements; no Units & Tenants, Subscription, Audit Log or staff menu.

**Signed-out device**
1. Private/incognito browser (or signed out). Tap the card.
2. SmartWatts shows "Sign in required" and opens the login page.
3. Sign in with either account → returns to `/nfc` → the correct dashboard opens.

The card never signs anyone in automatically.
