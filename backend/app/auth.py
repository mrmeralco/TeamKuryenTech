"""Firebase ID-token verification shared by every SmartWatts API route.

Any verified Firebase user (anonymous or permanent) may use Tier 1 personal
features such as the AI advisor. SmartWatts Rentals (Tier 2) requires a
permanent sign-in method (email/password or Google) so that property records
are tied to a recoverable identity.
"""

import os
import threading
from dataclasses import dataclass
from typing import Annotated

import firebase_admin
import google.auth
import hashlib
import hmac

from fastapi import Depends, Header, HTTPException, Request
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials
from firebase_admin.exceptions import FirebaseError
from google.auth.credentials import AnonymousCredentials
from google.auth.exceptions import DefaultCredentialsError, GoogleAuthError


@dataclass(frozen=True)
class AuthUser:
    uid: str
    sign_in_provider: str
    email: str | None = None
    email_verified: bool = False
    platform_admin: bool = False

    @property
    def is_anonymous(self) -> bool:
        return self.sign_in_provider == "anonymous"


_app_lock = threading.Lock()


def get_firebase_app():
    project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if not project_id:
        raise HTTPException(status_code=503, detail="Firebase authentication is not configured on the server.")
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass
    # Sync routes run in a thread pool: concurrent first requests must not both initialize the app.
    with _app_lock:
        try:
            return firebase_admin.get_app()
        except ValueError:
            pass
        # ID-token verification uses Google's public keys; without configured
        # service credentials, use anonymous credentials rather than requiring
        # write-capable Admin SDK credentials for this API's auth dependency.
        try:
            google.auth.default()
            credential = None
        except DefaultCredentialsError:
            credential = _PublicKeysOnly()
        return firebase_admin.initialize_app(credential, options={"projectId": project_id})


class _PublicKeysOnly(credentials.Base):
    def get_credential(self):
        return AnonymousCredentials()


def _flag_strike(request: Request | None, reason: str) -> None:
    """Asks the security middleware to count a strike against this client (3 strikes = 15-minute ban)."""
    if request is not None:
        request.state.security_strike = reason


def require_user(request: Request, authorization: Annotated[str | None, Header()] = None) -> AuthUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="A Firebase sign-in is required.")

    firebase_app = get_firebase_app()
    try:
        claims = firebase_auth.verify_id_token(authorization.removeprefix("Bearer ").strip(), app=firebase_app)
    except (firebase_auth.ExpiredIdTokenError, firebase_auth.RevokedIdTokenError):
        # Normal for real users (an old tab, a signed-out session): no strike.
        raise HTTPException(status_code=401, detail="The Firebase sign-in token is invalid or expired.")
    except (firebase_auth.InvalidIdTokenError, ValueError):
        # Forged or garbage tokens: a strike, like a wrong API key.
        _flag_strike(request, "invalid sign-in token")
        raise HTTPException(status_code=401, detail="The Firebase sign-in token is invalid or expired.")
    except (DefaultCredentialsError, GoogleAuthError, FirebaseError) as error:
        raise HTTPException(status_code=503, detail="Firebase token verification is unavailable.") from error

    provider = claims.get("firebase", {}).get("sign_in_provider", "")
    return AuthUser(
        uid=claims["uid"],
        sign_in_provider=provider if isinstance(provider, str) else "",
        email=claims.get("email") if isinstance(claims.get("email"), str) else None,
        email_verified=claims.get("email_verified") is True,
        # Custom claim set only by SmartWatts operators via the Admin SDK.
        platform_admin=claims.get("platformAdmin") is True,
    )


def cron_key_valid(request: Request, x_api_key: str | None) -> bool:
    """True when the x-api-key header matches CRON_API_KEY_SHA256 (only the SHA-256 hash is configured).

    A wrong key is a strike. The key is accepted only in a header, never in the URL (URLs end up in logs)."""
    expected = os.getenv("CRON_API_KEY_SHA256", "").strip().lower()
    if not x_api_key:
        return False
    supplied = hashlib.sha256(x_api_key.encode()).hexdigest()
    if expected and hmac.compare_digest(supplied.encode(), expected.encode()):
        return True
    _flag_strike(request, "bad api key")
    return False


def require_operator(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header()] = None,
) -> AuthUser | None:
    """Scheduler / outbox jobs: a valid cron key (x-api-key) or a signed-in platform administrator."""
    if x_api_key is not None:
        if cron_key_valid(request, x_api_key):
            return None
        raise HTTPException(status_code=401, detail="Invalid API key.")
    user = require_user(request, authorization)
    if not user.platform_admin:
        raise HTTPException(status_code=403, detail="Platform administrators only.")
    return user


def require_permanent_user(user: Annotated[AuthUser, Depends(require_user)]) -> AuthUser:
    if user.is_anonymous:
        raise HTTPException(
            status_code=403,
            detail="SmartWatts Rentals requires a permanent account. Sign in with email or Google first.",
        )
    return user
