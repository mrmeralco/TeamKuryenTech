import pytest
from fastapi.testclient import TestClient

from app import email_otp
from app.auth import AuthUser
from app.email_otp import MAX_ATTEMPTS, OtpStore, VerifiedRegistry
from app.main import app, require_user

client = TestClient(app)


def test_store_accepts_code_once_and_expires():
    store = OtpStore()
    code = store.issue("a@b.co", "verify", now=0)
    assert not store.check("a@b.co", "other", code, now=1)  # purpose-bound
    assert store.check("a@b.co", "verify", code, now=1)
    assert not store.check("a@b.co", "verify", code, now=2)  # single use
    code = store.issue("a@b.co", "verify", now=0)
    assert not store.check("a@b.co", "verify", code, now=10_000)  # expired


def test_store_locks_after_too_many_wrong_attempts():
    store = OtpStore()
    code = store.issue("a@b.co", "verify", now=0)
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(MAX_ATTEMPTS):
        assert not store.check("a@b.co", "verify", wrong, now=1)
    assert not store.check("a@b.co", "verify", code, now=1)


def test_resend_cooldown():
    store = OtpStore()
    store.issue("a@b.co", "verify", now=0)
    assert store.seconds_until_resend("a@b.co", "verify", now=10) == 50
    assert store.seconds_until_resend("a@b.co", "verify", now=61) == 0


@pytest.fixture
def mail(monkeypatch, tmp_path):
    sent = []
    monkeypatch.setattr(email_otp, "store", OtpStore())
    monkeypatch.setattr(email_otp, "registry", VerifiedRegistry(tmp_path / "verified.json"))
    monkeypatch.setattr(email_otp, "send_code_email", lambda to, code, name=None: sent.append((to, code, name)))
    monkeypatch.setattr(email_otp, "send_welcome_email_later", lambda to, name: sent.append((to, "welcome", name)))
    return sent


def test_send_email_reports_mailer_failures(monkeypatch):
    class Done:
        stdout = '{"ok": false, "auth": true, "error": "Invalid login"}\n'
        stderr = ""
    monkeypatch.setattr(email_otp.subprocess, "run", lambda *a, **k: Done())
    monkeypatch.setattr(email_otp.shutil, "which", lambda name: "node")
    with pytest.raises(email_otp.HTTPException) as caught:
        email_otp.send_email("verification", "a@b.co", {"code": "123456"})
    assert caught.value.status_code == 503


@pytest.fixture(autouse=True)
def restore_overrides():
    saved = dict(app.dependency_overrides)
    yield
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)


def sign_in(email="owner@example.com", verified=False, provider="password"):
    app.dependency_overrides[require_user] = lambda: AuthUser(
        uid="u1", sign_in_provider=provider, email=email, email_verified=verified)


def test_verify_flow_marks_user_verified(mail):
    sign_in()
    assert client.get("/api/auth/status").json() == {"verified": False}
    assert client.post("/api/auth/email-code/verify/send", json={"name": "Juan Dela Cruz"}).json() == {"sent": True}
    to, code, name = mail[0]
    assert (to, name) == ("owner@example.com", "Juan Dela Cruz")
    assert client.post("/api/auth/email-code/verify/send").status_code == 429  # cooldown
    wrong = "999999" if code != "999999" else "000000"
    assert client.post("/api/auth/email-code/verify/confirm", json={"code": wrong}).status_code == 400
    assert client.post("/api/auth/email-code/verify/confirm", json={"code": code, "name": "Juan Dela Cruz"}).json() == {"verified": True}
    assert mail[-1] == ("owner@example.com", "welcome", "Juan Dela Cruz")
    assert client.get("/api/auth/status").json() == {"verified": True}
    assert client.post("/api/auth/email-code/verify/send").json() == {"sent": False, "alreadyVerified": True}


def test_google_accounts_are_already_verified(mail):
    sign_in(verified=True, provider="google.com")
    assert client.get("/api/auth/status").json() == {"verified": True}
    assert client.post("/api/auth/email-code/verify/send").json()["alreadyVerified"] is True
    assert mail == []


def test_verification_is_tied_to_the_email(mail):
    sign_in()
    client.post("/api/auth/email-code/verify/send")
    client.post("/api/auth/email-code/verify/confirm", json={"code": mail[0][1]})
    sign_in(email="changed@example.com")  # same uid, different email
    assert client.get("/api/auth/status").json() == {"verified": False}


def test_anonymous_users_cannot_request_codes(mail):
    app.dependency_overrides[require_user] = lambda: AuthUser(uid="g", sign_in_provider="anonymous")
    assert client.post("/api/auth/email-code/verify/send").status_code == 400
    assert client.get("/api/auth/status").json() == {"verified": False}
    assert mail == []


def test_reset_without_service_account_asks_for_firebase_email(mail, monkeypatch):
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    res = client.post("/api/auth/password-reset/send", json={"email": "owner@example.com"})
    assert res.status_code == 501 and res.json()["detail"] == "firebase-reset-email"


def test_reset_flow_with_service_account(mail, monkeypatch):
    from types import SimpleNamespace
    changed = []
    sent = []
    monkeypatch.setattr(email_otp, "admin_available", lambda: True)
    monkeypatch.setattr(email_otp, "_get_user_by_email",
                        lambda e: SimpleNamespace(uid="u1", display_name="Juan") if e == "owner@example.com" else None)
    monkeypatch.setattr(email_otp, "_set_password", lambda uid, pw: changed.append((uid, pw)))
    monkeypatch.setattr(email_otp, "send_email", lambda t, to, data: sent.append((t, to, data)))

    assert client.post("/api/auth/password-reset/send", json={"email": "Owner@Example.com"}).json() == {"sent": True}
    template, to, data = sent[0]
    assert (template, to, data["name"]) == ("password-reset", "owner@example.com", "Juan")
    res = client.post("/api/auth/password-reset/confirm",
                      json={"email": "owner@example.com", "code": data["code"], "new_password": "brand-new-pass"})
    assert res.json() == {"reset": True} and changed == [("u1", "brand-new-pass")]

    # Unknown email: same response, nothing sent.
    assert client.post("/api/auth/password-reset/send", json={"email": "nobody@example.com"}).json() == {"sent": True}
    assert len(sent) == 1
