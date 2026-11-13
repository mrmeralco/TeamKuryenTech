"""Email verification codes sent with SmartWatts' own mailer (app.mailer, SMTP).

Flow: after an email/password sign-up the user receives a branded email with a 6-digit
code; entering it marks the account as verified in SmartWatts' own registry.

No Firebase service account is needed: the signed-in user is identified by verifying
their Firebase ID token (public keys only). Accounts Firebase already marks verified
(e.g. Google sign-in) count as verified too.

Storage:
- With UPSTASH_REDIS_REST_URL/TOKEN set (required on Vercel, where every request can land on a
  different, short-lived instance with a read-only disk), codes and the verified registry live in
  Redis and are shared by all instances.
- Otherwise (local development, tests) codes stay in memory and "verified" is a JSON file
  (VERIFIED_USERS_FILE, default backend/data/verified_users.json).

Codes: 6 digits, valid 10 minutes, max 5 wrong tries, 60 s resend cooldown, stored only as an HMAC.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from . import mailer
from .auth import AuthUser, require_user

logger = logging.getLogger("smartwatts.email")

CODE_TTL_SECONDS = 10 * 60
RESEND_COOLDOWN_SECONDS = 60
MAX_ATTEMPTS = 5

router = APIRouter(prefix="/api/auth", tags=["auth"])


# --------------------------------------------------------------------------- one-time codes
@dataclass
class _Entry:
    digest: bytes
    expires_at: float
    sent_at: float
    attempts: int = 0


class OtpStore:
    def __init__(self) -> None:
        self._key = secrets.token_bytes(32)
        self._entries: dict[tuple[str, str], _Entry] = {}
        self._lock = threading.Lock()

    def _digest(self, email: str, purpose: str, code: str) -> bytes:
        return hmac.new(self._key, f"{purpose}:{email}:{code}".encode(), hashlib.sha256).digest()

    def seconds_until_resend(self, email: str, purpose: str, now: float | None = None) -> int:
        now = time.time() if now is None else now
        with self._lock:
            entry = self._entries.get((purpose, email))
            if not entry:
                return 0
            return max(0, int(entry.sent_at + RESEND_COOLDOWN_SECONDS - now + 0.999))

    def issue(self, email: str, purpose: str, now: float | None = None) -> str:
        now = time.time() if now is None else now
        code = f"{secrets.randbelow(1_000_000):06d}"
        with self._lock:
            self._entries[(purpose, email)] = _Entry(self._digest(email, purpose, code), now + CODE_TTL_SECONDS, now)
        return code

    def check(self, email: str, purpose: str, code: str, now: float | None = None) -> bool:
        """True and consumes the code when it matches; otherwise counts a failed attempt."""
        now = time.time() if now is None else now
        with self._lock:
            entry = self._entries.get((purpose, email))
            if not entry or entry.expires_at < now or entry.attempts >= MAX_ATTEMPTS:
                return False
            if hmac.compare_digest(entry.digest, self._digest(email, purpose, code)):
                del self._entries[(purpose, email)]
                return True
            entry.attempts += 1
            return False


class _Upstash:
    """Minimal synchronous Upstash Redis REST client."""

    def __init__(self, url: str, token: str) -> None:
        self._url, self._token = url.rstrip("/"), token
        self._http = httpx.Client(timeout=httpx.Timeout(5.0))

    def pipeline(self, *commands: list) -> list:
        try:
            response = self._http.post(f"{self._url}/pipeline", json=list(commands),
                                       headers={"Authorization": f"Bearer {self._token}"})
            response.raise_for_status()
            items = response.json()
        except (httpx.HTTPError, ValueError) as error:
            logger.warning("email: Upstash unavailable", exc_info=True)
            raise HTTPException(status_code=503, detail="Verification is temporarily unavailable. Try again in a moment.") from error
        for item in items:
            if isinstance(item, dict) and item.get("error"):
                logger.warning("email: Upstash error %s", item["error"])
                raise HTTPException(status_code=503, detail="Verification is temporarily unavailable. Try again in a moment.")
        return [item.get("result") if isinstance(item, dict) else None for item in items]


def _shared_key() -> bytes:
    """HMAC key shared by every instance (codes issued on one instance verify on another)."""
    secret = next((os.getenv(n, "").strip() for n in ("OTP_SECRET", "BOT_SECRET", "UPSTASH_REDIS_REST_TOKEN")
                   if os.getenv(n, "").strip()), "")
    return hashlib.sha256(f"smartwatts-otp:{secret}".encode()).digest()


def _email_key(email: str) -> str:
    return hashlib.sha256(email.encode()).hexdigest()[:32]


class RedisOtpStore(OtpStore):
    """Same behaviour as OtpStore, kept in Upstash Redis (one hash per purpose+email, expiring)."""

    def __init__(self, redis: _Upstash) -> None:
        super().__init__()
        self._key = _shared_key()
        self._redis = redis

    @staticmethod
    def _rkey(email: str, purpose: str) -> str:
        return f"otp:{purpose}:{_email_key(email)}"

    def seconds_until_resend(self, email: str, purpose: str, now: float | None = None) -> int:
        now = time.time() if now is None else now
        (sent_at,) = self._redis.pipeline(["HGET", self._rkey(email, purpose), "sent_at"])
        if not sent_at:
            return 0
        return max(0, int(float(sent_at) + RESEND_COOLDOWN_SECONDS - now + 0.999))

    def issue(self, email: str, purpose: str, now: float | None = None) -> str:
        now = time.time() if now is None else now
        code = f"{secrets.randbelow(1_000_000):06d}"
        key = self._rkey(email, purpose)
        self._redis.pipeline(
            ["DEL", key],
            ["HSET", key, "digest", self._digest(email, purpose, code).hex(), "expires_at", str(now + CODE_TTL_SECONDS),
             "sent_at", str(now), "attempts", "0"],
            ["EXPIRE", key, CODE_TTL_SECONDS],
        )
        return code

    def check(self, email: str, purpose: str, code: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        key = self._rkey(email, purpose)
        (raw,) = self._redis.pipeline(["HGETALL", key])
        entry = dict(zip(raw[::2], raw[1::2])) if raw else {}
        if not entry or float(entry.get("expires_at", 0)) < now or int(entry.get("attempts", 0)) >= MAX_ATTEMPTS:
            return False
        if hmac.compare_digest(entry.get("digest", ""), self._digest(email, purpose, code).hex()):
            (deleted,) = self._redis.pipeline(["DEL", key])
            return bool(deleted)  # only one concurrent request can consume the code
        self._redis.pipeline(["HINCRBY", key, "attempts", 1])
        return False


def _redis_from_env() -> _Upstash | None:
    url = os.getenv("UPSTASH_REDIS_REST_URL", "").strip()
    token = os.getenv("UPSTASH_REDIS_REST_TOKEN", "").strip()
    return _Upstash(url, token) if url and token else None


_redis = _redis_from_env()
if _redis is None and os.getenv("VERCEL"):
    logger.error("email: UPSTASH_REDIS_REST_URL/TOKEN are not set; email codes will not work reliably on Vercel")
store: OtpStore = RedisOtpStore(_redis) if _redis else OtpStore()


# --------------------------------------------------------------------------- verified registry
class VerifiedRegistry:
    """uid -> verified email, persisted as JSON."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _load(self) -> dict[str, dict]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def is_verified(self, uid: str, email: str) -> bool:
        with self._lock:
            entry = self._load().get(uid)
        return bool(entry and entry.get("email") == email.lower())

    def mark(self, uid: str, email: str) -> None:
        with self._lock:
            data = self._load()
            data[uid] = {"email": email.lower(), "verifiedAt": int(time.time())}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(self.path)


