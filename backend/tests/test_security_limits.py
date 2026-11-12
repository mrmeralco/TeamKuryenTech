import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.security import limits, store as store_module
from app.security.middleware import SecurityMiddleware
from app.security.settings import load_security_settings
from app.security.store import MemoryStore

ENV = {"SMARTWATTS_ENV": "test", "SMARTWATTS_RATE_LIMITS": "1", "TRUSTED_CLIENT_IP_HEADER": "x-vercel-forwarded-for"}


def make(env=ENV):
    small = FastAPI()

    @small.get("/api/item/{n}")
    def item(n: int):
        return {"n": n}

    @small.get("/api/ok")
    def ok():
        return {"ok": True}

    @small.post("/api/auth/password-reset/send")
    def reset():
        return {"sent": True}

    @small.get("/dashboard")
    def page():
        return {"page": True}

    store = MemoryStore()
    small.add_middleware(SecurityMiddleware, settings=load_security_settings(env), store=store)
    return TestClient(small), store


def ip(addr):
    return {"x-vercel-forwarded-for": addr}


def test_three_honeypot_hits_ban_the_ip_for_15_minutes():
    client, _ = make()
    for path in ("/private-data/", "/backup-db/x", "/admin-api/users"):
        assert client.get(path, headers=ip("1.1.1.1")).status_code == 404
    banned = client.get("/api/ok", headers=ip("1.1.1.1"))
    assert banned.status_code == 403 and banned.headers["retry-after"] == "900"
    assert client.get("/api/ok", headers=ip("2.2.2.2")).status_code == 200  # other visitors unaffected


def test_api_burst_limit_40_per_5_seconds():
    client, _ = make()
    codes = [client.get("/api/ok", headers=ip("3.3.3.3")).status_code for _ in range(41)]
    assert codes[:40] == [200] * 40 and codes[40] == 429


def test_api_limit_240_per_minute_with_retry_after(monkeypatch):
    monkeypatch.setattr(limits, "BURST_LIMIT", 10_000)
    client, _ = make()
    codes = [client.get("/api/ok", headers=ip("4.4.4.4")).status_code for _ in range(241)]
    assert codes.count(200) == 240
    last = client.get("/api/ok", headers=ip("4.4.4.4"))
    assert last.status_code == 429 and 1 <= int(last.headers["retry-after"]) <= 60


def test_enumeration_is_429_and_a_strike(monkeypatch):
    monkeypatch.setattr(limits, "BURST_LIMIT", 10_000)
    client, store = make()
    codes = [client.get(f"/api/item/{n}", headers=ip("5.5.5.5")).status_code for n in range(151)]
    assert codes[:150] == [200] * 150 and codes[150] == 429
    assert store._strikes  # the enumeration counted as a strike


def test_page_limit_120_per_minute():
    client, _ = make()
    codes = [client.get("/dashboard", headers=ip("6.6.6.6")).status_code for _ in range(121)]
    assert codes.count(200) == 120 and codes[-1] == 429


def test_login_attempts_limited_per_account_across_ips():
    client, _ = make()
    codes = [client.post("/api/auth/password-reset/send", json={"email": "victim@example.com"},
                         headers=ip(f"7.7.7.{n}")).status_code for n in range(6)]
    assert codes == [200] * 5 + [429]


def test_login_attempts_limited_per_ip():
    client, _ = make()
    codes = [client.post("/api/auth/password-reset/send", json={"email": f"u{n}@example.com"},
                         headers=ip("8.8.8.8")).status_code for n in range(6)]
    assert codes == [200] * 5 + [429]


def test_spoofed_x_forwarded_for_is_ignored():
    client, _ = make()
    for n in range(3):
        client.get("/private-data/", headers={**ip("9.9.9.9"), "x-forwarded-for": f"10.0.0.{n}"})
    assert client.get("/api/ok", headers=ip("9.9.9.9")).status_code == 403


def test_memory_tables_are_capped(monkeypatch):
    monkeypatch.setattr(store_module, "MAX_TRACKED", 100)
    store = MemoryStore()

    async def flood():
        for n in range(1000):
            await store.hit(f"api:{n}", 60)
            await store.strike(f"10.{n}")

    asyncio.run(flood())
    assert len(store._counters) <= 100 and len(store._strikes) <= 100


def test_robots_lists_the_honeypots():
    robots = (Path(__file__).resolve().parents[2] / "public" / "robots.txt").read_text()
    for trap in ("/private-data/", "/backup-db/", "/admin-api/"):
        assert f"Disallow: {trap}" in robots
        assert limits.TRAP.search(trap)
