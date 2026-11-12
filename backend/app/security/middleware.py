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

from . import limits, rules, site
from .headers import REMOVED_HEADERS, SECURITY_HEADERS, security_header_items
from .settings import SecuritySettings
from .store import BAN_SECONDS, store_from_settings

logger = logging.getLogger("smartwatts.security")

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
        self._header_items = security_header_items()

    # Per-IP limits; attack mode (shield.py) scales them down.
    def scaled(self, limit: int) -> int:
        return limit

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

        async def send_with_headers(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                kept = [(k, v) for k, v in message.get("headers", [])
                        if k.lower() not in REMOVED_HEADERS and k.lower() not in _SECURITY_KEYS]
                message = {**message, "headers": kept + self._header_items}
            await send(message)

        headers = _headers(scope)
        violation = self._request_rule_violation(scope, headers)
        if violation:
            status, detail, extra = violation
            await json_response(send_with_headers, status, {"detail": detail}, extra)
            return

        ip = limits.client_ip(scope, headers, self.settings.client_ip_header)
        state = scope.setdefault("state", {})
        state["client_ip"] = ip
        receive = rules.limited_receive(receive, rules.body_limit(scope["path"]))
        try:
            if await self.store.ban_seconds(ip):
                raise Blocked(403, "Forbidden", {"Retry-After": str(BAN_SECONDS)})
            if limits.TRAP.search(scope["path"]):
                raise Blocked(404, "Not Found", strike="honeypot")
            if self.settings.rate_limits:
                receive = await self._rate_limits(scope, headers, ip, receive)
            await self.app(scope, receive, send_with_headers)
        except Blocked as blocked:
            if blocked.strike:
                await self.strike(ip, blocked.strike, scope)
            if not started:
                await json_response(send_with_headers, blocked.status, {"detail": blocked.detail}, blocked.headers)
            return
        except rules.BodyTooLarge:
            if not started:
                await json_response(send_with_headers, 413, {"detail": "Request body too large"})
            return
        except Exception:  # never let a stack trace, path or hostname reach the client
            logger.exception("Unhandled error on %s %s", scope.get("method"), scope.get("path", "")[:200])
            if not started:
                await json_response(send_with_headers, 500, {"detail": "Internal error"})
            return
        if state.get("security_strike"):
            await self.strike(ip, state["security_strike"], scope)

    async def strike(self, ip: str, reason: str, scope) -> None:
        banned = await self.store.strike(ip)
        logger.warning("security strike reason=%s ip=%s %s %s%s", reason, ip, scope.get("method"),
                       scope.get("path", "")[:200], " -> banned 15 min" if banned else "")


async def json_response(send, status: int, body: dict, headers: dict[str, str] | None = None) -> None:
    payload = json.dumps(body).encode()
    items = [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode()),
             (b"cache-control", b"no-store")]
    items += [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": items})
    await send({"type": "http.response.body", "body": payload})
