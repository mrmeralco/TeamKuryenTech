import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import app
from app.security.headers import SECURITY_HEADERS
from app.security.middleware import SecurityMiddleware
from app.security.settings import load_security_settings

client = TestClient(app)


def assert_secure(response):
    for name, value in SECURITY_HEADERS.items():
        assert response.headers.get(name) == value, name
    assert "server" not in response.headers
    assert "x-powered-by" not in response.headers


def test_headers_present_on_404():
    response = client.get("/api/definitely-not-a-route")
    assert response.status_code == 404
    assert_secure(response)


def test_headers_present_on_api_response():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert_secure(response)


def test_unhandled_error_is_generic_500_with_headers():
    broken = FastAPI()

    @broken.get("/boom")
    def boom():
        raise RuntimeError("secret path C:\\server\\db.py and host db.internal")

    broken.add_middleware(SecurityMiddleware, settings=load_security_settings({"SMARTWATTS_ENV": "test"}))
    response = TestClient(broken).get("/boom")
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal error"}
    assert "db.internal" not in response.text
    assert_secure(response)


def test_server_header_from_app_is_removed():
    noisy = FastAPI()

    @noisy.get("/x")
    def x():
        from fastapi import Response
        return Response("ok", headers={"Server": "uvicorn/0.30", "X-Powered-By": "FastAPI"})

    noisy.add_middleware(SecurityMiddleware, settings=load_security_settings({"SMARTWATTS_ENV": "test"}))
    assert_secure(TestClient(noisy).get("/x"))


def test_csp_has_no_inline_scripts():
    script_src = next(p for p in SECURITY_HEADERS["Content-Security-Policy"].split("; ") if p.startswith("script-src"))
    assert "'unsafe-inline'" not in script_src


def test_vercel_json_headers_match_app_headers():
    config = json.loads((Path(__file__).resolve().parents[2] / "vercel.json").read_text(encoding="utf-8"))
    rule = next(r for r in config["headers"] if r["source"] == "/(.*)")
    vercel = {h["key"]: h["value"] for h in rule["headers"]}
    assert {k: v for k, v in vercel.items() if k in SECURITY_HEADERS} == SECURITY_HEADERS


def test_pages_have_no_inline_scripts():
    root = Path(__file__).resolve().parents[2]
    import re
    pages = [root / "index.html", root / "nfc.html", *sorted((root / "landing").glob("*.html"))]
    for page in pages:
        for tag in re.findall(r"<script\b[^>]*>", page.read_text(encoding="utf-8")):
            assert "src=" in tag or 'type="text/x-dc"' in tag, f"{page.name}: inline script {tag}"
