import logging

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_access_log_line_without_secrets(caplog):
    with caplog.at_level(logging.INFO, logger="smartwatts.access"):
        client.post("/api/translate?q=secret-query", json={"target": "tl", "texts": ["my password is hunter2"]},
                    headers={"Authorization": "Bearer super-secret-token", "Cookie": "sw_v=cookie-secret"})
    line = next(r.getMessage() for r in caplog.records if r.name == "smartwatts.access")
    assert " POST /api/translate " in line
    for secret in ("hunter2", "super-secret-token", "cookie-secret", "secret-query"):
        assert secret not in caplog.text


def test_blocked_requests_log_the_reason(caplog):
    with caplog.at_level(logging.INFO, logger="smartwatts.access"):
        client.request("TRACE", "/api/health")
    assert any("blocked=Method not allowed" in r.getMessage() for r in caplog.records)


def test_long_paths_are_truncated_in_logs(caplog):
    with caplog.at_level(logging.INFO, logger="smartwatts.access"):
        client.get("/api/" + "x" * 1500)
    message = next(r.getMessage() for r in caplog.records if r.name == "smartwatts.access")
    assert "x" * 200 not in message


def test_validation_errors_do_not_echo_input():
    response = client.post("/api/auth/password-reset/send", json={"email": "<script>" + "x" * 300})
    assert response.status_code == 422
    assert "<script>" not in response.text
    assert response.json()["detail"][0]["loc"] == ["body", "email"]


def test_unknown_route_is_real_404():
    assert client.get("/api/does/not/exist").status_code == 404
