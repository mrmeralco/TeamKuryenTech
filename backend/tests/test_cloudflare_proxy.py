"""Cloud Run behind the Cloudflare Worker: proxy secret, public hostname, visitor IP, public health check,
and the durable (Firestore-in-production) state that replaces per-instance memory and local files."""

import json
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app import email_otp, persistence
from app.email_otp import MAX_ATTEMPTS, DocumentOtpStore, DocumentVerifiedRegistry
from app.notifications.service import PERSONAL_BILLS_COLLECTION, NotificationService
from app.rentals.store import InMemoryStore
from app.security.headers import SECURITY_HEADERS
from app.security.middleware import SecurityMiddleware
from app.security.settings import MissingSecretError, load_security_settings
from app.security.store import MemoryStore

ROOT = Path(__file__).resolve().parents[2]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36"
SECRET = "p" * 48
PROD = {"SMARTWATTS_ENV": "production", "BOT_SECRET": "b" * 64, "ALLOWED_HOSTS": "smartwatts.example.com",
        "PROXY_SHARED_SECRET": SECRET}


def make(env=None, ua=UA):
    small = FastAPI()
    seen = {}

    @small.get("/api/health")
    def health():
        return {"status": "ok"}

    @small.get("/api/echo")
    def echo(request: Request):
        seen["headers"] = dict(request.headers)
        seen["ip"] = request.scope["state"].get("client_ip")
        return {"ok": True}

    small.add_middleware(SecurityMiddleware, settings=load_security_settings(env or PROD), store=MemoryStore())
    client = TestClient(small, headers={"User-Agent": ua}, base_url="https://smartwatts-api-abc.a.run.app")
    return client, seen


def via_proxy(**extra):
    return {"x-smartwatts-proxy": SECRET, "x-smartwatts-host": "smartwatts.example.com",
            "x-smartwatts-client-ip": "203.0.113.7", **extra}


# ---- settings -------------------------------------------------------------------------------------------------
def test_cloud_run_requires_the_proxy_secret():
    env = {k: v for k, v in PROD.items() if k != "PROXY_SHARED_SECRET"}
    with pytest.raises(MissingSecretError) as caught:
        load_security_settings({**env, "K_SERVICE": "smartwatts-api"})
    assert "PROXY_SHARED_SECRET" in str(caught.value)
    load_security_settings({**PROD, "K_SERVICE": "smartwatts-api"})  # with it: starts


def test_short_proxy_secret_is_refused_and_never_echoed():
    with pytest.raises(MissingSecretError) as caught:
        load_security_settings({**PROD, "PROXY_SHARED_SECRET": "short-secret"})
    assert "short-secret" not in str(caught.value)


def test_proxy_secret_makes_the_worker_ip_header_the_trusted_one():
    assert load_security_settings(PROD).client_ip_header == "x-smartwatts-client-ip"
    assert load_security_settings({**PROD, "PROXY_SHARED_SECRET": ""}).client_ip_header == ""


# ---- middleware -----------------------------------------------------------------------------------------------
def test_direct_requests_without_the_proxy_secret_are_refused():
    client, _ = make()
    for headers in ({}, {"x-smartwatts-proxy": "x" * 48}, {"x-smartwatts-host": "smartwatts.example.com"}):
        response = client.get("/api/health", headers=headers)
        assert response.status_code == 403 and response.json() == {"detail": "Forbidden"}


def test_health_is_public_through_the_proxy_without_cookie_and_for_scripts():
    client, _ = make(ua="curl/8.7.1")
    response = client.get("/api/health", headers=via_proxy())
    assert response.status_code == 200 and response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-security-policy"] == SECURITY_HEADERS["Content-Security-Policy"]


def test_other_api_routes_still_need_the_browser_check_cookie():
    client, _ = make()
    response = client.get("/api/echo", headers=via_proxy())
    assert response.status_code == 403 and response.json() == {"detail": "Verification required"}


def test_public_hostname_is_checked_against_allowed_hosts():
    client, _ = make()
    assert client.get("/api/health", headers=via_proxy(**{"x-smartwatts-host": "evil.example"})).status_code == 400
    assert client.get("/api/health", headers=via_proxy(**{"x-smartwatts-host": "smartwatts.example.com:443"})).status_code == 200


def test_visitor_ip_comes_from_the_worker_and_the_secret_never_reaches_the_app():
    client, seen = make({**PROD, "SMARTWATTS_SHIELD": "0"})
    assert client.get("/api/echo", headers=via_proxy()).status_code == 200
    assert seen["ip"] == "203.0.113.7"
    assert "x-smartwatts-proxy" not in seen["headers"]


def test_without_a_proxy_configured_nothing_changes():
    env = {"SMARTWATTS_ENV": "test"}
    client, seen = make(env)
    assert client.get("/api/echo", headers={"x-smartwatts-client-ip": "198.51.100.1"}).status_code == 200
    assert seen["ip"] != "198.51.100.1"  # an unauthenticated header is never trusted


# ---- durable state --------------------------------------------------------------------------------------------
def test_persistence_mode_defaults_to_firestore_only_in_production():
    assert persistence.wants_firestore({"SMARTWATTS_ENV": "production"})
    assert persistence.wants_firestore({"K_SERVICE": "smartwatts-api"})
    assert not persistence.wants_firestore({"SMARTWATTS_ENV": "development"})
    assert not persistence.wants_firestore({"SMARTWATTS_ENV": "production", "SMARTWATTS_PERSISTENCE": "memory"})
    assert persistence.wants_firestore({"SMARTWATTS_PERSISTENCE": "firestore"})


