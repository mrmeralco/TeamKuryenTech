"""Request rules checked before any routing (step 3): methods, URL length, framing headers, Host, body size."""

from __future__ import annotations

import re

ALLOWED_METHODS = ("GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS")
ALLOW_HEADER = ", ".join(ALLOWED_METHODS)
MAX_URL_LENGTH = 2000

DEFAULT_BODY_LIMIT = 100 * 1024  # JSON bodies
# Larger bodies only where the feature needs them. (Vercel itself caps request bodies at 4.5 MB.)
BODY_LIMITS: tuple[tuple[re.Pattern[str], int], ...] = (
    # Appliance label photo, sent as base64 JSON.
    (re.compile(r"^/api/ai/appliance-label$"), 15 * 1024 * 1024),
    # Meter-reading evidence and utility-bill documents (raw file bodies, 10 MB service limit).
    (re.compile(r"^/api/rentals/properties/[^/]+/readings/[^/]+/evidence$"), 10 * 1024 * 1024 + 1024),
    (re.compile(r"^/api/rentals/properties/[^/]+/utility-bills/[^/]+/document$"), 10 * 1024 * 1024 + 1024),
    # Up to 80 strings / 25,000 characters for translation; chat history plus the user's appliance context.
    (re.compile(r"^/api/translate$"), 256 * 1024),
    (re.compile(r"^/api/(chat|assistant/chat)$"), 256 * 1024),
)

LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]", "testserver")


def body_limit(path: str) -> int:
    for pattern, limit in BODY_LIMITS:
        if pattern.match(path):
            return limit
    return DEFAULT_BODY_LIMIT


def host_name(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):
        return host.split("]")[0] + "]"
    return host.split(":")[0]


def host_allowed(host_header: str, allowed: tuple[str, ...], production: bool) -> bool:
    """Production: only ALLOWED_HOSTS (plus the deployment's own Vercel URLs). Elsewhere: no restriction."""
    if not production:
        return True
    return host_name(host_header) in allowed


class BodyTooLarge(Exception):
    pass


def limited_receive(receive, limit: int):
    """Wraps the ASGI receive callable so a streamed body (no Content-Length) can't exceed the limit either."""
    received = 0

    async def wrapped():
        nonlocal received
        message = await receive()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > limit:
                raise BodyTooLarge()
        return message

    return wrapped
