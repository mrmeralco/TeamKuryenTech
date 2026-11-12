"""End-to-end API tests for SmartWatts Rentals authorization and billing workflows."""

from datetime import UTC, datetime, timedelta
from typing import Annotated

import pytest
from fastapi import Header, HTTPException
from fastapi.testclient import TestClient

from app.auth import AuthUser, require_user
from app.main import app
from app.rentals.config import RentalsConfig
from app.rentals.router import get_service
from app.rentals.service import RentalService
from app.rentals.store import InMemoryBlobStore, InMemoryStore


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 15, 8, 0, tzinfo=UTC)

    def __call__(self):
        return self.now


def fake_user(authorization: Annotated[str | None, Header()] = None) -> AuthUser:
    # Test token format: "Bearer uid|provider|email|verified|admin"
    if not authorization:
        raise HTTPException(status_code=401, detail="A Firebase sign-in is required.")
    uid, provider, email, verified, admin = authorization.removeprefix("Bearer ").split("|")
    return AuthUser(uid, provider, email or None, verified == "1", admin == "1")


def auth(uid, provider="password", email=None, verified=True, admin=False):
    return {"Authorization": f"Bearer {uid}|{provider}|{email or f'{uid}@example.com'}|{int(verified)}|{int(admin)}"}


OWNER, OWNER2, TENANT, TENANT2, STRANGER = auth("owner"), auth("owner2"), auth("tenant"), auth("tenant2"), auth("stranger")
STAFF = auth("staff", admin=True)
ANON = auth("anon", provider="anonymous", email="")


@pytest.fixture()
def env():
    clock = Clock()
    service = RentalService(InMemoryStore(), RentalsConfig(), blobs=InMemoryBlobStore(), clock=clock)
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[require_user] = fake_user
    app.dependency_overrides[get_service] = lambda: service
    yield TestClient(app), clock, service
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def make_property(client, headers=OWNER, activate=True, name="Sunrise Apartments"):
    prop = ok(client.post("/api/rentals/properties", headers=headers, json={"name": name, "address": "1 Rizal St, Quezon City"}), 201)
    if activate:
        activate_property(client, prop["id"], owner_headers=headers)
    return prop["id"]


def activate_property(client, pid, owner_headers=OWNER, period_end="2026-11-15"):
    """Owner requests activation; a platform administrator approves it as an administrative grant."""
    current = ok(client.get(f"/api/platform/subscriptions/{pid}", headers=STAFF))
    if current["status"] != "pending_activation":
        ok(client.post(f"/api/rentals/properties/{pid}/subscription/request-activation", headers=owner_headers))
        current = ok(client.get(f"/api/platform/subscriptions/{pid}", headers=STAFF))
    return ok(client.post(f"/api/platform/subscriptions/{pid}/approve", headers=STAFF, json={
        "confirm": True, "expectedVersion": current["version"], "activationSource": "administrative_grant",
        "reason": "Test fixture grant approved by platform staff.", "periodEnd": period_end,
    }))


def base(pid):
    return f"/api/rentals/properties/{pid}"


def publish(client, pid, statement_id, headers=OWNER):
    """Draft → Reviewed → Published."""
    ok(client.post(f"{base(pid)}/statements/{statement_id}/review", headers=headers))
    return ok(client.post(f"{base(pid)}/statements/{statement_id}/finalize", headers=headers))


def invite_tenant(client, pid, unit_id, tenant_headers=TENANT, move_in="2026-01-01", headers=OWNER):
    invite = ok(client.post(f"{base(pid)}/invitations", headers=headers, json={"role": "tenant", "unitId": unit_id, "moveInDate": move_in}), 201)
    ok(client.post("/api/rentals/invitations/accept", headers=tenant_headers, json={"token": invite["token"]}))
    return invite


# ---------------------------------------------------------------- accounts
def test_new_user_defaults_to_free_personal_tier_with_no_global_rental_tier(env):
    client, _, _ = env
    body = ok(client.get("/api/account/workspaces", headers=ANON))
    assert body["personal"] == {"tier": 1, "plan": "personal", "name": "SmartWatts Personal", "priceCentavos": 0}
    assert body["rentalMemberships"] == [] and body["canCreateProperty"] is False


