#!/usr/bin/env python3
"""Seed the SmartWatts NFC Owner/Tenant demo fixture into the LOCAL Firebase Emulator Suite.

Default is a read-only dry-run preview. Nothing is written without --apply (or --rollback).

    # emulators must already be running (see docs/demo-data.md), then:
    export FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9399
    backend/.venv/bin/python scripts/seed_demo_data.py --project demo-smartwatts                 # preview
    backend/.venv/bin/python scripts/seed_demo_data.py --project demo-smartwatts --create-emulator-accounts --apply
    backend/.venv/bin/python scripts/seed_demo_data.py --project demo-smartwatts --rollback

Safety: refuses any project that is not a Firebase "demo-" project, refuses unless BOTH emulator hosts
point at this machine, ignores .env and Application Default Credentials, never sets custom claims,
and blocks email delivery for the whole run. Production seeding is intentionally unsupported.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FIXTURE = ROOT / "fixtures" / "smartwatts_nfc_demo_data.json"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
ROLES = ("platformStaff", "owner", "tenant")


class TargetError(SystemExit):
    def __init__(self, message: str) -> None:
        super().__init__(f"REFUSED: {message}")


def _host_of(value: str) -> str:
    value = value.strip()
    if value.startswith("["):
        return value[: value.index("]") + 1]
    return value.rsplit(":", 1)[0]


def validate_target(project: str, environ: dict[str, str] | os._Environ = os.environ) -> dict[str, str]:
    """Returns the emulator endpoints, or raises TargetError. Pure: safe to unit-test."""
    if not project.startswith("demo-"):
        raise TargetError(f"project {project!r} is not a Firebase demo project (must start with 'demo-'). "
                          "Seeding real projects, including production, is not supported by this script.")
    hosts = {}
    for var in ("FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"):
        value = (environ.get(var) or "").strip()
        if not value:
            raise TargetError(f"{var} is not set; this script only writes to the local Firebase Emulator Suite.")
        if _host_of(value) not in LOCAL_HOSTS:
            raise TargetError(f"{var}={value!r} is not a local emulator address.")
        hosts[var] = value
    return hosts


class EmulatorAuth:
    """Minimal Auth emulator REST client (the emulator accepts 'Bearer owner' as an admin token)."""

    def __init__(self, host: str, project: str) -> None:
        self.base = f"http://{host}/identitytoolkit.googleapis.com/v1/projects/{project}"

    def _post(self, path: str, body: dict) -> dict:
        request = urllib.request.Request(f"{self.base}{path}", data=json.dumps(body).encode(), method="POST",
                                         headers={"Authorization": "Bearer owner", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            raise SystemExit(f"Auth emulator error {error.code} on {path}: {error.read()[:300]!r}") from error
        except urllib.error.URLError as error:
            raise SystemExit(f"Auth emulator is not reachable at {self.base}: {error.reason}") from error

    def lookup(self, email: str) -> dict | None:
        users = self._post("/accounts:lookup", {"email": [email]}).get("users") or []
        exact = [u for u in users if (u.get("email") or "").lower() == email.lower()]
        if len(exact) > 1:
            raise SystemExit(f"More than one emulator account uses {email}; resolve this manually.")
        return exact[0] if exact else None

    def create(self, email: str, password: str, display_name: str, uid: str | None) -> dict:
        body = {"email": email, "password": password, "displayName": display_name, "emailVerified": True}
        if uid:
            body["localId"] = uid
        created = self._post("/accounts", body)
        # The create call ignores emailVerified on some emulator versions; set it explicitly.
        self._post("/accounts:update", {"localId": created["localId"], "emailVerified": True})
        return self.lookup(email) or {}


def parse_expected_uids(values: list[str]) -> dict[str, str]:
    expected = {}
    for item in values:
        role, _, uid = item.partition("=")
        if role not in ROLES or not uid:
            raise SystemExit(f"--expect-uid must look like owner=<uid>, tenant=<uid> or platformStaff=<uid>; got {item!r}")
        expected[role] = uid
    return expected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="Firebase demo project id, e.g. demo-smartwatts")
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="write the fixture (default is a dry-run preview)")
    mode.add_argument("--rollback", action="store_true", help="delete fixture-owned records only")
    parser.add_argument("--create-emulator-accounts", action="store_true",
                        help="create missing staff/owner/tenant accounts in the Auth EMULATOR (email-verified, no custom claims)")
    parser.add_argument("--expect-uid", action="append", default=[], metavar="ROLE=UID",
                        help="fail unless the resolved account has exactly this UID (also used as the UID when creating)")
    parser.add_argument("--grant-days", type=int, default=30, help="length of the fixture administrative grant (1-90 days)")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON only")
    args = parser.parse_args(argv)
    if not 1 <= args.grant_days <= 90:
        raise SystemExit("--grant-days must be between 1 and 90.")

    hosts = validate_target(args.project)
    # Never pick up real credentials or project settings: the emulator needs neither.
    for var in ("GOOGLE_APPLICATION_CREDENTIALS", "SMTP_USER", "SMTP_PASSWORD"):
        os.environ.pop(var, None)
    os.environ["EMAIL_DELIVERY"] = "disabled"
    os.environ["GCLOUD_PROJECT"] = os.environ["FIREBASE_PROJECT_ID"] = args.project
    sys.path.insert(0, str(ROOT / "backend"))

    from google.cloud import firestore  # noqa: E402  (imported after the environment is locked down)

    from app.rentals.demo_seed import Account, DemoSeeder, SeedError, load_fixture  # noqa: E402
    from app.rentals.store import FirestoreStore  # noqa: E402

    fixture = load_fixture(args.fixture)
    expected = parse_expected_uids(args.expect_uid)
    auth = EmulatorAuth(hosts["FIREBASE_AUTH_EMULATOR_HOST"], args.project)
    password = os.environ.get("DEMO_EMULATOR_PASSWORD") or "smartwatts-demo-emulator"
    created_accounts = []
    accounts: dict[str, Account] = {}
    for role in ROLES:
        email = fixture["identities"][role]["email"]
        record = auth.lookup(email)
        if record is None and args.create_emulator_accounts and args.apply:
            names = {"platformStaff": "SmartWatts Staff (demo)", "owner": "Demo Owner", "tenant": "Demo Tenant"}
            record = auth.create(email, password, names[role], expected.get(role))
            created_accounts.append(email)
        if record is None and args.create_emulator_accounts and not args.apply and not args.rollback:
            # Dry run: preview with a clearly marked placeholder; nothing is created.
            accounts[role] = Account(role, email, f"(created on --apply: {role})", True)
            continue
        if record is None:
            if role == "platformStaff":
                continue  # optional: only needed to show the staff experience
            hint = " (add --create-emulator-accounts --apply)" if not args.rollback else ""
            raise SystemExit(f"No Auth emulator account for {email}{hint}.")
        if role in expected and record["localId"] != expected[role]:
            raise SystemExit(f"{role} {email} resolved to UID {record['localId']}, expected {expected[role]}.")
        if role == "platformStaff" and "platformAdmin" in (record.get("customAttributes") or ""):
            print("note: the staff emulator account already carries a platformAdmin claim; this script does not change it.",
                  file=sys.stderr)
        accounts[role] = Account(role, record["email"], record["localId"], bool(record.get("emailVerified")),
                                 bool(record.get("disabled")))

    store = FirestoreStore(firestore.Client(project=args.project))
    try:
        seeder = DemoSeeder(store, fixture, {r: a for r, a in accounts.items() if r in ("owner", "tenant")},
                            grant_days=args.grant_days)
        if args.rollback:
            result = seeder.rollback()
        elif args.apply:
            result = seeder.apply()
        else:
            result = {"result": "dry-run (nothing written)", "preview": seeder.preview()}
    except SeedError as error:
        print(f"SEED FAILED: {error}", file=sys.stderr)
        return 1
    result["target"] = {"project": args.project, **hosts}
    result["accounts"] = {r: {"email": a.email, "uid": a.uid} for r, a in accounts.items()}
    if created_accounts:
        result["emulatorAccountsCreated"] = created_accounts
        result["emulatorPassword"] = "value of DEMO_EMULATOR_PASSWORD" if os.environ.get("DEMO_EMULATOR_PASSWORD") else password
    print(json.dumps(result, indent=None if args.json else 2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
