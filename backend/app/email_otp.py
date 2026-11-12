"""Email verification codes sent with SmartWatts' own mailer (nodemailer, mailer/send.mjs).

Flow: after an email/password sign-up the user receives a branded email with a 6-digit
code; entering it marks the account as verified in SmartWatts' own registry.

No Firebase service account is needed: the signed-in user is identified by verifying
their Firebase ID token (public keys only), and "verified" is stored by this server in
a small JSON file (VERIFIED_USERS_FILE, default backend/data/verified_users.json).
Accounts Firebase already marks verified (e.g. Google sign-in) count as verified too.

Codes: 6 digits, valid 10 minutes, max 5 wrong tries, 60 s resend cooldown, kept hashed
in memory (they reset when the server restarts).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import AuthUser, require_user

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


store = OtpStore()


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


def _default_registry_path() -> Path:
    configured = os.getenv("VERIFIED_USERS_FILE", "").strip()
    return Path(configured) if configured else Path(__file__).resolve().parent.parent / "data" / "verified_users.json"


registry = VerifiedRegistry(_default_registry_path())


def is_user_verified(user: AuthUser) -> bool:
    if user.is_anonymous or not user.email:
        return False
    return user.email_verified or registry.is_verified(user.uid, user.email)


# --------------------------------------------------------------------------- mailer (Node: mailer/send.mjs)
MAILER_SCRIPT = Path(__file__).resolve().parents[2] / "mailer" / "send.mjs"


def send_email(template: str, to: str, data: dict) -> None:
    """Sends a SmartWatts email through the nodemailer script (Gmail app password from .env).

    ``EMAIL_DELIVERY=disabled`` (used by the emulator demo environment) blocks every delivery before
    the mailer process starts, so synthetic bills and statements can never email real recipients.
    """
    if os.getenv("EMAIL_DELIVERY", "").strip().lower() == "disabled":
        raise HTTPException(status_code=503, detail="Email delivery is disabled in this environment.")
    node = shutil.which("node")
    if not node or not MAILER_SCRIPT.exists():
        raise HTTPException(status_code=503, detail="Email sending is not set up on the server (Node mailer missing).")
    try:
        done = subprocess.run(
            [node, str(MAILER_SCRIPT)],
            input=json.dumps({"template": template, "to": to, "data": data}),
            capture_output=True, text=True, timeout=45, cwd=str(MAILER_SCRIPT.parent.parent),
        )
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=502, detail="Could not send the email right now. Try again in a moment.") from error
    try:
        result = json.loads((done.stdout or "").strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        result = {"ok": False, "error": done.stderr[-300:]}
    if not result.get("ok"):
        if result.get("auth"):
            raise HTTPException(status_code=503, detail="The email server rejected the login. Check SMTP_USER / SMTP_PASSWORD.")
        raise HTTPException(status_code=502, detail="Could not send the email right now. Try again in a moment.")


def send_code_email(to: str, code: str, name: str | None = None) -> None:
    send_email("verification", to, {"code": code, "name": name, "minutes": CODE_TTL_SECONDS // 60})


def send_welcome_email_later(to: str, name: str | None) -> None:
    """Best-effort welcome email; never blocks or fails the verification request."""
    def run():
        try:
            send_email("welcome", to, {"name": name})
        except HTTPException:
            pass
    threading.Thread(target=run, daemon=True).start()


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
def confirm_verify_code(body: VerifyEmailRequest, user: Annotated[AuthUser, Depends(require_user)]):
    email = _require_email_user(user)
    if not store.check(email, "verify", body.code):
        raise HTTPException(status_code=400, detail="That code is incorrect or expired.")
    registry.mark(user.uid, email)
    send_welcome_email_later(email, body.name)
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
