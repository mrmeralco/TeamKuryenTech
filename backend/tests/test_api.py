from fastapi.testclient import TestClient

from app.auth import AuthUser
from app.main import app, require_user

client = TestClient(app)


def allow_test_guest():
    return AuthUser(uid="test-guest", sign_in_provider="anonymous")


app.dependency_overrides[require_user] = allow_test_guest


def test_health_endpoint():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_chat_requires_a_server_api_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    response = client.post(
        "/api/chat",
        json={"language": "en", "messages": [{"role": "user", "text": "How can I save energy?"}]},
    )
    assert response.status_code == 503


def test_chat_requires_firebase_authentication():
    app.dependency_overrides.pop(require_user)
    try:
        response = client.post(
            "/api/chat",
            json={"language": "en", "messages": [{"role": "user", "text": "How can I save energy?"}]},
        )
    finally:
        app.dependency_overrides[require_user] = allow_test_guest
    assert response.status_code == 401


def test_chat_requires_latest_message_from_user():
    response = client.post(
        "/api/chat",
        json={"language": "en", "messages": [{"role": "assistant", "text": "Hello"}]},
    )
    assert response.status_code == 422


def test_chat_rejects_malformed_language_code():
    response = client.post(
        "/api/chat",
        json={"language": "not a language", "messages": [{"role": "user", "text": "Bonjour"}]},
    )
    assert response.status_code == 422


def test_translation_requires_a_server_api_key(monkeypatch):
    monkeypatch.delenv("GOOGLE_TRANSLATE_API_KEY", raising=False)
    response = client.get("/api/translate/languages")
    assert response.status_code == 503


def test_translation_language_list_requires_authentication():
    app.dependency_overrides.pop(require_user)
    try:
        response = client.get("/api/translate/languages")
    finally:
        app.dependency_overrides[require_user] = allow_test_guest
    assert response.status_code == 401