def test_anonymous_accounts_cannot_use_rentals_but_upgraded_uid_can(env):
    client, _, _ = env
    assert client.post("/api/rentals/properties", headers=ANON, json={"name": "X", "address": "Y"}).status_code == 403
    upgraded = auth("anon", provider="password", email="anon@example.com")  # same uid after linkWithCredential
    assert client.post("/api/rentals/properties", headers=upgraded, json={"name": "Home", "address": "Addr"}).status_code == 201
    body = ok(client.get("/api/account/workspaces", headers=upgraded))
    assert body["rentalMemberships"][0]["role"] == "owner"


# ---------------------------------------------------- authorization basics
def test_owner_authorization_and_cross_property_isolation(env):
    client, _, _ = env
    pid1 = make_property(client, OWNER)
    pid2 = make_property(client, OWNER2, name="Other Place")
    unit = ok(client.post(f"{base(pid1)}/units", headers=OWNER, json={"label": "1A"}), 201)
    # Owner 2 and strangers cannot see or modify property 1 (404 hides existence).
    for headers in (OWNER2, STRANGER):
        assert client.get(f"{base(pid1)}/units", headers=headers).status_code == 404
        assert client.post(f"{base(pid1)}/units", headers=headers, json={"label": "X"}).status_code == 404
        assert client.get(f"{base(pid1)}/audit-logs", headers=headers).status_code == 404
    assert [u["id"] for u in ok(client.get(f"{base(pid1)}/units", headers=OWNER))] == [unit["id"]]
    assert ok(client.get(f"{base(pid2)}/units", headers=OWNER2)) == []


def test_unit_limit_is_enforced_from_property_subscription(env):
    client, _, _ = env
    pid = make_property(client)
    for index in range(10):
        ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": f"Unit {index}"}), 201)
    response = client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Unit 11"})
    assert response.status_code == 402 and "10 units" in response.json()["detail"]


# -------------------------------------------------------- subscriptions
def test_inactive_and_expired_subscription_block_writes_but_keep_reads(env):
    client, clock, _ = env
    pid = make_property(client, activate=False)
    # Draft setup is free: units can be configured, but operational workflows need activation.
    draft_unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Draft 1"}), 201)
    assert client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": draft_unit["id"]}).status_code == 402
    assert client.get(f"{base(pid)}/units", headers=OWNER).status_code == 200
    # Owners can request activation but cannot activate themselves.
    ok(client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER))
    assert client.post(f"/api/platform/subscriptions/{pid}/approve", headers=OWNER, json={
        "confirm": True, "expectedVersion": 1, "activationSource": "administrative_grant", "reason": "Trying to self-approve", "periodEnd": "2026-11-15",
    }).status_code == 403
    activate_property(client, pid)
    ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    clock.now += timedelta(days=40)
    sub = ok(client.get(f"{base(pid)}/subscription", headers=OWNER))
    assert sub["status"] == "expired" and sub["active"] is False and sub["paymentsEnabled"] is False
    assert client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1B"}).status_code == 402
    assert sub["lifecycle"] == "expired"
    assert len(ok(client.get(f"{base(pid)}/units", headers=OWNER))) == 2


