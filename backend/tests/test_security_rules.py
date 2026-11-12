from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.main import app
from app.security import site
from app.security.middleware import SecurityMiddleware
from app.security.settings import load_security_settings

client = TestClient(app)

PROD = {"SMARTWATTS_ENV": "production", "BOT_SECRET": "b" * 64, "ALLOWED_HOSTS": "smartwatts.vercel.app",
        "SMARTWATTS_SHIELD": "0"}


def tiny(env):
    small = FastAPI()

    @small.post("/api/echo")
    async def echo(request: Request):
        return {"size": len(await request.body())}

    @small.get("/api/ok")
    def ok():
        return {"ok": True}

    small.add_middleware(SecurityMiddleware, settings=load_security_settings(env))
    return TestClient(small, base_url="https://smartwatts.vercel.app")


def test_url_over_2000_chars_is_414():
    response = client.get("/api/health?x=" + "a" * 2001)
    assert response.status_code == 414
    assert response.headers["x-frame-options"] == "DENY"


def test_unused_method_is_405_with_allow_header():
    for method in ("DELETE", "TRACE", "CONNECT"):
        response = client.request(method, "/api/health")
        assert response.status_code == 405
        assert response.headers["allow"] == "GET, HEAD, POST, PUT, PATCH, OPTIONS"


def test_both_framing_headers_is_400():
    response = client.post("/api/translate", content=b"{}",
                           headers={"Transfer-Encoding": "chunked", "Content-Length": "2"})
    assert response.status_code == 400


def test_json_body_over_100kb_is_413():
    response = tiny({"SMARTWATTS_ENV": "test"}).post("/api/echo", content=b"x" * (100 * 1024 + 1))
    assert response.status_code == 413
    assert tiny({"SMARTWATTS_ENV": "test"}).post("/api/echo", content=b"x" * 1000).json() == {"size": 1000}


def test_streamed_body_without_length_is_capped():
    def chunks():
        for _ in range(30):
            yield b"y" * 8192

    response = tiny({"SMARTWATTS_ENV": "test"}).post("/api/echo", content=chunks())
    assert response.status_code == 413


def test_upload_routes_allow_larger_bodies():
    from app.security.rules import body_limit
    assert body_limit("/api/rentals/properties/p1/utility-bills/b1/document") > 10 * 1024 * 1024
    assert body_limit("/api/ai/appliance-label") == 15 * 1024 * 1024
    assert body_limit("/api/rentals/properties") == 100 * 1024


def test_production_rejects_unknown_host():
    prod = tiny(PROD)
    assert prod.get("/api/ok").status_code == 200
    assert prod.get("/api/ok", headers={"Host": "evil.example"}).status_code == 400


def test_vercel_deployment_urls_are_allowed():
    prod = tiny({**PROD, "VERCEL": "1", "VERCEL_URL": "smartwatts-abc123.vercel.app"})
    assert prod.get("/api/ok", headers={"Host": "smartwatts-abc123.vercel.app"}).status_code == 200


def test_unknown_api_route_is_plain_404():
    response = client.get("/api/nope/nothing")
    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


# ---- serving the built site from WEB_DIR ----------------------------------------------------------------------

def build(tmp_path):
    web = tmp_path / "dist"
    (web / "landing").mkdir(parents=True)
    (web / "assets").mkdir()
    (web / "index.html").write_text("<html>dashboard</html>")
    (web / "nfc.html").write_text("<html>nfc</html>")
    (web / "landing" / "index.html").write_text("<html>landing</html>")
    (web / "landing" / "login.html").write_text("<html>login</html>")
    (web / "assets" / "app-1234.js").write_text("console.log(1)")
    secret = tmp_path / "dist-secret"
    secret.mkdir()
    (secret / "key.txt").write_text("top secret")
    (tmp_path / ".env").write_text("BOT_SECRET=leak")
    return web


def test_site_serves_clean_urls(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_DIR", str(build(tmp_path)))
    assert client.get("/").text == "<html>landing</html>"
    assert client.get("/login").text == "<html>login</html>"
    dash = client.get("/dashboard")
    assert dash.text == "<html>dashboard</html>" and dash.headers["cache-control"] == "no-store"
    asset = client.get("/assets/app-1234.js")
    assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
    redirect = client.get("/landing/login.html", follow_redirects=False)
    assert redirect.status_code == 301 and redirect.headers["location"] == "/login"


def test_site_never_serves_outside_the_folder(tmp_path, monkeypatch):
    web = build(tmp_path)
    monkeypatch.setenv("WEB_DIR", str(web))
    for path in ("/../.env", "/..%2f.env", "/%2e%2e/.env", "/assets/../../.env", "/..\\.env",
                 "/../dist-secret/key.txt", "/missing.js"):
        response = client.get(path)
        assert response.status_code in (403, 404), path  # 403 when the step-12 filters catch the probe first
        assert "secret" not in response.text and "leak" not in response.text
    # prefix trick: "dist-secret" starts with "dist" but is not inside it
    assert site.contained(web, "../dist-secret/key.txt") is None
    assert site.contained(web, "assets/app-1234.js") is not None


def test_site_rejects_writes_to_pages(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_DIR", str(build(tmp_path)))
    response = client.post("/dashboard", json={})
    assert response.status_code == 405 and response.headers["allow"] == "GET, HEAD"
