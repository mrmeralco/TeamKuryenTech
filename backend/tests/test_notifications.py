from __future__ import annotations

import datetime
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.auth import AuthUser, require_user
from app.main import app
from app.notifications.models import (
    BillSavedNotificationRequest,
    NotificationPreferences,
)
from app.notifications.service import NotificationService, get_manila_today
from app.rentals.store import InMemoryStore

MANILA_TZ = ZoneInfo("Asia/Manila")


@pytest.fixture
def test_env():
    store = InMemoryStore()
    mock_sender = MagicMock()
    service = NotificationService(store=store, email_sender=mock_sender)
    client = TestClient(app)
    return {"store": store, "sender": mock_sender, "service": service, "client": client}


def auth_user(uid="user_123", email="user@example.com", name="Juan Dela Cruz"):
    return AuthUser(uid=uid, sign_in_provider="password", email=email, email_verified=True)


# ---------------------------------------------------------------- preferences tests
def test_preferences_defaults_and_updates(test_env):
    service = test_env["service"]
    prefs = service.get_preferences("u1")
    assert prefs.bill_saved_confirmations is True
    assert prefs.bill_due_reminders is True
    assert prefs.reminder_intervals == [7, 3, 0]

    # Update
    updated = NotificationPreferences(
        bill_saved_confirmations=False,
        bill_due_reminders=True,
        reminder_intervals=[3],
        rental_statements=False,
    )
    saved = service.update_preferences("u1", updated)
    assert saved.bill_saved_confirmations is False
    assert saved.reminder_intervals == [3]

    fetched = service.get_preferences("u1")
    assert fetched.bill_saved_confirmations is False
    assert fetched.rental_statements is False


# ---------------------------------------------------------------- bill saved confirmation tests
def test_bill_saved_confirmation_queuing(test_env):
    service = test_env["service"]
    user = auth_user(name="Alice")

    req = BillSavedNotificationRequest(
        billId="b_100",
        periodStart="2026-04-01",
        periodEnd="2026-04-30",
        amountPesos=2450.50,
        kwh=210.4,
        dueDate="2026-05-15",
        workspaceType="Personal",
    )

    item = service.handle_bill_saved(user, req, save_date_str="May 01, 2026")
    assert item is not None
    assert item.to_email == "user@example.com"
    assert item.template == "bill-saved"
    assert item.template_data["periodStart"] == "2026-04-01"
    assert item.template_data["amountPesos"] == 2450.50
    assert item.template_data["kwh"] == 210.4
    assert item.template_data["dueDate"] == "2026-05-15"
    assert item.status == "pending"


def test_bill_saved_idempotency_prevents_duplicates(test_env):
    service = test_env["service"]
    user = auth_user()

    req = BillSavedNotificationRequest(
        billId="b_duplicate_test",
        periodStart="2026-04-01",
        periodEnd="2026-04-30",
        amountPesos=1200.0,
        kwh=100.0,
    )

    item1 = service.handle_bill_saved(user, req)
    item2 = service.handle_bill_saved(user, req)

    assert item1 is not None
    assert item2 is not None
    assert item1.id == item2.id  # Same outbox item returned, no duplicate queued

    all_outbox = service.store.query("notifications_outbox")
    assert len(all_outbox) == 1


def test_bill_saved_skipped_when_preference_disabled(test_env):
    service = test_env["service"]
    user = auth_user(uid="optout_user")

    service.update_preferences(user.uid, NotificationPreferences(bill_saved_confirmations=False))

    req = BillSavedNotificationRequest(
        billId="b_optout",
        periodStart="2026-04-01",
        periodEnd="2026-04-30",
        amountPesos=1500.0,
        kwh=120.0,
    )

    item = service.handle_bill_saved(user, req)
    assert item is None
    all_outbox = service.store.query("notifications_outbox")
    assert len(all_outbox) == 0


def test_bill_saved_skipped_when_no_email(test_env):
    service = test_env["service"]
    user = AuthUser(uid="anon", sign_in_provider="anonymous", email=None)

    req = BillSavedNotificationRequest(
        billId="b_anon",
        periodStart="2026-04-01",
        periodEnd="2026-04-30",
        amountPesos=1500.0,
        kwh=120.0,
    )

    item = service.handle_bill_saved(user, req)
    assert item is None


