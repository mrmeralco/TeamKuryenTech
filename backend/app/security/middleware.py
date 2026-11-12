"""One ASGI middleware in front of the whole app (pages and API).

Every response, including 404s and errors, leaves through `_send_with_headers`, which adds the security
headers and strips headers that reveal the server. Unhandled exceptions become a generic 500.
"""

from __future__ import annotations

import json
import logging

from .headers import REMOVED_HEADERS, SECURITY_HEADERS, security_header_items
from .settings import SecuritySettings

logger = logging.getLogger("smartwatts.security")

_SECURITY_KEYS = frozenset(k.lower().encode("latin-1") for k in SECURITY_HEADERS)


class SecurityMiddleware:
    def __init__(self, app, settings: SecuritySettings):
        self.app = app
        self.settings = settings
        self._header_items = security_header_items()

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

        try:
            await self.app(scope, receive, send_with_headers)
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