# ------------------------------------------------- invitations & members
def test_tenant_invitation_acceptance_and_revocation(env):
    client, _, service = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    invite = ok(client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": unit["id"], "moveInDate": "2026-10-01"}), 201)
    # Raw token is never stored.
    assert all(invite["token"] not in str(doc) for doc in service.store.query("invitations"))
    assert client.post("/api/rentals/invitations/accept", headers=ANON, json={"token": invite["token"]}).status_code == 403
    preview = ok(client.post("/api/rentals/invitations/preview", headers=TENANT, json={"token": invite["token"]}))
    assert preview["unitLabel"] == "1A"
    ok(client.post("/api/rentals/invitations/accept", headers=TENANT, json={"token": invite["token"]}))
    # Single use.
    assert client.post("/api/rentals/invitations/accept", headers=TENANT2, json={"token": invite["token"]}).status_code == 404
    assert ok(client.get(f"{base(pid)}/me/unit", headers=TENANT))["unitLabel"] == "1A"
    # Tenants cannot manage the property.
    assert client.get(f"{base(pid)}/units", headers=TENANT).status_code == 403
    assert client.post(f"{base(pid)}/units", headers=TENANT, json={"label": "X"}).status_code == 403
    ok(client.post(f"{base(pid)}/members/tenant/revoke", headers=OWNER))
    assert client.get(f"{base(pid)}/me/unit", headers=TENANT).status_code == 404
    occupancy = ok(client.get(f"{base(pid)}/members", headers=OWNER))["occupancies"][0]
    assert occupancy["endDate"] == "2026-10-15"


def test_pending_invitation_can_be_revoked_and_expires(env):
    client, clock, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    first = ok(client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": unit["id"]}), 201)
    ok(client.post(f"{base(pid)}/invitations/{first['id']}/revoke", headers=OWNER))
    assert client.post("/api/rentals/invitations/accept", headers=TENANT, json={"token": first["token"]}).status_code == 404
    second = ok(client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": unit["id"]}), 201)
    clock.now += timedelta(days=8)
    assert client.post("/api/rentals/invitations/accept", headers=TENANT, json={"token": second["token"]}).status_code == 404


def test_email_bound_invitation_requires_matching_verified_email(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    invite = ok(client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": unit["id"], "email": "Tenant@Example.com"}), 201)
    unverified = auth("tenant", email="tenant@example.com", verified=False)
    assert client.post("/api/rentals/invitations/accept", headers=unverified, json={"token": invite["token"]}).status_code == 403
    assert client.post("/api/rentals/invitations/accept", headers=TENANT2, json={"token": invite["token"]}).status_code == 403
    ok(client.post("/api/rentals/invitations/accept", headers=TENANT, json={"token": invite["token"]}))


def test_only_owner_invites_admins_and_admins_can_manage_bills(env):
    client, _, _ = env
    pid = make_property(client)
    admin_invite = ok(client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "admin"}), 201)
    ok(client.post("/api/rentals/invitations/accept", headers=auth("admin"), json={"token": admin_invite["token"]}))
    assert client.post(f"{base(pid)}/invitations", headers=auth("admin"), json={"role": "admin"}).status_code == 403
    meter = ok(client.post(f"{base(pid)}/meters", headers=auth("admin"), json={"label": "Main", "kind": "utility_shared"}), 201)
    ok(client.post(f"{base(pid)}/utility-bills", headers=auth("admin"), json={
        "meterId": meter["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "100", "amountCentavos": 150000,
    }), 201)
    assert client.post(f"{base(pid)}/members/owner/revoke", headers=auth("admin")).status_code == 403


# ------------------------------------------------------------ bills & meters
def test_only_owners_or_admins_upload_bills_and_documents(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    meter = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "M1", "kind": "utility_individual"}), 201)
    invite_tenant(client, pid, unit["id"])
    payload = {"meterId": meter["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "210.5", "amountCentavos": 245_050}
    assert client.post(f"{base(pid)}/utility-bills", headers=TENANT, json=payload).status_code == 403
    assert client.post(f"{base(pid)}/utility-bills", headers=STRANGER, json=payload).status_code == 404
    created = ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json=payload), 201)
    assert created["totalWh"] == 210_500
    url = f"{base(pid)}/utility-bills/{created['id']}/document"
    pdf = b"%PDF-1.4 test"
    assert client.put(url, headers={**TENANT, "Content-Type": "application/pdf"}, content=pdf).status_code == 403
    assert client.put(url, headers={**OWNER, "Content-Type": "application/pdf"}, content=b"<html>").status_code == 422
    ok(client.put(url, headers={**OWNER, "Content-Type": "application/pdf"}, content=pdf))
    assert client.get(url, headers=OWNER).content == pdf
    assert client.get(url, headers=TENANT).status_code == 403
    # Validation: overlapping bill, future period, inverted dates.
    assert client.post(f"{base(pid)}/utility-bills", headers=OWNER, json=payload).status_code == 409
    assert client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={**payload, "periodStart": "2026-10-10", "periodEnd": "2026-11-10"}).status_code == 422
    assert client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={**payload, "periodStart": "2026-08-30", "periodEnd": "2026-08-01"}).status_code == 422


