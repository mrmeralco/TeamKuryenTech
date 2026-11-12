import hashlib
import re

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.security import shield as shield_module
from app.security.middleware import SecurityMiddleware
from app.security.settings import load_security_settings
from app.security.shield import Shield
from app.security.store import MemoryStore

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36"


def make(env_extra=None):
    small = FastAPI()

    @small.get("/dashboard")
    def page():
        return {"page": "dashboard"}

    @small.get("/api/ok")
    def ok():
        return {"ok": True}

    env = {"SMARTWATTS_ENV": "test", "SMARTWATTS_SHIELD": "1", "BOT_SECRET": "s" * 64, **(env_extra or {})}
    small.add_middleware(SecurityMiddleware, settings=load_security_settings(env), store=MemoryStore())
    return TestClient(small, headers={"User-Agent": UA}, base_url="https://smartwatts.vercel.app")


def solve(token: str, difficulty: int) -> int:
    n = 0
    while not hashlib.sha256(f"{token}:{n}".encode()).hexdigest().startswith("0" * difficulty):
        n += 1
    return n


def challenge(client):
    page = client.get("/dashboard")
    token = re.search(r'data-t="([^"]+)"', page.text).group(1)
    difficulty = int(re.search(r'data-d="(\d)"', page.text).group(1))
    return page, token, difficulty


def test_request_without_cookie_gets_the_challenge_page():
    client = make()
    page, token, difficulty = challenge(client)
    assert page.status_code == 403
    assert "Checking your browser" in page.text and page.headers["cache-control"] == "no-store"
    assert '<script src="/__c.js' in page.text and "<script>" not in page.text  # CSP-safe: no inline script
    assert difficulty == 3 and token.count(".") == 3
    assert client.get("/__c.js").headers["content-type"].startswith("text/javascript")


def test_solved_puzzle_sets_a_signed_cookie_and_opens_the_site():
    client = make()
    _, token, difficulty = challenge(client)
    verify = client.get(f"/__v?t={token}&n={solve(token, difficulty)}")
    assert verify.status_code == 204
    cookie = verify.headers["set-cookie"]
    for flag in ("HttpOnly", "SameSite=Lax", "Secure", "Max-Age=3600", "Path=/"):
        assert flag in cookie
    assert client.get("/dashboard").json() == {"page": "dashboard"}
    assert client.get("/api/ok").json() == {"ok": True}


def test_wrong_answer_and_forged_token_are_refused():
    client = make()
    _, token, _ = challenge(client)
    assert client.get(f"/__v?t={token}&n=abc").status_code == 403
    forged = token.rsplit(".", 1)[0] + "." + "0" * 64
    assert client.get(f"/__v?t={forged}&n=1").status_code == 403


def test_api_refuses_browser_requests_without_the_cookie():
    response = make().get("/api/ok")
    assert response.status_code == 403 and response.json() == {"detail": "Verification required"}


def test_cookie_is_bound_to_the_user_agent():
    client = make()
    _, token, difficulty = challenge(client)
    client.get(f"/__v?t={token}&n={solve(token, difficulty)}")
    assert client.get("/api/ok", headers={"User-Agent": UA + " other"}).status_code == 403


def test_expired_token_is_refused():
    now = [1_000_000.0]
    s = Shield(b"k" * 32, clock=lambda: now[0])
    token = s.new_token()
    answer = solve(token, 3)
    now[0] += 5 * 60 + 1
    assert not s.pow_ok(token, str(answer))


def test_search_engines_skip_the_challenge():
    google = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    assert make().get("/dashboard", headers={"User-Agent": google}).json() == {"page": "dashboard"}


def test_attack_mode_hardens_the_puzzle_and_limits(monkeypatch):
    forced = make({"ATTACK_MODE": "1"})
    _, token, difficulty = challenge(forced)
    assert difficulty == 4
    verify = forced.get(f"/__v?t={token}&n={solve(token, difficulty)}")
    assert "Max-Age=1800" in verify.headers["set-cookie"]

    now = [0.0]
    s = Shield(b"k" * 32, clock=lambda: now[0])
    assert s.scaled(240) == 240
    for _ in range(shield_module.FLOOD_LIMIT + 1):
        s.note_request()
    assert s.attack_mode() and s.scaled(240) == 60 and s.difficulty() == 4
    now[0] += shield_module.ATTACK_SECONDS + 11
    s.note_request()
    assert not s.attack_mode()  # switches itself off


def test_production_refuses_to_start_without_bot_secret():
    import pytest
    from app.security.settings import MissingSecretError
    with pytest.raises(MissingSecretError, match="BOT_SECRET"):
        load_security_settings({"SMARTWATTS_ENV": "production", "ALLOWED_HOSTS": "smartwatts.vercel.app"})
