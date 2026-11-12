"""Firebase ID-token verification shared by every SmartWatts API route.

Any verified Firebase user (anonymous or permanent) may use Tier 1 personal
features such as the AI advisor. SmartWatts Rentals (Tier 2) requires a
permanent sign-in method (email/password or Google) so that property records
are tied to a recoverable identity.
"""

import os
from dataclasses import dataclass
from typing import Annotated

import firebase_admin
from fastapi import Depends, Header, HTTPException
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials
from firebase_admin.exceptions import FirebaseError
from google.auth.credentials import AnonymousCredentials
from google.auth.exceptions import DefaultCredentialsError


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


def get_firebase_app():
    project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if not project_id:
        raise HTTPException(status_code=503, detail="Firebase authentication is not configured on the server.")
    try:
        return firebase_admin.get_app()
    except ValueError:
        # Without a service account, ID-token verification still works (it only needs
        # Google's public keys), so fall back to anonymous credentials instead of failing.
        credential = None if os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip() else _PublicKeysOnly()
        return firebase_admin.initialize_app(credential, options={"projectId": project_id})


class _PublicKeysOnly(credentials.Base):
    def get_credential(self):
        return AnonymousCredentials()


def require_user(authorization: Annotated[str | None, Header()] = None) -> AuthUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="A Firebase sign-in is required.")

    firebase_app = get_firebase_app()
    try:
        claims = firebase_auth.verify_id_token(authorization.removeprefix("Bearer ").strip(), app=firebase_app)
    except (firebase_auth.InvalidIdTokenError, firebase_auth.ExpiredIdTokenError, firebase_auth.RevokedIdTokenError):
        raise HTTPException(status_code=401, detail="The Firebase sign-in token is invalid or expired.")
    except ValueError:
        raise HTTPException(status_code=401, detail="The Firebase sign-in token is invalid or expired.")
    except (DefaultCredentialsError, FirebaseError) as error:
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


def require_permanent_user(user: Annotated[AuthUser, Depends(require_user)]) -> AuthUser:
    if user.is_anonymous:
        raise HTTPException(
            status_code=403,
            detail="SmartWatts Rentals requires a permanent account. Sign in with email or Google first.",
        )
    return user