def test_meter_assignments_reject_overlaps_and_shared_meter_assignment(env):
    client, _, _ = env
    pid = make_property(client)
    u1 = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    u2 = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1B"}), 201)
    meter = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "M1", "kind": "utility_individual"}), 201)
    shared = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "Main", "kind": "utility_shared"}), 201)
    assignment = ok(client.post(f"{base(pid)}/meter-assignments", headers=OWNER, json={"meterId": meter["id"], "unitId": u1["id"], "effectiveFrom": "2026-01-01"}), 201)
    assert client.post(f"{base(pid)}/meter-assignments", headers=OWNER, json={"meterId": meter["id"], "unitId": u2["id"], "effectiveFrom": "2026-06-01"}).status_code == 409
    ok(client.post(f"{base(pid)}/meter-assignments/{assignment['id']}/end", headers=OWNER, json={"effectiveTo": "2026-05-31"}))
    ok(client.post(f"{base(pid)}/meter-assignments", headers=OWNER, json={"meterId": meter["id"], "unitId": u2["id"], "effectiveFrom": "2026-06-01"}), 201)
    assert client.post(f"{base(pid)}/meter-assignments", headers=OWNER, json={"meterId": shared["id"], "unitId": u1["id"], "effectiveFrom": "2026-01-01"}).status_code == 422
    # Submeters must hang under a shared utility meter.
    assert client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "S", "kind": "private_submeter", "parentMeterId": meter["id"]}).status_code == 422


def test_allocation_requires_explicit_shares_and_legal_acknowledgement(env):
    client, _, _ = env
    pid = make_property(client)
    u1 = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    shared = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "Main", "kind": "utility_shared"}), 201)
    payload = {"meterId": shared["id"], "description": "Lease clause 4 assigns 100% of the hallway meter to unit 1A.",
               "shares": [{"unitId": u1["id"], "weight": 1}], "effectiveFrom": "2026-01-01"}
    assert client.post(f"{base(pid)}/allocation-agreements", headers=OWNER, json=payload).status_code == 422
    assert client.post(f"{base(pid)}/allocation-agreements", headers=OWNER, json={**payload, "acknowledgeLegalReview": True, "shares": []}).status_code == 422
    ok(client.post(f"{base(pid)}/allocation-agreements", headers=OWNER, json={**payload, "acknowledgeLegalReview": True}), 201)


# ------------------------------------------------------- readings & billing
def submeter_property(client):
    pid = make_property(client)
    units = [ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": label}), 201) for label in ("1A", "1B")]
    main = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "Main", "kind": "utility_shared"}), 201)
    subs = []
    for unit in units:
        sub = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": f"Sub {unit['label']}", "kind": "private_submeter", "parentMeterId": main["id"]}), 201)
        ok(client.post(f"{base(pid)}/meter-assignments", headers=OWNER, json={"meterId": sub["id"], "unitId": unit["id"], "effectiveFrom": "2026-01-01"}), 201)
        subs.append(sub)
    return pid, units, main, subs


def reading(client, pid, meter_id, day, kwh, **extra):
    return ok(client.post(f"{base(pid)}/readings", headers=OWNER, json={"meterId": meter_id, "readingDate": day, "valueKwh": kwh, "confirmed": True, **extra}), 201)


def test_reading_validation_and_correction_history(env):
    client, _, _ = env
    pid, _, _, (sub, _) = submeter_property(client)
    first = reading(client, pid, sub["id"], "2026-09-01", "1000")
    reading(client, pid, sub["id"], "2026-09-30", "1100", source="photo_ocr", ocrSuggestedKwh="1100")
    bad = {"meterId": sub["id"], "readingDate": "2026-10-05", "valueKwh": "900", "confirmed": True}
    assert client.post(f"{base(pid)}/readings", headers=OWNER, json=bad).status_code == 422  # goes backwards
    assert client.post(f"{base(pid)}/readings", headers=OWNER, json={**bad, "valueKwh": "1200", "confirmed": False}).status_code == 422
    assert client.post(f"{base(pid)}/readings", headers=OWNER, json={**bad, "valueKwh": "1200", "readingDate": "2026-12-01"}).status_code == 422
    assert client.post(f"{base(pid)}/readings", headers=OWNER, json={**bad, "valueKwh": "1200", "readingDate": "2026-09-01"}).status_code == 409
    assert client.post(f"{base(pid)}/readings", headers=TENANT, json={**bad, "valueKwh": "1200"}).status_code == 404
    corrected = ok(client.post(f"{base(pid)}/readings/{first['id']}/corrections", headers=OWNER, json={"valueKwh": "1010", "reason": "Misread digit"}), 201)
    assert corrected["supersedesId"] == first["id"] and corrected["valueWh"] == 1_010_000
    history = ok(client.get(f"{base(pid)}/readings", headers=OWNER, params={"meterId": sub["id"]}))
    statuses = {r["id"]: r["status"] for r in history}
    assert statuses[first["id"]] == "superseded" and statuses[corrected["id"]] == "active"
    assert client.post(f"{base(pid)}/readings/{first['id']}/corrections", headers=OWNER, json={"valueKwh": "1", "reason": "again!"}).status_code == 409