# ---------------------------------------------------------------- due reminder scheduler tests
def test_due_reminders_evaluation_intervals(test_env):
    service = test_env["service"]
    today = datetime.date(2026, 5, 1)

    # Register bills with different due dates
    # 7 days before: due 2026-05-08
    # 3 days before: due 2026-05-04
    # 0 days (today): due 2026-05-01
    # 5 days (not configured): due 2026-05-06
    # Paid bill due 2026-05-08: should be suppressed
    # Missing due date: should be skipped

    service.register_personal_bill("u1", {
        "billId": "b_7days",
        "userEmail": "u1@example.com",
        "userName": "User One",
        "dueDate": "2026-05-08",
        "periodStart": "2026-04-01",
        "periodEnd": "2026-04-30",
        "amountPesos": 3000.0,
        "kwh": 250.0,
    })

    service.register_personal_bill("u1", {
        "billId": "b_3days",
        "userEmail": "u1@example.com",
        "userName": "User One",
        "dueDate": "2026-05-04",
        "periodStart": "2026-04-01",
        "periodEnd": "2026-04-30",
        "amountPesos": 2500.0,
        "kwh": 200.0,
    })

    service.register_personal_bill("u1", {
        "billId": "b_today",
        "userEmail": "u1@example.com",
        "userName": "User One",
        "dueDate": "2026-05-01",
        "periodStart": "2026-04-01",
        "periodEnd": "2026-04-30",
        "amountPesos": 2000.0,
        "kwh": 180.0,
    })

    service.register_personal_bill("u1", {
        "billId": "b_5days",
        "userEmail": "u1@example.com",
        "userName": "User One",
        "dueDate": "2026-05-06",
        "periodStart": "2026-04-01",
        "periodEnd": "2026-04-30",
        "amountPesos": 1800.0,
        "kwh": 150.0,
    })

    service.register_personal_bill("u1", {
        "billId": "b_paid",
        "userEmail": "u1@example.com",
        "userName": "User One",
        "dueDate": "2026-05-08",
        "paid": True,
        "amountPesos": 3500.0,
    })

    service.register_personal_bill("u1", {
        "billId": "b_nodate",
        "userEmail": "u1@example.com",
        "userName": "User One",
        "dueDate": None,
    })

    eval_count, queued_count = service.evaluate_due_reminders(target_date=today)
    assert eval_count == 4  # b_7days, b_3days, b_today, b_5days evaluated
    assert queued_count == 3  # exactly 7-day, 3-day, and today queued

    outbox = service.store.query("notifications_outbox")
    queued_templates = [m["template"] for m in outbox]
    assert queued_templates == ["bill-due-reminder", "bill-due-reminder", "bill-due-reminder"]

    # Running again on the same day should queue 0 additional reminders (idempotency)
    eval_count2, queued_count2 = service.evaluate_due_reminders(target_date=today)
    assert eval_count2 == 4
    assert queued_count2 == 0
    assert len(service.store.query("notifications_outbox")) == 3


def test_due_reminders_dry_run_mode(test_env):
    service = test_env["service"]
    today = datetime.date(2026, 5, 1)

    service.register_personal_bill("u1", {
        "billId": "b_dry",
        "userEmail": "u1@example.com",
        "dueDate": "2026-05-04",  # 3 days
    })

    eval_count, queued_count = service.evaluate_due_reminders(target_date=today, dry_run=True)
    assert eval_count == 1
    assert queued_count == 1
    # Dry run should NOT create outbox items
    assert len(service.store.query("notifications_outbox")) == 0


# ---------------------------------------------------------------- rentals tenant statement tests
def test_statement_published_tenant_notification(test_env):
    service = test_env["service"]

    statement = {
        "id": "stmt_123",
        "status": "finalized",
        "tenantUid": "tenant_1",
        "unitId": "unit_101",
        "periodStart": "2026-04-01",
        "periodEnd": "2026-04-30",
        "totalCentavos": 185450,
        "dueDate": "2026-05-15",
    }

    item = service.handle_statement_published(
        statement=statement,
        pid="prop_1",
        property_name="Sunset Apartments",
        unit_name="Unit 101",
        tenant_email="tenant@example.com",
        tenant_name="Maria Santos",
    )

    assert item is not None
    assert item.to_email == "tenant@example.com"
    assert item.template == "statement-published"
    assert item.template_data["propertyName"] == "Sunset Apartments"
    assert item.template_data["amountPesos"] == 1854.50


def test_statement_published_draft_status_rejected(test_env):
    service = test_env["service"]

    statement = {
        "id": "stmt_draft",
        "status": "draft",
        "tenantUid": "tenant_1",
        "periodStart": "2026-04-01",
        "periodEnd": "2026-04-30",
    }

    item = service.handle_statement_published(
        statement=statement,
        pid="prop_1",
        property_name="Sunset Apartments",
        unit_name="Unit 101",
        tenant_email="tenant@example.com",
    )
    assert item is None


