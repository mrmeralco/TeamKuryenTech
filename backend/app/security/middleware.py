"""One ASGI middleware in front of the whole app (pages and API).

Order of checks for every HTTP request:
  1. request rules (step 3): method allow-list, URL length, framing headers, Host, body size
Every response, including 404s and errors, leaves through `send_with_headers`, which adds the security headers
and strips headers that reveal the server. Unhandled exceptions become a generic 500.
"""

from __future__ import annotations

import json
import logging

from . import rules
from .headers import REMOVED_HEADERS, SECURITY_HEADERS, security_header_items
from .settings import SecuritySettings

logger = logging.getLogger("smartwatts.security")

_SECURITY_KEYS = frozenset(k.lower().encode("latin-1") for k in SECURITY_HEADERS)


def _headers(scope) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


class SecurityMiddleware:
    def __init__(self, app, settings: SecuritySettings):
        self.app = app
        self.settings = settings
        self._header_items = security_header_items()

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

        receive = rules.limited_receive(receive, rules.body_limit(scope["path"]))
        try:
            await self.app(scope, receive, send_with_headers)
        except rules.BodyTooLarge:
            if not started:
                await json_response(send_with_headers, 413, {"detail": "Request body too large"})
        except Exception:  # never let a stack trace, path or hostname reach the client
            logger.exception("Unhandled error on %s %s", scope.get("method"), scope.get("path", "")[:200])
            if not started:
                await json_response(send_with_headers, 500, {"detail": "Internal error"})


async def json_response(send, status: int, body: dict, headers: dict[str, str] | None = None) -> None:
    payload = json.dumps(body).encode()
    items = [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode()),
             (b"cache-control", b"no-store")]
    items += [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": items})
    await send({"type": "http.response.body", "body": payload})