def test_historical_records_filter_and_tenant_occupancy_privacy(env):
    client, _, _ = env
    pid, (u1, u2), main, (sub1, sub2) = submeter_property(client)
    invite_tenant(client, pid, u1["id"], TENANT, move_in="2026-09-10")
    invite_tenant(client, pid, u2["id"], TENANT2, move_in="2026-09-01")
    reading(client, pid, sub1["id"], "2026-09-05", "10")  # before tenant occupancy
    reading(client, pid, sub1["id"], "2026-09-12", "20")
    reading(client, pid, sub2["id"], "2026-09-12", "30")
    owner_page = ok(client.get(f"{base(pid)}/history", headers=OWNER, params={"type": "reading", "start": "2026-09-10", "end": "2026-09-12", "limit": 1}))
    assert len(owner_page["records"]) == 1 and owner_page["nextCursor"] == "1"
    assert owner_page["total"] == 2
    tenant_page = ok(client.get(f"{base(pid)}/me/history", headers=TENANT, params={"type": "reading"}))
    assert [(r["unitId"], r["date"]) for r in tenant_page["records"]] == [(u1["id"], "2026-09-12")]
    assert client.get(f"{base(pid)}/history", headers=TENANT).status_code == 403
    assert client.get(f"{base(pid)}/me/history", headers=TENANT2, params={"unitId": u1["id"]}).status_code == 404
    assert client.get(f"{base(pid)}/history", headers=STRANGER).status_code == 404
    assert client.get(f"{base(pid)}/history", headers=OWNER, params={"limit": 1000}).status_code == 422


def test_submeter_statements_reconcile_finalize_and_tenant_sees_only_own(env):
    client, _, service = env
    pid, (u1, u2), main, (s1, s2) = submeter_property(client)
    invite_tenant(client, pid, u1["id"], TENANT)
    invite_tenant(client, pid, u2["id"], TENANT2)
    for sub, start, end in ((s1, "1000", "1150.5"), (s2, "500", "600")):
        reading(client, pid, sub["id"], "2026-09-01", start)
        reading(client, pid, sub["id"], "2026-09-30", end)
    bill = ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": main["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "400", "amountCentavos": 480_000,
    }), 201)
    run = ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    rec = run["reconciliation"]
    assert rec["balanced"] and rec["tenantChargesCentavos"] == 180_600 + 120_000
    assert rec["ownerBorneCentavos"] == 480_000 - 300_600  # no agreement -> common usage not charged
    statements = ok(client.get(f"{base(pid)}/statements", headers=OWNER))
    assert len(statements) == 2 and all(s["status"] == "draft" for s in statements)
    # Tenants see nothing until finalized.
    assert ok(client.get(f"{base(pid)}/me/statements", headers=TENANT)) == []
    for statement in statements:
        publish(client, pid, statement['id'])
    mine = ok(client.get(f"{base(pid)}/me/statements", headers=TENANT))
    assert len(mine) == 1 and mine[0]["totalCentavos"] == 180_600
    assert mine[0]["lines"][0]["chargeBasis"] == "private_submeter_consumption"
    assert mine[0]["utilityBill"]["amountCentavos"] == 480_000
    assert "legal" in mine[0]["legalReviewNotice"].lower()
    history = ok(client.get(f"{base(pid)}/me/meter-history", headers=TENANT))
    assert {h["meterLabel"] for h in history} == {"Sub 1A"}
    # Finalized statements are immutable: cannot finalize twice.
    assert client.post(f"{base(pid)}/statements/{mine[0]['id']}/finalize", headers=OWNER).status_code == 409
    # Regenerating creates version 2 drafts that supersede v1 only once finalized.
    run2 = ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    assert run2["version"] == 2
    new = [s for s in ok(client.get(f"{base(pid)}/statements", headers=OWNER)) if s["version"] == 2 and s["tenantUid"] == "tenant"][0]
    assert new["supersedesId"] == mine[0]["id"]
    publish(client, pid, new['id'])
    old = service.store.get(f"properties/{pid}/statements", mine[0]["id"])
    assert old["status"] == "superseded" and old["totalCentavos"] == 180_600
    tenant_history = ok(client.get(f"{base(pid)}/me/history", headers=TENANT, params={"type": "statement"}))
    history_versions = {record["id"]: (record["status"], record["totalCentavos"]) for record in tenant_history["records"]}
    assert history_versions[mine[0]["id"]] == ("superseded", 180_600)
    assert history_versions[new["id"]] == ("finalized", new["totalCentavos"])
    assert ok(client.get(f"{base(pid)}/utility-bills/{bill['id']}/reconciliation", headers=OWNER))["version"] == 2


