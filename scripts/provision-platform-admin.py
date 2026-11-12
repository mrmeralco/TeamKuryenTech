#!/usr/bin/env python3
"""Safely verify, grant, or revoke SmartWatts platform administrator claims.

Uses Application Default Credentials. Defaults to a read-only dry run. Never
prints credential material; claim values are shown only by name/value because
custom claims are authorization metadata, not credentials.
"""
import argparse
import getpass
import json
import sys

import firebase_admin
from firebase_admin import auth


PROJECT = "smartwatts-266cc"
EMAIL = "schoolproware@gmail.com"
UID = "GHHVAB4IwAflS8uxvCirk3Wtz0o1"
CLAIM = "platformAdmin"


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(2)


def get_app():
    try:
        app = firebase_admin.get_app("platform-admin-provision")
    except ValueError:
        app = firebase_admin.initialize_app(
            options={"projectId": PROJECT}, name="platform-admin-provision"
        )
    if app.project_id != PROJECT:
        fail(f"Effective Firebase project mismatch: {app.project_id!r}")
    return app


def verified_user(app):
    try:
        user = auth.get_user(UID, app=app)
    except Exception as exc:
        fail(f"Firebase Auth lookup failed ({type(exc).__name__}): {exc}")
    if user.uid != UID or (user.email or "").casefold() != EMAIL.casefold():
        fail(f"Identity mismatch for expected UID/email (actual email={user.email!r})")
    return user


def present(user, proposed, mode):
    claims = user.custom_claims or {}
    print(json.dumps({
        "project": PROJECT,
        "uid": user.uid,
        "email": user.email,
        "emailVerified": user.email_verified,
        "disabled": user.disabled,
        "currentPlatformAdmin": claims.get(CLAIM, False),
        "otherClaimNames": sorted(k for k in claims if k != CLAIM),
        "proposedPlatformAdmin": proposed.get(CLAIM, False),
        "mode": mode,
        "eligible": not user.disabled and user.email_verified,
    }, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", help="default; show proposed grant")
    group.add_argument("--grant", action="store_true", help="interactively grant the claim")
    group.add_argument("--verify", action="store_true", help="verify current identity and claim")
    group.add_argument("--revoke", action="store_true", help="interactively remove only platformAdmin")
    args = parser.parse_args()
    mode = "grant" if args.grant else "revoke" if args.revoke else "verify" if args.verify else "dry-run"
    app = get_app()
    user = verified_user(app)
    existing = dict(user.custom_claims or {})
    proposed = dict(existing)
    if mode in ("grant", "dry-run"):
        proposed[CLAIM] = True
    elif mode == "revoke":
        proposed.pop(CLAIM, None)
    present(user, proposed, mode)
    if mode in ("dry-run", "verify"):
        return
    if user.disabled or not user.email_verified:
        fail("Staff user must be enabled and email-verified before provisioning")
    if mode == "grant" and existing.get(CLAIM) is True:
        print("Already provisioned; no write performed.")
        return
    if mode == "revoke" and CLAIM not in existing:
        print("Claim already absent; no write performed.")
        return
    expected = f"{PROJECT} {EMAIL} {UID} {CLAIM}={str(mode == 'grant').lower()}"
    print(f"To authorize, type exactly: {expected}")
    if getpass.getpass("Confirmation: ") != expected:
        fail("Confirmation did not match; no write performed")
    # Re-read and revalidate immediately before the replacement write.
    user = verified_user(app)
    latest = dict(user.custom_claims or {})
    if latest != existing:
        fail("Claims changed since review; rerun dry-run and review again")
    if mode == "grant":
        latest[CLAIM] = True
    else:
        latest.pop(CLAIM, None)
    auth.set_custom_user_claims(user.uid, latest, app=app)
    verified = verified_user(app)
    actual = dict(verified.custom_claims or {})
    if actual != latest:
        fail("Post-write claim verification mismatch")
    print(json.dumps({"write": "verified", "platformAdmin": actual.get(CLAIM, False),
                      "otherClaimNames": sorted(k for k in actual if k != CLAIM)}, indent=2))


if __name__ == "__main__":
    main()
