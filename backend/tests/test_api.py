from fastapi.testclient import TestClient

from app.main import app, require_guest

client = TestClient(app)


def allow_test_guest():
    return "test-guest"


app.dependency_overrides[require_guest] = allow_test_guest


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


def test_chat_requires_firebase_guest_authentication():
    app.dependency_overrides.pop(require_guest)
    try:
        response = client.post(
            "/api/chat",
            json={"language": "en", "messages": [{"role": "user", "text": "How can I save energy?"}]},
        )
    finally:
        app.dependency_overrides[require_guest] = allow_test_guest
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


def test_translation_language_list_requires_guest_authentication():
    app.dependency_overrides.pop(require_guest)
    try:
        response = client.get("/api/translate/languages")
    finally:
        app.dependency_overrides[require_guest] = allow_test_guest
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