# ---------------------------------------------------------------- outbox processing and retry tests
def test_outbox_processing_success(test_env):
    service = test_env["service"]
    sender = test_env["sender"]

    service.queue_message(
        idempotency_key="test_send_1",
        to_email="test@example.com",
        recipient_uid="u1",
        template="bill-saved",
        template_data={"periodStart": "2026-04-01"},
    )

    processed, sent, failed = service.process_outbox()
    assert processed == 1
    assert sent == 1
    assert failed == 0

    sender.assert_called_once_with("bill-saved", "test@example.com", {"periodStart": "2026-04-01"})

    items = service.store.query("notifications_outbox")
    assert items[0]["status"] == "sent"
    assert items[0]["sent_at"] is not None


def test_outbox_processing_retry_with_backoff(test_env):
    store = InMemoryStore()
    mock_sender = MagicMock(side_effect=Exception("SMTP Connection Timeout"))
    service = NotificationService(store=store, email_sender=mock_sender)

    service.queue_message(
        idempotency_key="test_retry_1",
        to_email="retry@example.com",
        recipient_uid="u1",
        template="bill-saved",
        template_data={},
        now=1000.0,
    )

    # First attempt fails -> retryable_failure
    processed, sent, failed = service.process_outbox(now=1000.0)
    assert processed == 1
    assert sent == 0
    assert failed == 1

    item = service.store.query("notifications_outbox")[0]
    assert item["status"] == "retryable_failure"
    assert item["attempts"] == 1
    # Exponential backoff: 30 * 2^0 = 30s delay -> next_attempt_at = 1030
    assert item["next_attempt_at"] == 1030.0

    # Calling before next_attempt_at -> skipped
    p2, s2, f2 = service.process_outbox(now=1010.0)
    assert p2 == 0

    # Calling after next_attempt_at -> attempts again
    p3, s3, f3 = service.process_outbox(now=1035.0)
    assert p3 == 1
    item2 = service.store.query("notifications_outbox")[0]
    assert item2["attempts"] == 2
    # Delay: 30 * 2^1 = 60s -> next_attempt_at = 1035 + 60 = 1095
    assert item2["next_attempt_at"] == 1095.0


def test_outbox_processing_max_attempts_permanent_failure(test_env):
    store = InMemoryStore()
    mock_sender = MagicMock(side_effect=Exception("Delivery Error"))
    service = NotificationService(store=store, email_sender=mock_sender)

    service.queue_message(
        idempotency_key="test_max_fail",
        to_email="fail@example.com",
        recipient_uid="u1",
        template="bill-saved",
        template_data={},
        max_attempts=3,
        now=1000.0,
    )

    # Simulate 3 failures
    current_time = 1000.0
    for _ in range(3):
        service.process_outbox(now=current_time)
        item = service.store.query("notifications_outbox")[0]
        current_time = item.get("next_attempt_at", current_time) + 1.0

    final_item = service.store.query("notifications_outbox")[0]
    assert final_item["status"] == "permanent_failure"
    assert final_item["attempts"] == 3


# ---------------------------------------------------------------- API endpoint tests
def test_api_notification_preferences(test_env):
    client = test_env["client"]
    test_user = auth_user(uid="api_pref_user", email="pref@example.com")
    app.dependency_overrides[require_user] = lambda: test_user

    # GET preferences
    res = client.get("/api/notifications/preferences")
    assert res.status_code == 200
    data = res.json()
    assert data["bill_saved_confirmations"] is True

    # PUT preferences
    update_payload = {
        "bill_saved_confirmations": False,
        "bill_due_reminders": True,
        "reminder_intervals": [7, 0],
        "rental_statements": True,
    }
    put_res = client.put("/api/notifications/preferences", json=update_payload)
    assert put_res.status_code == 200
    assert put_res.json()["bill_saved_confirmations"] is False
    assert put_res.json()["reminder_intervals"] == [7, 0]

    app.dependency_overrides.clear()


def test_api_bill_saved_endpoint(test_env):
    client = test_env["client"]
    test_user = auth_user(uid="api_bill_user", email="bill@example.com")
    app.dependency_overrides[require_user] = lambda: test_user

    payload = {
        "billId": "api_bill_1",
        "periodStart": "2026-04-01",
        "periodEnd": "2026-04-30",
        "amountPesos": 1950.0,
        "kwh": 160.0,
        "dueDate": "2026-05-15",
        "workspaceType": "Personal",
    }
    res = client.post("/api/notifications/bill-saved", json=payload)
    assert res.status_code == 202
    assert res.json()["status"] == "queued"

    app.dependency_overrides.clear()
