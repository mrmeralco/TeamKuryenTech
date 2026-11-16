"""vercel.json routing: /api and the browser-check endpoints reach FastAPI (`app`); pages and assets reach the
static Vite build (`web`). Mirrors Vercel's rules: redirects first, then rewrites in order, first match wins."""

import importlib
import json
import re
from pathlib import Path

import pytest

from app.security import site

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
CLEAN_PAGES = ["/", "/login", "/register", "/forgot-password", "/reset-password", "/dashboard", "/nfc"]


def _pattern(source: str) -> re.Pattern:
    """The subset of path-to-regexp used in vercel.json: literal paths, `/:name*` and `(.*)`."""
    out, i = "", 0
    while i < len(source):
        if source.startswith("/:", i):
            name = re.match(r"/:(\w+)(\*)?", source[i:])
            out += r"(?:/.*)?" if name.group(2) else r"/[^/]+"
            i += len(name.group(0))
        elif source.startswith("(.*)", i):
            out += ".*"
            i += 4
        else:
            out += re.escape(source[i])
            i += 1
    return re.compile(f"^{out}$")


def resolve(path: str):
    for rule in CONFIG.get("redirects", []):
        if _pattern(rule["source"]).match(path):
            return ("redirect", rule["destination"])
    for rule in CONFIG["rewrites"]:
        if _pattern(rule["source"]).match(path):
            dest = rule["destination"]
            return (dest["service"], dest.get("path", path))
    return (None, path)


@pytest.mark.parametrize("path", ["/api/health", "/api", "/api/account/workspaces", "/api/auth/status",
                                  "/__c.js", "/__t", "/__v"])
def test_api_and_browser_check_reach_fastapi(path):
    assert resolve(path) == ("app", path)  # FastAPI sees the original path (no prefix stripping)


@pytest.mark.parametrize("path", CLEAN_PAGES)
def test_clean_pages_reach_web_with_the_same_files_as_fastapi_and_firebase(path):
    service, target = resolve(path)
    assert service == "web"
    assert target == "/" + site.PAGES[path]
    firebase = json.loads((ROOT / "firebase.json").read_text(encoding="utf-8"))["hosting"]["rewrites"]
    assert {r["source"]: r.get("destination") for r in firebase}[path] == target
    assert (ROOT / target.lstrip("/")).is_file()  # source page exists (landing/*.html, index.html, nfc.html)


@pytest.mark.parametrize("path", ["/assets/main-abc.js", "/assets/main.css", "/landing/auth.js", "/sw.js",
                                  "/manifest.webmanifest", "/registerSW.js", "/smartwatts-icon-192.png",
                                  "/shield-client.js", "/index.html", "/nfc.html", "/robots.txt"])
def test_assets_reach_web_unchanged(path):
    assert resolve(path) == ("web", path)


def test_service_worker_precache_files_are_not_redirected():
    # dist/sw.js precaches index.html and nfc.html and falls back to index.html: they must stay plain files.
    sources = {r["source"] for r in CONFIG["redirects"]}
    assert not sources & {"/index.html", "/nfc.html"}


@pytest.mark.parametrize("path,target", [("/landing/login.html", "/login"), ("/landing/", "/"),
                                         ("/dashboard/", "/dashboard"), ("/nfc/", "/nfc")])
def test_legacy_urls_redirect_to_clean_ones(path, target):
    assert resolve(path) == ("redirect", target)


def test_services_shape():
    services = CONFIG["services"]
    assert set(services) == {"web", "app"}
    web, app = services["web"], services["app"]
    assert web["buildCommand"] == "npm run build:prod" and web["outputDirectory"] == "dist"
    assert app["root"] == "backend" and "bindings" not in app  # FastAPI no longer proxies pages
    module, attr = app["entrypoint"].split(":")
    assert getattr(importlib.import_module(module), attr).title == "SmartWatts API"
    assert CONFIG["rewrites"][-1] == {"source": "/(.*)", "destination": {"service": "web"}}
    assert all(r["destination"]["service"] in services for r in CONFIG["rewrites"])
