"""Per-IP rate limits, strikes and bans (step 5).

Limits per client IP (scaled down to a quarter in attack mode, see shield.py):
  pages        120 page loads / minute       (static files: 600 / minute)
  API          240 requests / minute, plus 40 / 5 seconds (burst)
  enumeration  more than 150 distinct API URLs / minute -> 429 and a strike
  auth         5 attempts / 15 minutes per IP and per account on the email-code and password-reset endpoints
               (Firebase sign-in itself goes straight to Google, which throttles it)
Three strikes (honeypot, enumeration, attack filter, bad cron key, malformed sign-in token) ban the IP for
15 minutes: 403 with Retry-After: 900.
"""

from __future__ import annotations

import base64
import json
import re

PAGE_LIMIT, ASSET_LIMIT, API_LIMIT = 120, 600, 240
BURST_LIMIT, BURST_WINDOW = 40, 5
ENUM_LIMIT = 150
AUTH_LIMIT, AUTH_WINDOW = 5, 15 * 60

AUTH_PATHS = re.compile(r"^/api/auth/(email-code/verify/(send|confirm)|password-reset/(send|confirm))$")
# Honeypots: listed under Disallow in robots.txt and linked from nowhere.
TRAP = re.compile(r"/(private-data|internal-api|admin-api|backup-db|_trap|db-dump|users-export)(/|$)", re.I)


def client_ip(scope, headers: dict[str, str], trusted_header: str) -> str:
    """The IP the hosting platform reports (e.g. x-vercel-forwarded-for). A raw client X-Forwarded-For is never read."""
    if trusted_header:
        value = headers.get(trusted_header, "").split(",")[0].strip()
        if value:
            return value[:64]
    client = scope.get("client")
    return (client[0] if client else "unknown")[:64]


def token_subject(authorization: str) -> str:
    """The `sub` claim of a bearer JWT, read WITHOUT verification: only used to count attempts per account.
    A forged subject gains nothing, because the route still verifies the token."""
    try:
        payload = authorization.removeprefix("Bearer ").split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return str(claims.get("sub") or claims.get("user_id") or "")[:128]
    except Exception:
        return ""


def body_email(body: bytes) -> str:
    try:
        value = json.loads(body or b"{}").get("email", "")
        return str(value).strip().lower()[:254] if isinstance(value, str) else ""
    except Exception:
        return ""
