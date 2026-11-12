"""Demo-fixture seed: validation, idempotency, dashboard data through the real API, privacy, mail safety, rollback."""

import copy
import importlib.util
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import require_user
from app.main import app
from app.notifications.service import notification_service
from app.rentals.demo_seed import SEED_OPERATOR_UID, Account, DemoSeeder, SeedError, load_fixture, validate_fixture
from app.rentals.router import get_service
from app.rentals.store import InMemoryStore
from test_rentals_api import auth, fake_user, ok

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = load_fixture(ROOT / "fixtures" / "smartwatts_nfc_demo_data.json")
NOW = datetime(2026, 11, 13, 4, 0, tzinfo=UTC)
OWNER_EMAIL, TENANT_EMAIL = "rolexesto0001@gmail.com", "rolexesto001@gmail.com"
ACCOUNTS = {
    "owner": Account("owner", OWNER_EMAIL, "emu-owner-uid", True),
    "tenant": Account("tenant", TENANT_EMAIL, "emu-tenant-uid", True),
}
OWNER = auth("emu-owner-uid", email=OWNER_EMAIL)
TENANT = auth("emu-tenant-uid", email=TENANT_EMAIL)
STAFF_NO_CLAIM = auth("emu-staff-uid", email="schoolproware@gmail.com")
STRANGER = auth("emu-stranger")


def seeder(store, fixture=FIXTURE, accounts=ACCOUNTS):
    return DemoSeeder(store, fixture, accounts, clock=lambda: NOW)


@pytest.fixture()
def seeded():
    store = InMemoryStore()
    result = seeder(store).apply()
    service = seeder(store).service
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[require_user] = fake_user
    app.dependency_overrides[get_service] = lambda: service
    yield TestClient(app), result["propertyId"], store, result
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def base(pid):
    return f"/api/rentals/properties/{pid}"


# ------------------------------------------------------------------ validation
def test_supplied_fixture_is_internally_consistent():
    plan = validate_fixture(FIXTURE, NOW.date())
    assert plan["rate"] == 11
    totals = {b["periodStart"][:7]: (sum(m["kwh"] for m in b["meters"]), sum(m["amountCentavos"] for m in b["meters"])) for b in plan["bills"]}
    assert totals == {"2026-08": (203, 223300), "2026-09": (218, 239800), "2026-10": (224, 246400)}


@pytest.mark.parametrize("mutate, message", [
    (lambda f: f["property"]["meterReadings"][1].update(readingKwh=1349), "billedKwh 203 != sum of meter intervals 204"),
    (lambda f: f["property"]["utilityBills"][0].update(amountDuePhp=2000), "amountDuePhp 2000 != billedKwh x illustrative rate"),
    (lambda f: f["property"]["units"][1].update(tenantEmail="someone@example.com"), "a vacant unit cannot have a tenant"),
    (lambda f: f["property"]["meterReadings"][2].update(readingKwh=1000), "readings go backwards"),
    (lambda f: f["property"]["tenantStatements"][0].update(meteredKwh=150), "meteredKwh 150 != meter interval 148"),
    (lambda f: f["property"]["utilityBills"][0].update(paymentStatus="paid"), "no payment confirmation exists"),
    (lambda f: f["property"]["meters"][0].update(unitFixtureId="unit-999"), "unknown unit"),
    (lambda f: f["environmentPolicy"].update(productionWritesAllowed=True), "productionWritesAllowed must be false"),
    (lambda f: f["identities"]["platformStaff"].update(seedStaffClaims=True), "staff claims are never seeded"),
    (lambda f: f["property"].update(meteringModel="shared"), "only the individually-metered model"),
])
def test_invalid_fixtures_are_rejected_before_any_write(mutate, message):
    broken = copy.deepcopy(FIXTURE)
    mutate(broken)
    store = InMemoryStore()
    with pytest.raises(SeedError, match=message):
        seeder(store, broken)
    assert store.query("properties") == []


def test_future_dated_fixture_is_rejected():
    with pytest.raises(SeedError, match="in the future"):
        validate_fixture(FIXTURE, datetime(2026, 10, 15).date())


@pytest.mark.parametrize("accounts, message", [
    ({"owner": ACCOUNTS["owner"]}, "No tenant account"),
    ({**ACCOUNTS, "tenant": Account("tenant", "other@example.com", "x", True)}, "does not match the fixture"),
    ({**ACCOUNTS, "tenant": Account("tenant", TENANT_EMAIL, "x", False)}, "must be enabled and email-verified"),
    ({**ACCOUNTS, "tenant": Account("tenant", TENANT_EMAIL, "emu-owner-uid", True)}, "same UID"),
])
def test_exact_account_verification(accounts, message):
    with pytest.raises(SeedError, match=message):
        seeder(InMemoryStore(), accounts=accounts)