def test_translation_languages_and_text_are_proxied_server_side(monkeypatch):
    monkeypatch.setenv("GOOGLE_TRANSLATE_API_KEY", "server-only-test-key")

    class MockResponse:
        status_code = 200
        is_error = False

        def __init__(self, data):
            self.data = data

        def json(self):
            return self.data

    class MockAsyncClient:
        def __init__(self, *, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def request(self, method, _url, *, params, json=None):
            assert params["key"] == "server-only-test-key"
            if method == "GET":
                return MockResponse({"data": {"languages": [
                    {"language": "en", "name": "English"},
                    {"language": "es", "name": "Spanish"},
                ]}})
            assert json == {"q": ["Good morning", "Usage"], "target": "es", "format": "text"}
            return MockResponse({"data": {"translations": [
                {"translatedText": "Buenos días"},
                {"translatedText": "Uso"},
            ]}})

    monkeypatch.setattr("app.main.httpx.AsyncClient", MockAsyncClient)

    languages = client.get("/api/translate/languages")
    assert languages.status_code == 200
    assert languages.json() == {"languages": [
        {"code": "en", "name": "English"},
        {"code": "es", "name": "Spanish"},
    ]}

    translated = client.post(
        "/api/translate",
        json={"target": "es", "texts": ["Good morning", "Usage"]},
    )
    assert translated.status_code == 200
    assert translated.json() == {"translations": ["Buenos días", "Uso"]}


def test_translation_rejects_oversized_batches():
    response = client.post(
        "/api/translate",
        json={"target": "es", "texts": ["x" * 5000 for _ in range(6)]},
    )
    assert response.status_code == 422


def test_permanent_accounts_can_use_personal_ai_features(monkeypatch):
    """Anonymous-to-permanent upgrade keeps the uid; the upgraded token must still work."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    app.dependency_overrides[require_user] = lambda: AuthUser(uid="test-guest", sign_in_provider="password", email="a@b.co")
    try:
        response = client.post("/api/chat", json={"language": "en", "messages": [{"role": "user", "text": "Hi"}]})
    finally:
        app.dependency_overrides[require_user] = allow_test_guest
    assert response.status_code == 503  # reached the handler (no Gemini key), not rejected by auth


def test_plans_endpoint_lists_exactly_two_tiers():
    response = client.get("/api/plans")
    assert response.status_code == 200
    body = response.json()
    assert [tier["id"] for tier in body["tiers"]] == ["personal", "rentals"]
    assert body["tiers"][0]["priceCentavos"] == 0
    assert body["tiers"][1]["priceCentavos"] == 29900
    assert body["tiers"][1]["unitLimit"] == 10
    assert body["paymentsEnabled"] is False


def test_ai_appliance_label_requires_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    response = client.post(
        "/api/ai/appliance-label",
        json={"image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "mime_type": "image/png"},
    )
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_ai_appliance_label_requires_auth():
    app.dependency_overrides.pop(require_user)
    try:
        response = client.post(
            "/api/ai/appliance-label",
            json={"image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "mime_type": "image/png"},
        )
    finally:
        app.dependency_overrides[require_user] = allow_test_guest
    assert response.status_code == 401


def test_ai_appliance_label_rejects_invalid_mime_type():
    response = client.post(
        "/api/ai/appliance-label",
        json={"image_base64": "dGVzdC1kYXRh", "mime_type": "application/pdf"},
    )
    assert response.status_code == 422


def test_ai_appliance_label_success(monkeypatch):
    import json
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")

    mock_json = json.dumps({
        "brand": "Carrier",
        "model": "FP-53CAS010",
        "appliance_type": "Air Conditioner",
        "watts": 850,
        "voltage": "230V",
        "frequency": "60Hz",
        "current": "3.8A",
        "tested_kwh_month": None,
        "raw_text": "Carrier Inverter Air Conditioner FP-53CAS010 Rated Input 850W 230V 60Hz",
        "evidence": "Rated Input 850W",
        "confidence": "high",
        "notes": "Clear rating plate",
    })

    class MockAsyncClient:
        def __init__(self, *, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            assert headers["x-goog-api-key"] == "test-gemini-key"
            assert "gemini" in url
            class MockResponse:
                status_code = 200
                is_error = False
                def json(self):
                    return {
                        "candidates": [
                            {"content": {"parts": [{"text": mock_json}]}}
                        ]
                    }
            return MockResponse()

    monkeypatch.setattr("httpx.AsyncClient", MockAsyncClient)

    response = client.post(
        "/api/ai/appliance-label",
        json={
            "image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "mime_type": "image/png",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["brand"] == "Carrier"
    assert data["model"] == "FP-53CAS010"
    assert data["appliance_type"] == "Air Conditioner"
    assert data["watts"] == 850.0
    assert data["voltage"] == "230V"
    assert data["confidence"] == "high"
    assert data["label_type"] == "ELECTRICAL_SPECIFICATION"


def test_ai_appliance_energy_efficiency_label_success(monkeypatch):
    import json
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")

    mock_json = json.dumps({
        "label_type": "ENERGY_EFFICIENCY",
        "brand": "LG",
        "model": "GR-B202SQBB",
        "appliance_type": "Refrigerator",
        "watts": None,
        "voltage": "230V",
        "frequency": "60Hz",
        "current": None,
        "tested_kwh_month": 26.10,
        "tested_kwh_24h": 0.87,
        "tested_kwh_year": 313.2,
        "energy_efficiency_rating": 253.0,
        "raw_text": "ENERGY GUIDE Monthly Energy Consumption 26.10 kWh EER 253",
        "evidence": "Tested monthly energy consumption: 26.10 kWh. No electrical wattage printed on energy guide label.",
        "confidence": "high",
        "notes": "Energy Guide label with tested monthly consumption",
    })

    class MockAsyncClient:
        def __init__(self, *, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            class MockResponse:
                status_code = 200
                is_error = False
                def json(self):
                    return {
                        "candidates": [
                            {"content": {"parts": [{"text": mock_json}]}}
                        ]
                    }
            return MockResponse()

    monkeypatch.setattr("httpx.AsyncClient", MockAsyncClient)

    response = client.post(
        "/api/ai/appliance-label",
        json={
            "image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "mime_type": "image/png",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["brand"] == "LG"
    assert data["model"] == "GR-B202SQBB"
    assert data["appliance_type"] == "Refrigerator"
    assert data["watts"] is None
    assert data["tested_kwh_month"] == 26.10
    assert data["tested_kwh_24h"] == 0.87
    assert data["tested_kwh_year"] == 313.2
    assert data["energy_efficiency_rating"] == 253.0
    assert data["label_type"] == "ENERGY_EFFICIENCY"




def test_ai_appliance_identified_from_photo_without_label(monkeypatch):
    """A plain photo of an electric fan: the type is recognized, no specs are invented."""
    import json
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    mock_json = json.dumps({
        "brand": None, "model": None, "appliance_type": "Electric fan",
        "identified_from": "object", "size_hint": "16-inch stand fan",
        "watts": None, "label_type": "UNKNOWN", "evidence": "No rating label visible", "confidence": "medium",
    })

    class MockAsyncClient:
        def __init__(self, *, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            assert "even when nothing is printed" in json["contents"][0]["parts"][1]["text"]

            class MockResponse:
                status_code = 200
                is_error = False

                def json(self):
                    return {"candidates": [{"content": {"parts": [{"text": mock_json}]}}]}
            return MockResponse()

    monkeypatch.setattr("httpx.AsyncClient", MockAsyncClient)
    response = client.post("/api/ai/appliance-label", json={
        "image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "mime_type": "image/png",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["appliance_type"] == "Electric fan"
    assert data["identified_from"] == "object"
    assert data["size_hint"] == "16-inch stand fan"
    assert data["watts"] is None