def test_move_out_and_move_in_produce_separate_submeter_statements(env):
    client, _, _ = env
    pid, (u1, _), main, (s1, s2) = submeter_property(client)
    reading(client, pid, s2["id"], "2026-09-01", "0")
    reading(client, pid, s2["id"], "2026-09-30", "0")
    invite_tenant(client, pid, u1["id"], TENANT, move_in="2026-01-01")
    occupancy = ok(client.get(f"{base(pid)}/members", headers=OWNER))["occupancies"][0]
    # Second tenant cannot join while unit is still occupied.
    early = ok(client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": u1["id"], "moveInDate": "2026-09-16"}), 201)
    assert client.post("/api/rentals/invitations/accept", headers=TENANT2, json={"token": early["token"]}).status_code == 409
    ok(client.post(f"{base(pid)}/occupancies/{occupancy['id']}/end", headers=OWNER, json={"endDate": "2026-09-15"}))
    invite_tenant(client, pid, u1["id"], TENANT2, move_in="2026-09-16")
    for day, kwh in (("2026-09-01", "0"), ("2026-09-15", "100"), ("2026-09-30", "250")):
        reading(client, pid, s1["id"], day, kwh)
    bill = ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": main["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "500", "amountCentavos": 500_000,
    }), 201)
    ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    by_tenant = {s["tenantUid"]: s for s in ok(client.get(f"{base(pid)}/statements", headers=OWNER))}
    assert by_tenant["tenant"]["lines"][0]["wh"] == 100_000
    assert by_tenant["tenant2"]["lines"][0]["wh"] == 150_000
    for statement in by_tenant.values():
        publish(client, pid, statement['id'])
    # Former tenant keeps their own finalized statement but nothing else.
    assert len(ok(client.get(f"{base(pid)}/me/statements", headers=TENANT))) == 1
    assert client.get(f"{base(pid)}/me/unit", headers=TENANT).status_code == 404


def test_reading_correction_flags_draft_statements(env):
    client, _, _ = env
    pid, (u1, _), main, (s1, s2) = submeter_property(client)
    reading(client, pid, s2["id"], "2026-09-01", "0")
    reading(client, pid, s2["id"], "2026-09-30", "0")
    invite_tenant(client, pid, u1["id"])
    first = reading(client, pid, s1["id"], "2026-09-01", "0")
    reading(client, pid, s1["id"], "2026-09-30", "100")
    bill = ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": main["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "200", "amountCentavos": 200_000,
    }), 201)
    ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    corrected = ok(client.post(f"{base(pid)}/readings/{first['id']}/corrections", headers=OWNER, json={"valueKwh": "10", "reason": "Typo in first reading"}), 201)
    assert len(corrected["affectedStatementIds"]) == 1
    draft = ok(client.get(f"{base(pid)}/statements", headers=OWNER))[0]
    assert draft["needsReview"] is True
    assert client.post(f"{base(pid)}/statements/{draft['id']}/finalize", headers=OWNER).status_code == 409
    ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    fresh = [s for s in ok(client.get(f"{base(pid)}/statements", headers=OWNER)) if s["status"] == "draft"][0]
    assert fresh["lines"][0]["wh"] == 90_000