class RedisVerifiedRegistry:
    """uid -> verified email, in Upstash Redis (no expiry)."""

    def __init__(self, redis: _Upstash) -> None:
        self._redis = redis

    def is_verified(self, uid: str, email: str) -> bool:
        (stored,) = self._redis.pipeline(["GET", f"verified:{uid}"])
        return bool(stored) and stored == email.lower()

    def mark(self, uid: str, email: str) -> None:
        self._redis.pipeline(["SET", f"verified:{uid}", email.lower()])


def _default_registry_path() -> Path:
    configured = os.getenv("VERIFIED_USERS_FILE", "").strip()
    if configured:
        return Path(configured)
    if os.getenv("VERCEL"):  # the deployed bundle is read-only; /tmp is writable (but per instance)
        return Path("/tmp/smartwatts/verified_users.json")
    return Path(__file__).resolve().parent.parent / "data" / "verified_users.json"


registry: VerifiedRegistry | RedisVerifiedRegistry = (
    RedisVerifiedRegistry(_redis) if _redis else VerifiedRegistry(_default_registry_path()))


def is_user_verified(user: AuthUser) -> bool:
    if user.is_anonymous or not user.email:
        return False
    return user.email_verified or registry.is_verified(user.uid, user.email)


# --------------------------------------------------------------------------- mailer (app.mailer, SMTP)
def send_email(template: str, to: str, data: dict) -> None:
    """Sends a SmartWatts email over SMTP (Gmail app password from the environment).

    ``EMAIL_DELIVERY=disabled`` (used by the emulator demo environment) blocks every delivery before
    any connection is made, so synthetic bills and statements can never email real recipients.
    """
    if os.getenv("EMAIL_DELIVERY", "").strip().lower() == "disabled":
        raise HTTPException(status_code=503, detail="Email delivery is disabled in this environment.")
    try:
        mailer.send(template, to, data)
    except mailer.MailerError as error:
        logger.warning("email: %s email to %s failed: %s", template, to.split("@")[-1], error)
        if error.auth:
            raise HTTPException(status_code=503, detail="The email server rejected the login. Check SMTP_USER / SMTP_PASSWORD.") from error
        if error.config:
            raise HTTPException(status_code=503, detail="Email sending is not set up on the server (SMTP_USER / SMTP_PASSWORD missing).") from error
        raise HTTPException(status_code=502, detail="Could not send the email right now. Try again in a moment.") from error