# ------------------------------------------------------------------ import + idempotency
def test_import_creates_exact_records_and_rerun_is_a_no_op(seeded):
    _, pid, store, result = seeded
    assert result["created"] == {
        "properties": 1, "units": 2, "meters": 2, "meterAssignments": 2, "meterReadings": 8, "utilityBills": 6,
        "publishedStatements": 3, "tenantMemberships": 1, "occupancies": 1, "subscription": "active (administrative_grant)",
    }
    snapshot = {name: len(docs) for name, docs in store._data.items()}
    again = seeder(store).apply()
    assert again == {"result": "already-seeded", "propertyId": pid, "created": {}}
    assert {name: len(docs) for name, docs in store._data.items()} == snapshot
    assert len(store.query("properties")) == 1


def test_incomplete_seed_is_detected_and_not_extended():
    store = InMemoryStore()
    store.create("properties", "half", {"name": "x", "demoFixtureId": FIXTURE["property"]["fixtureId"], "seedStatus": "in_progress"})
    with pytest.raises(SeedError, match="Run with --rollback first"):
        seeder(store).apply()
    assert len(store.query("properties")) == 1


def test_subscription_uses_the_normal_audited_grant_without_claims(seeded):
    _, pid, store, _ = seeded
    sub = store.get("subscriptions", pid)
    assert sub["status"] == "active" and sub["activationSource"] == "administrative_grant" and sub["decidedBy"] == SEED_OPERATOR_UID
    actions = sorted(e["action"] for e in store.query("subscriptionEvents", propertyId=pid))
    assert actions == ["approve", "request"]
    assert sub["currentPeriodEnd"].startswith("2026-12-13")


def test_tenant_membership_comes_from_a_redeemed_email_restricted_invitation(seeded):
    _, pid, store, _ = seeded
    [invitation] = store.query("invitations", propertyId=pid)
    assert invitation["email"] == TENANT_EMAIL and invitation["status"] == "accepted" and invitation["acceptedBy"] == "emu-tenant-uid"
    membership = store.get("memberships", f"{pid}_emu-tenant-uid")
    unit = store.get(f"properties/{pid}/units", membership["unitId"])
    assert membership["role"] == "tenant" and unit["label"] == "Unit 101"


# ------------------------------------------------------------------ owner dashboard data (real API)
def test_owner_dashboard_values_match_the_fixture(seeded):
    client, pid, _, _ = seeded
    prop = ok(client.get(base(pid), headers=OWNER))
    assert prop["name"] == "SmartWatts Demo Residences" and prop["demoLabel"] == FIXTURE["demoLabel"]
    a = ok(client.get(f"{base(pid)}/analytics", headers=OWNER))
    assert (a["unitCount"], a["occupiedUnitCount"], a["vacantUnitCount"], a["meterCount"]) == (2, 1, 1, 2)
    assert a["totalOfficialBilledWh"] == 645_000 and a["totalOfficialBilledCentavos"] == 709_500
    assert a["totalTenantBilledCentavos"] == 528_000 and a["totalTenantMeasuredWh"] == 480_000
    assert a["totalTenantAllocatedWh"] == 0  # nothing estimated from a shared meter
    assert a["missingReadingsAlerts"] == []
    bills = ok(client.get(f"{base(pid)}/utility-bills", headers=OWNER))
    assert len(bills) == 6 and all(b["verification"] == "owner_entered" for b in bills)
    assert not any("paid" in str(b.get("status")) for b in bills)  # recorded amounts, no payment status
    readings = ok(client.get(f"{base(pid)}/readings", headers=OWNER))
    assert len(readings) == 8
    statements = ok(client.get(f"{base(pid)}/statements", headers=OWNER))
    assert sorted(s["totalCentavos"] for s in statements) == [162_800, 176_000, 189_200]
    assert {s["status"] for s in statements} == {"finalized"}


def test_period_over_period_compares_whole_property_totals_not_different_meters(seeded):
    client, pid, _, _ = seeded
    pop = ok(client.get(f"{base(pid)}/analytics", headers=OWNER))["periodOverPeriod"]
    # October (172 + 52 = 224 kWh, P2,464) vs September (160 + 58 = 218 kWh, P2,398).
    assert pop == {"currentPeriod": "2026-10-01 to 2026-10-31", "previousPeriod": "2026-09-01 to 2026-09-30",
                   "kwhChange": 6.0, "kwhChangePercent": 2.8, "costChangeCentavos": 6_600, "costChangePercent": 2.8,
                   "meterCount": 2}