def test_tests_use_memory_state():
    assert isinstance(email_otp.store, email_otp.OtpStore)
    assert isinstance(email_otp.registry, email_otp.VerifiedRegistry)


def test_document_otp_codes_work_across_instances_once_and_expire():
    docs = InMemoryStore()
    first, second = DocumentOtpStore(docs, b"k" * 32), DocumentOtpStore(docs, b"k" * 32)
    code = first.issue("a@b.co", "verify", now=0)
    assert not second.check("a@b.co", "other", code, now=1)  # purpose-bound
    assert second.check("a@b.co", "verify", code, now=1)  # issued on one instance, confirmed on another
    assert not first.check("a@b.co", "verify", code, now=2)  # single use
    assert first.seconds_until_resend("a@b.co", "verify", now=10) == 50
    code = first.issue("a@b.co", "verify", now=100)
    assert not second.check("a@b.co", "verify", code, now=100 + 10_000)  # expired
    stored = docs.query(DocumentOtpStore.COLLECTION)
    assert stored and all(code not in json.dumps(doc) and "a@b.co" not in json.dumps(doc) for doc in stored)


def test_document_otp_locks_after_too_many_wrong_attempts():
    otp = DocumentOtpStore(InMemoryStore(), b"k" * 32)
    code = otp.issue("a@b.co", "verify", now=0)
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(MAX_ATTEMPTS):
        assert not otp.check("a@b.co", "verify", wrong, now=1)
    assert not otp.check("a@b.co", "verify", code, now=1)


def test_document_verified_registry():
    registry = DocumentVerifiedRegistry(InMemoryStore())
    assert not registry.is_verified("u1", "A@b.co")
    registry.mark("u1", "A@b.co")
    registry.mark("u1", "a@b.co")  # idempotent
    assert registry.is_verified("u1", "a@b.co") and not registry.is_verified("u1", "other@b.co")


def test_personal_bill_reminders_survive_a_new_service_instance():
    docs, sent = InMemoryStore(), []
    NotificationService(store=docs, email_sender=lambda *a: sent.append(a)).register_personal_bill(
        "u1", {"billId": "b1", "dueDate": "2026-12-04", "userEmail": "u1@example.com", "amountPesos": 100})
    fresh = NotificationService(store=docs, email_sender=lambda *a: sent.append(a))  # e.g. another Cloud Run instance
    assert [b["billId"] for b in fresh.get_user_personal_bills("u1")] == ["b1"]
    assert docs.get(PERSONAL_BILLS_COLLECTION, "u1")["uid"] == "u1"
    import datetime
    evaluated, queued = fresh.evaluate_due_reminders(target_date=datetime.date(2026, 12, 1))
    assert evaluated == 1 and queued == 1


def test_outbox_is_left_untouched_while_email_delivery_is_disabled(monkeypatch):
    from app.notifications import service as service_module

    monkeypatch.setenv("EMAIL_DELIVERY", "disabled")
    docs = InMemoryStore()
    svc = NotificationService(store=docs)  # the real mailer
    assert svc.email_sender is service_module.raw_send_email
    svc.queue_message(idempotency_key="k1", to_email="u@example.com", recipient_name="U", recipient_uid="u",
                      template="welcome", template_data={}, workspace="personal")
    assert svc.process_outbox() == (0, 0, 0)
    item = docs.query("notifications_outbox")[0]
    assert item["status"] == "pending" and item["attempts"] == 0


def test_an_outbox_item_is_sent_only_once_when_two_instances_process_together():
    docs, sent = InMemoryStore(), []
    a = NotificationService(store=docs, email_sender=lambda *args: sent.append(args))
    b = NotificationService(store=docs, email_sender=lambda *args: sent.append(args))
    a.queue_message(idempotency_key="k1", to_email="u@example.com", recipient_name="U", recipient_uid="u",
                    template="welcome", template_data={}, workspace="personal")
    # Instance b claims the item between a's read and a's claim.
    original, raced = docs.query, []

    def query_then_race(collection, **equals):
        items = original(collection, **equals)
        if collection == "notifications_outbox" and not raced:
            raced.append(True)
            assert b.process_outbox(now=time.time()) == (1, 1, 0)
        return items

    docs.query = query_then_race
    assert a.process_outbox(now=time.time()) == (0, 0, 0)
    assert len(sent) == 1


# ---- Cloudflare files -----------------------------------------------------------------------------------------
def test_cloudflare_security_headers_match_the_backend():
    edge = json.loads((ROOT / "cloudflare" / "security-headers.json").read_text(encoding="utf-8"))
    assert edge == SECURITY_HEADERS


def test_container_upload_never_includes_secrets_or_build_output():
    for name in (".gcloudignore", ".dockerignore"):
        lines = (ROOT / name).read_text(encoding="utf-8").splitlines()
        included = [line for line in lines if line.startswith("!")]
        assert included and not any(".env" in line or "data" in line or "node_modules" in line for line in included)
        assert lines[[i for i, l in enumerate(lines) if not l.startswith("#")][0]] in {"/*", "*"}  # deny by default
