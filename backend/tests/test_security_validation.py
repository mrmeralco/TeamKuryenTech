import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security.validation import PATH_RULES

client = TestClient(app)


@pytest.mark.parametrize("path", [
    "/api/rentals/properties/abc$def",            # character outside the id allow-list
    "/api/rentals/properties/" + "a" * 129,       # id longer than 128
    "/api/platform/subscriptions/p1/DROP",        # action must be lower-case letters / dashes
])
def test_bad_path_parameters_are_400(path):
    response = client.get(path) if "subscriptions" not in path else client.post(path, json={})
    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid request."}


@pytest.mark.parametrize("query", [
    "from=2026-13", "from=1%27%20OR%201=1", "limit=abc", "cursor=-1", "unknown=1", "limit=5&limit=6",
])
def test_bad_query_parameters_are_400(query):
    # 403 when the step-12 injection filter refuses the request before validation runs
    assert client.get(f"/api/rentals/properties/p1/analytics?{query}").status_code in (400, 403)


def test_every_route_parameter_has_a_rule():
    from fastapi.routing import APIRoute
    names = {p.name for r in app.routes if isinstance(r, APIRoute) for p in r.dependant.path_params}
    assert names - {"full_path"} <= set(PATH_RULES)


def test_page_query_strings_are_left_to_the_page():
    assert client.get("/login?oobCode=abc&mode=resetPassword").status_code == 404  # no WEB_DIR here, but not 400


def test_server_side_fetches_only_go_to_fixed_hosts():
    backend = Path(__file__).resolve().parents[1] / "app"
    # headers.py only lists browser CSP sources; it makes no requests.
    source = "\n".join(p.read_text(encoding="utf-8") for p in backend.rglob("*.py") if p.name != "headers.py")
    hosts = set(re.findall(r"https://([a-z0-9.-]+)", source))
    assert hosts <= {"generativelanguage.googleapis.com", "translation.googleapis.com", "www.googleapis.com",
                     "smartwatts.vercel.app", "example.com"}, hosts
