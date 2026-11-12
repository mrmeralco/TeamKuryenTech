"""Hardened uvicorn launcher for running the API (and the built site) on a VPS / container / locally.

On Vercel this file is not used: the platform runs the app as a function and owns the HTTP server, timeouts,
process user and open ports. Uncaught errors are handled by the security middleware either way.

    cd backend && python serve.py            # 127.0.0.1:8000
    HOST=0.0.0.0 PORT=8080 python serve.py   # in a container (run it as a non-root user, expose only PORT)

Node's server.headersTimeout / requestTimeout / maxHeadersCount / maxRequestsPerSocket have these uvicorn
equivalents: idle keep-alive 5 s, request-line + headers capped at 16 KB (h11), at most 100 concurrent
connections before 503, worker recycled after 10,000 requests, X-Forwarded-For not trusted, no Server header.
"""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

UVICORN_SETTINGS = {
    "timeout_keep_alive": 5,
    "h11_max_incomplete_event_size": 16 * 1024,
    "limit_concurrency": 100,
    "limit_max_requests": 10_000,
    "timeout_graceful_shutdown": 10,
    "proxy_headers": False,
    "server_header": False,
    "date_header": True,
    "access_log": False,  # the security middleware writes its own access log without secrets
}


def main() -> None:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        sys.exit("Refusing to run as root: start the server as an unprivileged user.")

    def log_unhandled(exc_type, exc, tb):  # last resort: log, don't print a raw traceback to clients
        logging.getLogger("smartwatts").critical("Uncaught exception", exc_info=(exc_type, exc, tb))

    sys.excepthook = log_unhandled
    uvicorn.run("app.main:app", host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8000")),
                **UVICORN_SETTINGS)


if __name__ == "__main__":
    main()
