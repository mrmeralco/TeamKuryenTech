import shutil
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from google.genai import types

from app.config import Settings
from app.main import create_app
from tests.conftest import render_text_image
from tests.test_ocr import BILL_TEXT

HOUSEHOLD = {
    "bills": [
        {"periodStart": "2026-01-15", "periodEnd": "2026-02-14", "kwh": 250, "amountPhp": 3100},
        {"periodStart": "2026-02-15", "periodEnd": "2026-03-16", "kwh": 280, "amountPhp": 3500},
    ],
    "rate": {"valuePhpPerKwh": 12.43, "source": "reference", "label": "test fixture", "month": "2026-06"},
    "appliances": [
        {"id": "fan1", "name": "Electric fan", "type": "fan", "wattage": 65, "quantity": 1, "hoursPerDay": 8, "daysPerPeriod": 30},
        {"id": "ac1", "name": "Aircon", "type": "aircon", "wattage": 1000, "quantity": 1, "hoursPerDay": 8, "daysPerPeriod": 30, "variablePower": True},
    ],
}


def settings(**kw):
    base = dict(gemini_api_key=None, gemini_model="test-model", cors_origins=["http://localhost:5173"], max_upload_bytes=8 * 1024 * 1024,
                ocr_rate_per_minute=100, advisor_rate_per_minute=100, ai_timeout_seconds=5)
    base.update(kw)
    return Settings(**base)


class FakeModels:
    """Scripted Gemini: first asks for the calculator, then answers using its result."""

    def __init__(self, final_text):
        self.calls = []
        self.final_text = final_text

    def generate_content(self, model, contents, config):
        self.calls.append(contents)
        if len(self.calls) == 1:
            call = types.FunctionCall(name="simulate_usage_change", args={"appliance_id": "fan1", "new_hours_per_day": 6})
            content = types.Content(role="model", parts=[types.Part(function_call=call)])
            return SimpleNamespace(function_calls=[call], candidates=[SimpleNamespace(content=content)], text=None)
        return SimpleNamespace(function_calls=None, candidates=[], text=self.final_text)


def test_health_reports_capabilities_without_secrets():
    c = TestClient(create_app(settings(gemini_api_key="secret-key")))
    r = c.get("/api/health").json()
    assert r["aiAvailable"] is True and "secret-key" not in str(r)


