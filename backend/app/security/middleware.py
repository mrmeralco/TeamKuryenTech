"""One ASGI middleware in front of the whole app (pages and API).

Order of checks for every HTTP request:
  1. request rules (step 3): method allow-list, URL length, framing headers, Host, body size
  2. bans (step 5): a banned IP gets 403 + Retry-After
  3. honeypots (step 5): a strike, then a plain 404
  4. rate limits (step 5): pages, static files, API (+ burst, enumeration), auth endpoints
After the app answers, a strike the route flagged (scope["state"]["security_strike"]) is recorded.
Every response, including 404s and errors, leaves through `send_with_headers`, which adds the security headers
and strips headers that reveal the server. Unhandled exceptions become a generic 500.
"""

from __future__ import annotations

import hashlib
import json
import logging
from urllib.parse import parse_qs

from . import filters, limits, rules, site
from .headers import REMOVED_HEADERS, SECURITY_HEADERS, security_header_items
from .settings import SecuritySettings
from .shield import CLIENT_JS, COOKIE, Shield
from .store import BAN_SECONDS, store_from_settings

logger = logging.getLogger("smartwatts.security")
access_log = logging.getLogger("smartwatts.access")  # time comes from the log formatter / platform

_SECURITY_KEYS = frozenset(k.lower().encode("latin-1") for k in SECURITY_HEADERS)


def _headers(scope) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


class Blocked(Exception):
    def __init__(self, status: int, detail: str, headers: dict[str, str] | None = None, strike: str = ""):
        super().__init__(detail)
        self.status, self.detail, self.headers, self.strike = status, detail, headers or {}, strike


async def _buffered(receive):
    """Reads the whole (already size-limited) body and returns it with a receive callable that replays it."""
    chunks, more = [], True
    while more:
        message = await receive()
        if message["type"] != "http.request":
            break
        chunks.append(message.get("body", b""))
        more = message.get("more_body", False)
    body, replayed = b"".join(chunks), False

    async def replay():
        nonlocal replayed
        if not replayed:
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return body, replay


