"""Allow-list validation for every API path and query parameter (step 4.1).

Applied to all routes as an app-wide dependency. A parameter the table doesn't know, or a value that doesn't
match its pattern, is a 400 before the route runs. Bodies are validated by Pydantic models (main.py,
notifications, assistant) and, for the Rentals routes, by the service's own checks (_clean_text: 1-200
characters, _parse_date: YYYY-MM-DD, enum and number checks) under the 100 KB body limit.
"""

from __future__ import annotations

import re

from fastapi import HTTPException, Request

ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")  # Firestore document ids (token_hex) and Firebase uids
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

PATH_RULES: dict[str, re.Pattern[str]] = {
    **{name: ID for name in (
        "pid", "unit_id", "meter_id", "assignment_id", "reading_id", "bill_id", "statement_id", "request_id",
        "invitation_id", "occupancy_id", "notification_id", "uid",
    )},
    "action": re.compile(r"^[a-z][a-z-]{0,31}$"),
}

QUERY_RULES: dict[str, re.Pattern[str]] = {
    "from": DATE, "to": DATE, "start": DATE, "end": DATE,
    "type": re.compile(r"^[a-z][a-z_-]{0,39}$"),
    "unitId": ID, "meterId": ID, "workspace": ID,
    "cursor": re.compile(r"^\d{1,6}$"),
    "limit": re.compile(r"^\d{1,4}$"),  # the service then enforces 1-100 with its own message
    "status": re.compile(r"^[a-z][a-z_]{0,31}$"),
}


async def validate_params(request: Request) -> None:
    if not request.url.path.startswith("/api/"):
        return  # pages: their query strings belong to the browser code (e.g. ?oobCode= on reset-password)
    if "full_path" in request.path_params:
        return  # the catch-all (security/site.py): an unknown /api path, answered with a plain 404
    for name, value in request.path_params.items():
        rule = PATH_RULES.get(name)
        if rule is None or not rule.match(str(value)):
            raise HTTPException(status_code=400, detail="Invalid request.")
    seen: set[str] = set()
    for name, value in request.query_params.multi_items():
        rule = QUERY_RULES.get(name)
        if rule is None or name in seen or not rule.match(value):
            raise HTTPException(status_code=400, detail="Invalid request.")
        seen.add(name)