@pytest.mark.parametrize("date_from, date_to, periods, centavos", [
    ("2026-08-01", "2026-10-31", 6, 709_500),
    ("2026-09-01", "2026-09-30", 2, 239_800),
    ("2026-10-01", "2026-10-31", 2, 246_400),
    ("2027-01-01", "2027-03-31", 0, 0),  # empty state
])
def test_owner_analytics_date_filters(seeded, date_from, date_to, periods, centavos):
    client, pid, _, _ = seeded
    a = ok(client.get(f"{base(pid)}/analytics?from={date_from}&to={date_to}", headers=OWNER))
    assert len(a["bills"]) == periods and a["totalOfficialBilledCentavos"] == centavos


def test_vacant_meter_bills_are_owner_borne_not_tenant_statements(seeded):
    client, pid, store, _ = seeded
    units = {u["label"]: u["id"] for u in store.query(f"properties/{pid}/units")}
    statements = store.query(f"properties/{pid}/statements")
    assert {s["unitId"] for s in statements} == {units["Unit 101"]}
    runs = store.query(f"properties/{pid}/billingRuns")
    owner_borne = [o for r in runs for o in r["ownerBorne"]]
    assert sorted(o["amountCentavos"] for o in owner_borne) == [57_200, 60_500, 63_800]
    assert {o["reason"] for o in owner_borne} == {"Vacant unit"}


# ------------------------------------------------------------------ tenant dashboard data + privacy
def test_tenant_sees_only_unit_101_records(seeded):
    client, pid, _, _ = seeded
    [m] = ok(client.get("/api/account/workspaces", headers=TENANT))["rentalMemberships"]
    assert (m["role"], m["unitLabel"], m["demoLabel"]) == ("tenant", "Unit 101", FIXTURE["demoLabel"])
    unit = ok(client.get(f"{base(pid)}/me/unit", headers=TENANT))
    assert unit["unitLabel"] == "Unit 101" and [x["label"] for x in unit["meters"]] == ["Meter 101"]
    history = ok(client.get(f"{base(pid)}/me/meter-history", headers=TENANT))
    assert {r["meterLabel"] for r in history} == {"Meter 101"}
    assert sorted(r["valueWh"] for r in history) == [1_200_000, 1_348_000, 1_508_000, 1_680_000]
    statements = ok(client.get(f"{base(pid)}/me/statements", headers=TENANT))
    assert [(s["periodStart"], s["totalCentavos"]) for s in statements] == [
        ("2026-10-01", 189_200), ("2026-09-01", 176_000), ("2026-08-01", 162_800)]
    assert all(s["lines"][0]["wh"] in (148_000, 160_000, 172_000) for s in statements)
    assert "sourceReadingIds" not in statements[0]


def test_tenant_cannot_reach_owner_or_vacant_unit_records(seeded):
    client, pid, store, _ = seeded
    for path in ("/units", "/meters", "/readings", "/review-requests", "/utility-bills", "/statements", "/analytics",
                 "/subscription", "/audit-logs", "/members", "/invitations"):
        assert client.get(f"{base(pid)}{path}", headers=TENANT).status_code == 403, path
    vacant = next(u for u in store.query(f"properties/{pid}/units") if u["label"] == "Unit 102")
    assert client.get(f"{base(pid)}/history?unitId={vacant['id']}", headers=TENANT).status_code == 403
    # The tenant's own history never contains the vacant unit, its meter, or the owner-borne amounts.
    assert client.get(f"{base(pid)}/me/history?unitId={vacant['id']}", headers=TENANT).status_code == 404
    own = client.get(f"{base(pid)}/me/history", headers=TENANT)
    assert own.status_code == 200 and own.json()["records"], own.text
    assert vacant["id"] not in own.text and "Meter 102" not in own.text
    assert "60500" not in own.text and "57200" not in own.text and "63800" not in own.text


def test_unauthenticated_strangers_and_unclaimed_staff_are_denied(seeded):
    client, pid, _, _ = seeded
    assert client.get(f"{base(pid)}/analytics").status_code == 401
    assert client.get("/api/account/workspaces").status_code == 401
    for headers in (STRANGER, STAFF_NO_CLAIM):
        assert client.get(f"{base(pid)}/analytics", headers=headers).status_code == 404
        assert ok(client.get("/api/account/workspaces", headers=headers))["rentalMemberships"] == []
    # The staff account has no platformAdmin claim from the seed: staff tools stay locked.
    assert ok(client.get("/api/platform/me", headers=STAFF_NO_CLAIM))["platformAdmin"] is False
    assert client.get("/api/platform/subscriptions", headers=STAFF_NO_CLAIM).status_code == 403


