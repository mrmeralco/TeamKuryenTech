import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from firebase_admin import auth as firebase_auth

from app import auth
from app.auth import AuthUser
from app.main import app as main_app
from app.notifications.router import router as notifications_router
from app.security.middleware import SecurityMiddleware
from app.security.settings import load_security_settings
from app.security.store import MemoryStore

CRON_KEY = "cron-key-for-tests-0123456789abcdef"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("CRON_API_KEY_SHA256", hashlib.sha256(CRON_KEY.encode()).hexdigest())
    small = FastAPI()
    small.include_router(notifications_router)
    small.add_middleware(SecurityMiddleware, settings=load_security_settings({"SMARTWATTS_ENV": "test"}),
                         store=MemoryStore())
    return TestClient(small)


def test_three_bad_api_keys_ban_for_15_minutes(client):
    for n in range(3):
        response = client.post("/api/notifications/outbox/process", headers={"x-api-key": f"guess-{n}"})
        assert response.status_code == 401
    banned = client.post("/api/notifications/outbox/process", headers={"x-api-key": CRON_KEY})
    assert banned.status_code == 403 and banned.headers["retry-after"] == "900"


def test_valid_cron_key_is_accepted_and_only_its_hash_is_configured(client, monkeypatch):
    calls = []
    monkeypatch.setattr("app.notifications.router.notification_service.process_outbox", lambda: calls.append(1) or (0, 0, 0))
    assert client.post("/api/notifications/outbox/process", headers={"x-api-key": CRON_KEY}).status_code == 200
    assert calls == [1]
    assert CRON_KEY not in os.environ["CRON_API_KEY_SHA256"]


def test_key_in_url_is_not_accepted(client):
    assert client.post(f"/api/notifications/outbox/process?key={CRON_KEY}").status_code in (400, 401)


@pytest.mark.parametrize("user", [
    AuthUser(uid="guest", sign_in_provider="anonymous"),
    AuthUser(uid="owner", sign_in_provider="password", email="o@example.com", email_verified=True),
])
def test_ordinary_users_cannot_run_jobs(client, monkeypatch, user):
    monkeypatch.setattr(auth, "require_user", lambda request, authorization=None: user)
    response = client.post("/api/notifications/scheduler/run", json={}, headers={"Authorization": "Bearer x"})
    assert response.status_code == 403


def test_forged_tokens_are_strikes_but_expired_tokens_are_not(client, monkeypatch):
    monkeypatch.setattr(auth, "get_firebase_app", lambda: None)

    def expired(token, app=None):
        raise firebase_auth.ExpiredIdTokenError("expired", cause=None)

    monkeypatch.setattr(firebase_auth, "verify_id_token", expired)
    for _ in range(5):
        assert client.get("/api/notifications/preferences", headers={"Authorization": "Bearer old"}).status_code == 401

    def forged(token, app=None):
        raise firebase_auth.InvalidIdTokenError("bad signature")

    monkeypatch.setattr(firebase_auth, "verify_id_token", forged)
    for _ in range(3):
        assert client.get("/api/notifications/preferences", headers={"Authorization": "Bearer forged"}).status_code == 401
    assert client.get("/api/notifications/preferences").status_code == 403


def test_api_responses_are_never_cached():
    response = TestClient(main_app).get("/api/health")
    assert response.headers["cache-control"] == "private, no-store"


def test_no_route_list_in_production(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    env = {**os.environ, "SMARTWATTS_ENV": "production", "BOT_SECRET": "c" * 64, "ALLOWED_HOSTS": "testserver",
           "PYTHONPATH": str(backend)}
    code = ("from fastapi.testclient import TestClient; from app.main import app; c = TestClient(app);"
            "print(c.get('/openapi.json').status_code, c.get('/docs').status_code, c.get('/api/zzz').text)")
    result = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True,
                            timeout=120)
    assert result.returncode == 0, result.stderr
    first, second, body = result.stdout.strip().split(" ", 2)
    assert first != "200" and second != "200"
    assert "rentals" not in body and "openapi" not in body