def test_cors_restricted():
    c = TestClient(create_app(settings()))
    ok = c.options("/api/health", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    bad = c.options("/api/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "access-control-allow-origin" not in bad.headers


def test_ocr_rejects_wrong_type_and_bad_image():
    c = TestClient(create_app(settings()))
    r = c.post("/api/ocr/bill", files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 415 and r.json()["detail"]["code"] == "unsupported_type"
    r = c.post("/api/ocr/bill", files={"file": ("a.png", b"not png", "image/png")})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_image"


def test_ocr_rejects_oversize():
    c = TestClient(create_app(settings(max_upload_bytes=1000)))
    r = c.post("/api/ocr/bill", files={"file": ("a.png", render_text_image(["hello"]), "image/png")})
    assert r.status_code == 422


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract binary not installed")
def test_ocr_bill_end_to_end_returns_only_structured_fields():
    c = TestClient(create_app(settings()))
    png = render_text_image(BILL_TEXT.strip().splitlines())
    r = c.post("/api/ocr/bill", files={"file": ("bill.png", png, "image/png")})
    assert r.status_code == 200
    body = r.json()
    assert body["fields"]["kwh"] == 280 and body["fields"]["totalAmountPhp"] == 3500
    assert "1234567890" not in r.text and "JUAN" not in r.text.upper()


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract binary not installed")
def test_ocr_label_end_to_end():
    c = TestClient(create_app(settings()))
    png = render_text_image(["Electric Fan", "220V 60Hz", "Rated Power: 65W"], fmt="JPEG")
    r = c.post("/api/ocr/label", files={"file": ("label.jpg", png, "image/jpeg")})
    assert r.status_code == 200 and r.json()["suggestedWattage"] == 65


def test_advisor_unavailable_without_key_is_honest():
    c = TestClient(create_app(settings()))
    r = c.post("/api/advisor/chat", json={"message": "Bakit ang taas ng kuryente namin?", "household": HOUSEHOLD})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "ai_unavailable"
    assert "reply" not in r.json()


def test_advisor_validates_request():
    c = TestClient(create_app(settings(gemini_api_key="k")))
    bad = dict(HOUSEHOLD, appliances=[dict(HOUSEHOLD["appliances"][0], hoursPerDay=30)])
    r = c.post("/api/advisor/chat", json={"message": "hi", "household": bad})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_request"
    r = c.post("/api/advisor/chat", json={"message": "", "household": HOUSEHOLD})
    assert r.status_code == 422


def test_advisor_uses_calculator_tool_and_verifies_figures():
    fake = FakeModels("Kung 6 oras na lang ang electric fan, makakatipid ka ng mga 3.9 kWh o ₱48.48 (estimate).")
    app = create_app(settings(gemini_api_key="k"), genai_client_factory=lambda key: SimpleNamespace(models=fake))
    r = TestClient(app).post("/api/advisor/chat", json={"message": "What if 6 hours fan instead of 8?", "household": HOUSEHOLD})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["toolCalls"][0]["result"]["savedKwh"] == 3.9
    assert body["toolCalls"][0]["result"]["savedPhp"] == 48.48
    assert body["unverifiedFigures"] == []
    # facts are grounded in the household data
    assert body["facts"]["billChangeVsPrevious"] == {"kwhChange": 30, "amountChangePhp": 400, "previousPeriodEnd": "2026-02-14"}
    assert body["facts"]["appliances"][0]["name"] == "Aircon"  # sorted by estimated kWh


def test_advisor_flags_invented_numbers():
    fake = FakeModels("Your aircon costs ₱9,999.00 and uses 777 kWh.")
    app = create_app(settings(gemini_api_key="k"), genai_client_factory=lambda key: SimpleNamespace(models=fake))
    body = TestClient(app).post("/api/advisor/chat", json={"message": "aircon?", "household": HOUSEHOLD}).json()
    assert len(body["unverifiedFigures"]) == 2


def test_advisor_provider_failure_is_503():
    class Boom:
        def generate_content(self, **kw):
            raise TimeoutError("network")
    app = create_app(settings(gemini_api_key="k"), genai_client_factory=lambda key: SimpleNamespace(models=Boom()))
    r = TestClient(app).post("/api/advisor/chat", json={"message": "hi", "household": HOUSEHOLD})
    assert r.status_code == 503 and "network" not in r.text


def test_rate_limit():
    c = TestClient(create_app(settings(advisor_rate_per_minute=2)))
    codes = [c.post("/api/advisor/chat", json={"message": "x", "household": HOUSEHOLD}).status_code for _ in range(3)]
    assert codes == [503, 503, 429]


def test_calc_endpoint_matches_spec(spec):
    c = TestClient(create_app(settings()))
    case = spec["scenarioCases"][0]
    r = c.post("/api/calc/compare", json={"baseline": case["baseline"], "scenario": case["scenario"], "rate": case["rate"]}).json()
    assert r["savedKwh"] == 3.9 and r["savedPhp"] == 48.48
    bad = c.post("/api/calc/compare", json={"baseline": case["baseline"], "scenario": dict(case["scenario"], hoursPerDay=25), "rate": 12.43})
    assert bad.status_code == 422


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract binary not installed")
def test_ocr_bill_reports_confidence_and_field_status():
    c = TestClient(create_app(settings()))
    png = render_text_image(["Billing Period Jan 15, 2026 to Feb 14, 2026", "Total kWh Used 280 kWh"])
    body = c.post("/api/ocr/bill", files={"file": ("bill.png", png, "image/png")}).json()
    assert body["fieldStatus"] == {"periodStart": "read", "periodEnd": "read", "kwh": "read", "totalAmountPhp": "not_found"}
    assert 0 <= body["confidence"] <= 100
    assert body["lowConfidence"] is False


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract binary not installed")
def test_ocr_blank_image_is_low_confidence_not_an_error():
    c = TestClient(create_app(settings()))
    body = c.post("/api/ocr/bill", files={"file": ("blank.png", render_text_image([]), "image/png")}).json()
    assert body["lowConfidence"] is True and body["confidence"] is None
    assert all(v == "not_found" for v in body["fieldStatus"].values())