def test_owner_workspace_entry_routes_nfc_to_the_demo_property(seeded):
    client, pid, _, _ = seeded
    [m] = ok(client.get("/api/account/workspaces", headers=OWNER))["rentalMemberships"]
    assert (m["propertyId"], m["role"], m["lifecycle"]) == (pid, "owner", "active")


def test_non_demo_properties_have_no_demo_label(seeded):
    client, _, _, _ = seeded
    other = ok(client.post("/api/rentals/properties", headers=STRANGER, json={"name": "Real Place", "address": "1 Real St"}), 201)
    assert "demoLabel" not in other
    [m] = ok(client.get("/api/account/workspaces", headers=STRANGER))["rentalMemberships"]
    assert "demoLabel" not in m


# ------------------------------------------------------------------ email safety
def test_seeding_never_delivers_email_and_restores_the_outbox(seeded):
    _, _, _, result = seeded
    assert result["email"]["delivered"] == 0 and result["email"]["deliveryAttempts"] == 0
    assert result["email"]["queuedInSandbox"] == 9  # 6 bill confirmations + 3 statements, discarded with the sandbox
    # Nothing leaked into the real (process-wide) outbox, and the real sender was restored afterwards.
    leaked = [i for i in notification_service.store.query("notifications_outbox") if i.get("to_email") in (OWNER_EMAIL, TENANT_EMAIL)]
    assert leaked == []
    assert type(notification_service.email_sender).__name__ != "_BlockedSender"


def test_email_delivery_kill_switch_blocks_the_mailer(monkeypatch):
    from fastapi import HTTPException

    from app import email_otp

    calls = []
    monkeypatch.setenv("EMAIL_DELIVERY", "disabled")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a))
    with pytest.raises(HTTPException) as error:
        email_otp.send_email("statement-published", TENANT_EMAIL, {})
    assert error.value.status_code == 503 and calls == []


# ------------------------------------------------------------------ rollback
def test_rollback_removes_only_fixture_records(seeded):
    client, pid, store, _ = seeded
    other = ok(client.post("/api/rentals/properties", headers=STRANGER, json={"name": "Customer Place", "address": "2 Real St"}), 201)
    result = seeder(store).rollback()
    assert result["result"] == "rolled-back" and result["propertyIds"] == [pid]
    assert [p["id"] for p in store.query("properties")] == [other["id"]]
    assert store.get("subscriptions", other["id"]) is not None
    for name in ("memberships", "invitations", "subscriptionEvents", "rentalNotifications"):
        assert store.query(name, propertyId=pid) == []
    assert store.query(f"properties/{pid}/statements") == []
    assert seeder(store).rollback()["result"] == "nothing-to-roll-back"
    assert seeder(store).apply()["result"] == "seeded"  # clean re-seed after rollback


def test_rollback_refuses_when_non_fixture_members_joined(seeded):
    _, pid, store, _ = seeded
    store.create("memberships", f"{pid}_someone", {"propertyId": pid, "uid": "someone", "role": "admin", "status": "active"})
    with pytest.raises(SeedError, match="non-fixture members"):
        seeder(store).rollback()
    assert store.get("properties", pid) is not None


# ------------------------------------------------------------------ CLI target guard
def _cli():
    spec = importlib.util.spec_from_file_location("seed_demo_data", ROOT / "scripts" / "seed_demo_data.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LOCAL = {"FIRESTORE_EMULATOR_HOST": "127.0.0.1:8380", "FIREBASE_AUTH_EMULATOR_HOST": "localhost:9399"}


@pytest.mark.parametrize("project, environ, message", [
    ("smartwatts-266cc", LOCAL, "not a Firebase demo project"),
    ("demo-smartwatts", {}, "FIRESTORE_EMULATOR_HOST is not set"),
    ("demo-smartwatts", {"FIRESTORE_EMULATOR_HOST": "127.0.0.1:8380"}, "FIREBASE_AUTH_EMULATOR_HOST is not set"),
    ("demo-smartwatts", {**LOCAL, "FIRESTORE_EMULATOR_HOST": "10.0.0.5:8080"}, "not a local emulator address"),
    ("demo-smartwatts", {**LOCAL, "FIREBASE_AUTH_EMULATOR_HOST": "firestore.googleapis.com:443"}, "not a local emulator address"),
])
def test_cli_refuses_non_emulator_targets(project, environ, message):
    cli = _cli()
    with pytest.raises(SystemExit, match=message):
        cli.validate_target(project, environ)


def test_cli_accepts_local_emulators():
    assert _cli().validate_target("demo-smartwatts", LOCAL) == LOCAL