class SecurityMiddleware:
    def __init__(self, app, settings: SecuritySettings, store=None):
        self.app = app
        self.settings = settings
        self.store = store or store_from_settings(settings)
        self.shield = Shield(settings.bot_secret, settings.attack_mode_forced)
        self._header_items = security_header_items()

    # Per-IP limits; attack mode (shield.py) scales them down to a quarter.
    def scaled(self, limit: int) -> int:
        return self.shield.scaled(limit)

    async def _shield(self, scope, headers, send) -> bool:
        """Step 13. Serves /__c.js, /__t, /__v and gates pages / API on the signed cookie. True = answered."""
        path, ua = scope["path"], headers.get("user-agent", "")
        if path == "/__c.js":
            await raw_response(send, 200, CLIENT_JS.encode(), "text/javascript; charset=utf-8", {"Cache-Control": "no-cache"})
            return True
        if path == "/__t":  # a fresh puzzle for the in-app re-check (public/shield-client.js)
            await raw_response(send, 200, self.shield.token_json(), "application/json", {"Cache-Control": "no-store"})
            return True
        if path == "/__v":
            query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
            if not self.shield.pow_ok(query.get("t", [""])[0], query.get("n", [""])[0]):
                await raw_response(send, 403, b"Bad answer", "text/plain", {"Cache-Control": "no-store"})
                return True
            value, ttl = self.shield.cookie_value(ua)
            https = self.settings.production or scope.get("scheme") == "https" \
                or headers.get("x-forwarded-proto", "").startswith("https")
            cookie = f"{COOKIE}={value}; Path=/; Max-Age={ttl}; HttpOnly; SameSite=Lax" + ("; Secure" if https else "")
            await raw_response(send, 204, b"", "text/plain", {"Set-Cookie": cookie, "Cache-Control": "no-store"})
            return True
        if self.shield.verified(headers.get("cookie", ""), ua):
            return False
        if path.startswith("/api/"):
            if "x-api-key" in headers and path.startswith("/api/notifications/"):
                return False  # scheduler jobs: the route checks the key
            raise Blocked(403, "Verification required")
        if site.is_document(path) and not filters.is_search_bot(ua):
            await raw_response(send, 403, self.shield.challenge_page(), "text/html; charset=utf-8",
                               {"Cache-Control": "no-store"})
            return True
        return False

    def _request_rule_violation(self, scope, headers) -> tuple[int, str, dict[str, str]] | None:
        method = scope["method"]
        if method not in rules.ALLOWED_METHODS:
            return 405, "Method not allowed", {"Allow": rules.ALLOW_HEADER}
        raw_path = scope.get("raw_path") or scope["path"].encode()
        query = scope.get("query_string", b"")
        if len(raw_path) + (len(query) + 1 if query else 0) > rules.MAX_URL_LENGTH:
            return 414, "URI too long", {}
        if "transfer-encoding" in headers and "content-length" in headers:
            return 400, "Bad request", {}
        if not rules.host_allowed(headers.get("host", ""), self.settings.allowed_hosts, self.settings.production):
            return 400, "Bad request", {}
        declared = headers.get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > rules.body_limit(scope["path"])):
            return 413, "Request body too large", {}
        return None

    def _filter(self, scope, headers) -> None:
        """Step 12 request filters (filters.py). Blocked requests are strikes."""
        path = scope["path"]
        why = filters.attack_reason(path, scope.get("query_string", b"").decode("latin-1"), headers)
        if why:
            raise Blocked(403, "Forbidden", strike=why)
        if not self.settings.shield:
            return  # user-agent rules belong to the bot protection, on in production
        if "x-api-key" in headers and path.startswith("/api/notifications/"):
            return  # scheduler jobs (curl etc.) prove themselves with the key, checked by the route
        why = filters.ua_reason(headers.get("user-agent", ""), page=not path.startswith("/api/"))
        if why:
            raise Blocked(403, "Forbidden", strike=why)

    async def _limit(self, key: str, window: int, limit: int, detail: str = "Too many requests") -> None:
        count, reset = await self.store.hit(key, window)
        if count > self.scaled(limit):
            raise Blocked(429, detail, {"Retry-After": str(reset)})

    async def _rate_limits(self, scope, headers, ip: str, receive):
        path = scope["path"]
        if not path.startswith("/api/"):
            if site.is_document(path):
                await self._limit(f"page:{ip}", 60, limits.PAGE_LIMIT)
            else:
                await self._limit(f"asset:{ip}", 60, limits.ASSET_LIMIT)
            return receive

        await self._limit(f"api:{ip}", 60, limits.API_LIMIT)
        await self._limit(f"burst:{ip}", limits.BURST_WINDOW, limits.BURST_LIMIT, "Slow down")
        query = scope.get("query_string", b"").decode("latin-1")
        if await self.store.distinct(f"enum:{ip}", f"{path}?{query}", 60) > self.scaled(limits.ENUM_LIMIT):
            raise Blocked(429, "Too many requests", {"Retry-After": "60"}, strike="enumeration")

        if scope["method"] == "POST" and limits.AUTH_PATHS.match(path):
            await self._limit(f"auth-ip:{ip}", limits.AUTH_WINDOW, limits.AUTH_LIMIT, "Too many attempts. Try again later.")
            if "/password-reset/" in path:
                body, receive = await _buffered(receive)
                account = limits.body_email(body)
            else:
                account = limits.token_subject(headers.get("authorization", ""))
            if account:
                digest = hashlib.sha256(account.encode()).hexdigest()[:32]
                await self._limit(f"auth-acct:{digest}", limits.AUTH_WINDOW, limits.AUTH_LIMIT,
                                  "Too many attempts. Try again later.")
        return receive

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = False
        api = scope["path"].startswith("/api/")

        status_code = 0
        reason = ""

        async def send_with_headers(message):
            nonlocal started, status_code
            if message["type"] == "http.response.start":
                started = True
                status_code = message["status"]
                kept = [(k, v) for k, v in message.get("headers", [])
                        if k.lower() not in REMOVED_HEADERS and k.lower() not in _SECURITY_KEYS
                        and not (api and k.lower() == b"cache-control")]
                if api:  # signed-in data: a CDN or shared cache must never keep it
                    kept.append((b"cache-control", b"private, no-store"))
                message = {**message, "headers": kept + self._header_items}
            await send(message)

        headers = _headers(scope)
        ip = limits.client_ip(scope, headers, self.settings.client_ip_header)
        try:
            violation = self._request_rule_violation(scope, headers)
            if violation:
                status, reason, extra = violation
                await json_response(send_with_headers, status, {"detail": reason}, extra)
                return

            state = scope.setdefault("state", {})
            state["client_ip"] = ip
            receive = rules.limited_receive(receive, rules.body_limit(scope["path"]))
            try:
                if await self.store.ban_seconds(ip):
                    raise Blocked(403, "Forbidden", {"Retry-After": str(BAN_SECONDS)}, strike="")
                if limits.TRAP.search(scope["path"]):
                    raise Blocked(404, "Not Found", strike="honeypot")
                self._filter(scope, headers)
                self.shield.note_request()
                if self.settings.rate_limits:
                    receive = await self._rate_limits(scope, headers, ip, receive)
                if self.settings.shield and await self._shield(scope, headers, send_with_headers):
                    return
                await self.app(scope, receive, send_with_headers)
            except Blocked as blocked:
                reason = blocked.strike or ("banned" if blocked.status == 403 else blocked.detail)
                if blocked.strike:
                    await self.strike(ip, blocked.strike, scope)
                if not started:
                    await json_response(send_with_headers, blocked.status, {"detail": blocked.detail}, blocked.headers)
                return
            except rules.BodyTooLarge:
                reason = "body too large"
                if not started:
                    await json_response(send_with_headers, 413, {"detail": "Request body too large"})
                return
            except Exception:  # never let a stack trace, path or hostname reach the client
                reason = "unhandled error"
                logger.exception("Unhandled error on %s %s", scope.get("method"), scope.get("path", "")[:200])
                if not started:
                    await json_response(send_with_headers, 500, {"detail": "Internal error"})
                return
            if state.get("security_strike"):
                reason = state["security_strike"]
                await self.strike(ip, reason, scope)
        finally:
            # Never logged: bodies, cookies, Authorization / API keys, query strings.
            access_log.info("%s %s %s %s%s", ip, scope.get("method"), scope.get("path", "")[:200], status_code,
                            f" blocked={reason}" if reason else "")

    async def strike(self, ip: str, reason: str, scope) -> None:
        banned = await self.store.strike(ip)
        logger.warning("security strike reason=%s ip=%s %s %s%s", reason, ip, scope.get("method"),
                       scope.get("path", "")[:200], " -> banned 15 min" if banned else "")


async def raw_response(send, status: int, body: bytes, content_type: str, headers: dict[str, str]) -> None:
    items = [(b"content-type", content_type.encode()), (b"content-length", str(len(body)).encode())]
    items += [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()]
    await send({"type": "http.response.start", "status": status, "headers": items})
    await send({"type": "http.response.body", "body": body})


async def json_response(send, status: int, body: dict, headers: dict[str, str] | None = None) -> None:
    payload = json.dumps(body).encode()
    items = [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode()),
             (b"cache-control", b"no-store")]
    items += [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": items})
    await send({"type": "http.response.body", "body": payload})