def send_code_email(to: str, code: str, name: str | None = None) -> None:
    send_email("verification", to, {"code": code, "name": name, "minutes": CODE_TTL_SECONDS // 60})


def _send_welcome(to: str, name: str | None) -> None:
    try:
        send_email("welcome", to, {"name": name})
    except HTTPException:
        pass


def send_welcome_email_later(to: str, name: str | None, background: BackgroundTasks | None = None) -> None:
    """Best-effort welcome email; never fails the verification request.

    Runs as a FastAPI background task (after the response, still inside the request, so a serverless
    function is not frozen mid-send) or, without one, on a thread.
    """
    if background is not None:
        background.add_task(_send_welcome, to, name)
    else:
        threading.Thread(target=_send_welcome, args=(to, name), daemon=True).start()


# --------------------------------------------------------------------------- API
class SendCodeRequest(BaseModel):
    name: str | None = Field(default=None, max_length=100)


class VerifyEmailRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    name: str | None = Field(default=None, max_length=100)


def _require_email_user(user: AuthUser) -> str:
    if user.is_anonymous or not user.email:
        raise HTTPException(status_code=400, detail="Sign in with your email account first.")
    return user.email.lower()


@router.get("/status")
def auth_status(user: Annotated[AuthUser, Depends(require_user)]):
    return {"verified": is_user_verified(user)}


@router.post("/email-code/verify/send")
def send_verify_code(user: Annotated[AuthUser, Depends(require_user)], body: SendCodeRequest | None = None):
    email = _require_email_user(user)
    if is_user_verified(user):
        return {"sent": False, "alreadyVerified": True}
    wait = store.seconds_until_resend(email, "verify")
    if wait:
        raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another code.")
    send_code_email(email, store.issue(email, "verify"), (body.name if body else None))
    return {"sent": True}


@router.post("/email-code/verify/confirm")
def confirm_verify_code(body: VerifyEmailRequest, user: Annotated[AuthUser, Depends(require_user)],
                        background: BackgroundTasks):
    email = _require_email_user(user)
    if not store.check(email, "verify", body.code):
        raise HTTPException(status_code=400, detail="That code is incorrect or expired.")
    registry.mark(user.uid, email)
    send_welcome_email_later(email, body.name, background)
    return {"verified": True}


# --------------------------------------------------------------------------- password reset (needs a service account)
class ResetSendRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class ResetConfirmRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    code: str = Field(pattern=r"^\d{6}$")
    new_password: str = Field(min_length=8, max_length=128)


def admin_available() -> bool:
    """Changing a password requires the Firebase Admin SDK with a service account key."""
    path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    return bool(path) and Path(path).is_file()


def _require_admin() -> None:
    if not admin_available():
        # The landing page falls back to Firebase's own reset email when it sees this.
        raise HTTPException(status_code=501, detail="firebase-reset-email")


def _get_user_by_email(email: str):
    from firebase_admin import auth as firebase_auth
    from .auth import get_firebase_app

    try:
        return firebase_auth.get_user_by_email(email, app=get_firebase_app())
    except firebase_auth.UserNotFoundError:
        return None


def _set_password(uid: str, password: str) -> None:
    from firebase_admin import auth as firebase_auth
    from .auth import get_firebase_app

    firebase_auth.update_user(uid, password=password, app=get_firebase_app())


@router.post("/password-reset/send")
def send_reset_code(body: ResetSendRequest):
    _require_admin()
    email = body.email.strip().lower()
    wait = store.seconds_until_resend(email, "reset")
    if wait:
        raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another code.")
    code = store.issue(email, "reset")
    account = _get_user_by_email(email)
    # Same answer whether or not the account exists, so this can't be used to find accounts.
    if account is not None:
        send_email("password-reset", email, {"code": code, "name": account.display_name, "minutes": CODE_TTL_SECONDS // 60})
    return {"sent": True}


@router.post("/password-reset/confirm")
def confirm_reset(body: ResetConfirmRequest):
    _require_admin()
    email = body.email.strip().lower()
    if not store.check(email, "reset", body.code):
        raise HTTPException(status_code=400, detail="That code is incorrect or expired.")
    account = _get_user_by_email(email)
    if account is None:
        raise HTTPException(status_code=400, detail="That code is incorrect or expired.")
    _set_password(account.uid, body.new_password)
    # Receiving the code proves the user owns this inbox.
    registry.mark(account.uid, email)
    return {"reset": True}