def test_shared_meter_without_agreement_creates_no_tenant_statement(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    shared = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "Main", "kind": "utility_shared"}), 201)
    invite_tenant(client, pid, unit["id"])
    bill = ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": shared["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "300", "amountCentavos": 360_000,
    }), 201)
    run = ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    assert run["statementIds"] == [] and run["reconciliation"]["ownerBorneCentavos"] == 360_000


def test_individual_meter_statement_and_tenant_cannot_see_other_property(env):
    client, _, _ = env
    pid = make_property(client)
    other = make_property(client, OWNER2, name="Elsewhere")
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    meter = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "M1", "kind": "utility_individual"}), 201)
    ok(client.post(f"{base(pid)}/meter-assignments", headers=OWNER, json={"meterId": meter["id"], "unitId": unit["id"], "effectiveFrom": "2026-01-01"}), 201)
    invite_tenant(client, pid, unit["id"])
    bill = ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": meter["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "123.4", "amountCentavos": 160_000,
    }), 201)
    run = ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    statement = ok(client.get(f"{base(pid)}/statements", headers=OWNER))[0]
    assert statement["lines"][0]["chargeBasis"] == "official_utility_bill" and statement["totalCentavos"] == 160_000
    assert run["reconciliation"]["balanced"]
    assert client.get(f"{base(other)}/me/statements", headers=TENANT).status_code == 404
    assert client.get(f"{base(other)}/me/unit", headers=TENANT).status_code == 404


