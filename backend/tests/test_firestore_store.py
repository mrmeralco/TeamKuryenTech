"""Runs the Rentals service against the Firestore emulator (npm run test:backend:emulator)."""

import os
import secrets
from datetime import UTC, datetime

import pytest

from app.auth import AuthUser
from app.rentals.config import RentalsConfig
from app.rentals.service import Conflict, RentalService
from app.rentals.store import AlreadyExistsError, FirestoreStore

pytestmark = pytest.mark.skipif(
    not os.getenv("FIRESTORE_EMULATOR_HOST"), reason="Firestore emulator is not running"
)


@pytest.fixture()
def store():
    from google.cloud import firestore

    return FirestoreStore(firestore.Client(project="demo-smartwatts"))


def test_store_primitives(store):
    collection = f"storeTest{secrets.token_hex(4)}"
    store.create(collection, "a", {"status": "pending", "n": 1})
    with pytest.raises(AlreadyExistsError):
        store.create(collection, "a", {"status": "pending"})
    assert store.compare_and_update(collection, "a", {"status": "pending"}, {"status": "accepted"}) is True
    assert store.compare_and_update(collection, "a", {"status": "pending"}, {"status": "again"}) is False
    assert store.get(collection, "a")["status"] == "accepted"
    assert [doc["id"] for doc in store.query(collection, status="accepted")] == ["a"]


def test_full_rental_workflow_on_firestore(store):
    clock = lambda: datetime(2026, 10, 15, tzinfo=UTC)  # noqa: E731
    service = RentalService(store, RentalsConfig(), clock=clock)
    owner = AuthUser("owner-" + secrets.token_hex(3), "password", "owner@example.com", True)
    tenant = AuthUser("tenant-" + secrets.token_hex(3), "password", "tenant@example.com", True)
    staff = AuthUser("staff", "password", platform_admin=True)
    pid = service.create_property(owner, {"name": "Emulator Flats", "address": "1 Test St"})["id"]
    service.platform_set_subscription(staff, pid, {"status": "active", "currentPeriodEnd": "2026-11-15T00:00:00+00:00"})
    unit = service.create_unit(owner, pid, {"label": "1A"})
    meter = service.create_meter(owner, pid, {"label": "M1", "kind": "utility_individual"})
    service.create_assignment(owner, pid, {"meterId": meter["id"], "unitId": unit["id"], "effectiveFrom": "2026-01-01"})
    invite = service.create_invitation(owner, pid, {"role": "tenant", "unitId": unit["id"], "moveInDate": "2026-01-01"})
    service.redeem_invitation(tenant, invite["token"])
    with pytest.raises(Exception):
        service.redeem_invitation(tenant, invite["token"])
    bill = service.create_bill(owner, pid, {
        "meterId": meter["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "150", "amountCentavos": 180000,
    })
    run = service.generate_statements(owner, pid, bill["id"])
    assert run["reconciliation"]["balanced"]
    statement_id = run["statementIds"][0]
    service.finalize_statement(owner, pid, statement_id)
    with pytest.raises(Conflict):
        service.finalize_statement(owner, pid, statement_id)
    mine = service.my_statements(tenant, pid)
    assert [s["totalCentavos"] for s in mine] == [180000]
    assert service.workspaces(tenant)["rentalMemberships"][0]["role"] == "tenant"
