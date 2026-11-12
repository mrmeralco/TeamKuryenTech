"""Serves the built web app (pages and static files) through FastAPI, so every page request passes the guards.

Two sources, picked from the environment:
  WEB_DIR  a local folder with the build (e.g. ../dist after `npm run build && node scripts/prepare-hosting.mjs`)
  WEB_URL  the internal URL of the Vercel `web` service (injected by the service binding in vercel.json)
Neither set (local development with the Vite dev server): no pages are served here.

Clean URLs mirror firebase.json / .htaccess: / -> landing/index.html, /login -> landing/login.html, /dashboard ->
index.html, /nfc -> nfc.html. A file path is resolved and must stay inside WEB_DIR (folder + separator check).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import httpx
from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response

PAGES = {
    "/": "landing/index.html",
    "/login": "landing/login.html",
    "/register": "landing/register.html",
    "/forgot-password": "landing/forgot-password.html",
    "/reset-password": "landing/reset-password.html",
    "/dashboard": "index.html",
    "/nfc": "nfc.html",
}
REDIRECTS = {
    "/index.html": "/",
    "/landing": "/",
    "/landing/": "/",
    "/landing/index.html": "/",
    "/landing/login.html": "/login",
    "/landing/register.html": "/register",
    "/landing/forgot-password.html": "/forgot-password",
    "/landing/reset-password.html": "/reset-password",
    "/dashboard/": "/dashboard",
    "/nfc/": "/nfc",
    "/nfc.html": "/nfc",
}
# Only plain file paths: no "..", no backslashes, no encoded tricks (the path is already percent-decoded here).
SAFE_PATH = re.compile(r"^/(?:[A-Za-z0-9_@~-][A-Za-z0-9._@~-]*/)*[A-Za-z0-9_@~-][A-Za-z0-9._@~-]*$")
DOCUMENT_CACHE = "no-store"  # pages depend on the browser-check cookie, so no shared cache may keep them


def web_dir() -> Path | None:
    value = os.getenv("WEB_DIR", "").strip()
    return Path(value).resolve() if value else None


def web_url() -> str:
    return os.getenv("WEB_URL", "").strip().rstrip("/")


def enabled() -> bool:
    return web_dir() is not None or bool(web_url())


def is_document(path: str) -> bool:
    """A page (not an asset): a clean URL with no file extension, or an .html file."""
    return path in PAGES or not re.search(r"\.[A-Za-z0-9]{1,6}$", path) or path.endswith(".html")


def contained(folder: Path, relative: str) -> Path | None:
    """Resolves `relative` inside `folder`; None unless the result is the folder itself or below it."""
    candidate = (folder / relative.lstrip("/")).resolve()
    if candidate != folder and not str(candidate).startswith(str(folder) + os.sep):
        return None
    return candidate


def cache_control(path: str) -> str:
    if path.startswith("/assets/"):
        return "public, max-age=31536000, immutable"  # content-hashed by Vite
    if path in {"/sw.js", "/registerSW.js", "/manifest.webmanifest"} or path.startswith("/workbox-"):
        return "no-cache"
    if path.endswith(".html"):
        return DOCUMENT_CACHE
    return "public, max-age=3600"


def not_found(path: str) -> Response:
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    return PlainTextResponse("Not found", status_code=404)


_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(10.0), follow_redirects=False)
    return _client


async def serve(request: Request) -> Response:
    path = request.url.path
    if path.startswith("/api/") or path == "/api":
        return not_found(path)
    if request.method not in ("GET", "HEAD"):
        return PlainTextResponse("Method not allowed", status_code=405, headers={"Allow": "GET, HEAD"})
    if path in REDIRECTS:
        query = f"?{request.url.query}" if request.url.query else ""
        return RedirectResponse(REDIRECTS[path] + query, status_code=301)

    page = PAGES.get(path)
    if page is None:
        if path.startswith("/landing/") and path.endswith(".html"):
            return not_found(path)  # landing pages only by their clean URL
        if not SAFE_PATH.match(path):
            return not_found(path)
        file_path = path.lstrip("/")
    else:
        file_path = page
    cache = DOCUMENT_CACHE if page else cache_control(path)

    folder = web_dir()
    if folder is not None:
        target = contained(folder, file_path)
        if target is None or not target.is_file():
            return not_found(path)
        return FileResponse(target, headers={"Cache-Control": cache})

    base = web_url()
    if not base:
        return not_found(path)
    try:
        upstream = await _http().get(f"{base}/{file_path}")
    except httpx.HTTPError:
        return PlainTextResponse("Service unavailable", status_code=503)
    if upstream.status_code != 200:
        return not_found(path)
    media_type = upstream.headers.get("content-type", "application/octet-stream")
    return Response(upstream.content, media_type=media_type, headers={"Cache-Control": cache})