def test_audit_log_records_privileged_actions_and_is_manager_only(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    invite_tenant(client, pid, unit["id"])
    actions = {log["action"] for log in ok(client.get(f"{base(pid)}/audit-logs", headers=OWNER))}
    assert {"property.create", "subscription.request", "subscription.approve", "unit.create", "invitation.create", "invitation.accept"} <= actions
    assert client.get(f"{base(pid)}/audit-logs", headers=TENANT).status_code == 403


def test_rentals_service_never_touches_personal_user_collections(env):
    client, _, service = env
    pid, (u1, _), main, (s1, _) = submeter_property(client)
    invite_tenant(client, pid, u1["id"])
    collections = set(service.store._data)  # noqa: SLF001 - test inspection
    assert not any(name.startswith("users/") or name == "users" for name in collections)


def test_database_exceptions_return_http_503(env):
    from unittest.mock import MagicMock
    from google.api_core.exceptions import GoogleAPICallError

    client, _, service = env
    # Mock store to simulate a Google Cloud API error
    mock_store = MagicMock()
    mock_store.query.side_effect = GoogleAPICallError("Network failure")
    service.store = mock_store

    res = client.get("/api/account/workspaces", headers=OWNER)
    assert res.status_code == 503
    assert res.json()["detail"] == "SmartWatts Rentals database service is temporarily unavailable."


# ---------------------------------------------------- property & portfolio analytics
def test_property_analytics_subscription_enforcement_and_role_access(env):
    client, _, _ = env
    # 1. Inactive property blocks analytics with 402 PaymentRequired
    inactive_pid = make_property(client, OWNER, activate=False)
    res_inactive = client.get(f"{base(inactive_pid)}/analytics", headers=OWNER)
    assert res_inactive.status_code == 402
    assert "subscription is not active" in res_inactive.json()["detail"]

    # 2. Active property succeeds for owner
    active_pid = make_property(client, OWNER, activate=True)
    unit = ok(client.post(f"{base(active_pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    invite_tenant(client, active_pid, unit["id"])

    res_owner = ok(client.get(f"{base(active_pid)}/analytics", headers=OWNER))
    assert res_owner["propertyId"] == active_pid
    assert res_owner["unitCount"] == 1
    assert res_owner["occupiedUnitCount"] == 1
    assert res_owner["vacantUnitCount"] == 0
    assert res_owner["occupancyRate"] == 100.0

    # 3. Tenant on this property is denied owner analytics with 403 Forbidden
    res_tenant = client.get(f"{base(active_pid)}/analytics", headers=TENANT)
    assert res_tenant.status_code == 403

    # 4. Stranger is denied with 404 Not Found
    res_stranger = client.get(f"{base(active_pid)}/analytics", headers=STRANGER)
    assert res_stranger.status_code == 404


def test_property_analytics_aggregates_billing_units_and_trends(env):
    client, _, _ = env
    pid, (u1, u2), main, (s1, s2) = submeter_property(client)
    invite_tenant(client, pid, u1["id"], TENANT)
    invite_tenant(client, pid, u2["id"], TENANT2)

    # Readings for submeters: s1: 0 -> 100 kWh, s2: 0 -> 150 kWh
    reading(client, pid, s1["id"], "2026-09-01", "0")
    reading(client, pid, s1["id"], "2026-09-30", "100")
    reading(client, pid, s2["id"], "2026-09-01", "0")
    reading(client, pid, s2["id"], "2026-09-30", "150")

    bill = ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": main["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "250.0", "amountCentavos": 300_000,
    }), 201)

    ok(client.post(f"{base(pid)}/utility-bills/{bill['id']}/statements", headers=OWNER), 201)
    statements = ok(client.get(f"{base(pid)}/statements", headers=OWNER))
    assert len(statements) == 2
    # Finalize statement for u1
    s1_stmt = next(s for s in statements if s["unitId"] == u1["id"])
    publish(client, pid, s1_stmt['id'])

    analytics = ok(client.get(f"{base(pid)}/analytics", headers=OWNER))
    assert analytics["totalOfficialBilledCentavos"] == 300_000
    assert analytics["totalOfficialBilledWh"] == 250_000
    assert analytics["totalTenantBilledCentavos"] == s1_stmt["totalCentavos"]
    assert analytics["statementsSummary"]["finalizedCount"] == 1
    assert analytics["statementsSummary"]["draftCount"] == 1

    # Units analytics
    u1_analytics = next(u for u in analytics["unitsAnalytics"] if u["unitId"] == u1["id"])
    assert u1_analytics["unitLabel"] == "1A"
    assert u1_analytics["isOccupied"] is True
    assert u1_analytics["totalBilledCentavos"] == s1_stmt["totalCentavos"]
    assert u1_analytics["totalMeasuredWh"] == 100_000

    u2_analytics = next(u for u in analytics["unitsAnalytics"] if u["unitId"] == u2["id"])
    assert u2_analytics["unitLabel"] == "1B"
    assert u2_analytics["isOccupied"] is True
    assert u2_analytics["draftStatementsCount"] == 1

    # Shared meter accuracy and legal review notice
    assert len(analytics["sharedMeters"]) == 1
    assert "legal/regulatory review" in analytics["sharedMeters"][0]["legalNotice"]


def test_portfolio_analytics_aggregates_multiple_properties(env):
    client, _, _ = env
    pid1 = make_property(client, OWNER, activate=True, name="Sunny Hills")
    ok(client.post(f"{base(pid1)}/units", headers=OWNER, json={"label": "A1"}), 201)

    pid2 = make_property(client, OWNER, activate=True, name="Ocean Breeze")
    ok(client.post(f"{base(pid2)}/units", headers=OWNER, json={"label": "B1"}), 201)
    ok(client.post(f"{base(pid2)}/units", headers=OWNER, json={"label": "B2"}), 201)

    pid_inactive = make_property(client, OWNER, activate=False, name="Inactive Villa")

    # Call portfolio analytics
    portfolio = ok(client.get("/api/rentals/portfolio/analytics", headers=OWNER))
    assert portfolio["totalProperties"] == 3
    assert portfolio["activePropertiesCount"] == 2
    assert portfolio["portfolioTotals"]["totalUnits"] == 3
    assert portfolio["portfolioTotals"]["activePropertyCount"] == 2

    # Verify inactive property is not unlocked
    inactive_item = next(p for p in portfolio["properties"] if p["propertyId"] == pid_inactive)
    assert inactive_item["unlocked"] is False

    # Tenant has 0 managed properties
    tenant_portfolio = ok(client.get("/api/rentals/portfolio/analytics", headers=TENANT))
    assert tenant_portfolio["totalProperties"] == 0
