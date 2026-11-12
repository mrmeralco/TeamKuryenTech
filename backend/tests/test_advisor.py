from fastapi.testclient import TestClient

from app.advisor import AdvisorContext, compute_facts, deterministic_summary, unverified_figures
from app.auth import AuthUser
from app.main import app, require_user

client = TestClient(app)

CONTEXT = {
    "appliances": [
        {"name": "Aircon", "category": "cooling", "watts": 1000, "hoursPerDay": 8, "daysPerWeek": 7, "quantity": 1},
        {"name": "LG Refrigerator", "category": "refrigeration", "watts": 0, "testedKwhMonth": 26.1, "quantity": 1},
    ],
    "latestBill": {"periodStart": "2026-09-12", "periodEnd": "2026-10-11", "kwh": 200, "amountCentavos": 240000},
}


def facts_text():
    facts, _ = compute_facts(AdvisorContext.model_validate(CONTEXT))
    return [fact.text for fact in facts]


def test_calculator_figures_are_deterministic_and_use_the_right_basis():
    texts = facts_text()
    assert "Average cost from that bill: ₱12.00 per kWh (bill amount ÷ kWh)." in texts
    # 1000 W × 8 h × 30.4375 d = 243.50 kWh; × ₱12 = ₱2,922.00
    assert "1 × Aircon: 243.50 kWh per month (from wattage and schedule), about ₱2,922.00 per month." in texts
    # Tested label: 26.10 kWh/month, not multiplied by hours.
    assert "1 × LG Refrigerator: 26.10 kWh per month (manufacturer tested consumption), about ₱313.20 per month." in texts
    assert "Using Aircon 1 hour less per day saves about 30.44 kWh per month (about ₱365.25)." in texts
    assert "Estimated appliance total: 269.60 kWh per month (estimate, not a meter reading)." in texts
    assert compute_facts(None) == ([], [])


def test_reply_validation_accepts_cited_figures_and_rejects_invented_ones():
    facts, _ = compute_facts(AdvisorContext.model_validate(CONTEXT))
    assert unverified_figures("Cutting the aircon by an hour saves about ₱365.25 (30.44 kWh).", facts, "") == []
    assert unverified_figures("You'll save ₱1,000 and 25% every month.", facts, "") == ["₱1,000", "25%"]
    # Numbers the user typed are allowed back.
    assert unverified_figures("If you pay 3,000 pesos ...", facts, "My bill is 3,000 pesos") == []


def _mock_gemini(monkeypatch, reply_text, capture):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    class Response:
        is_error = False

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": reply_text}]}}]}

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, headers, json):
            capture.append(json)
            return Response()

    monkeypatch.setattr("app.main.httpx.AsyncClient", Client)


def _with_user(fn):
    previous = app.dependency_overrides.get(require_user)
    app.dependency_overrides[require_user] = lambda: AuthUser(uid="u1", sign_in_provider="anonymous")
    try:
        return fn()
    finally:
        if previous is None:
            app.dependency_overrides.pop(require_user, None)
        else:
            app.dependency_overrides[require_user] = previous


def test_chat_grounds_prompt_and_returns_validated_reply(monkeypatch):
    sent = []
    _mock_gemini(monkeypatch, "Use the aircon 1 hour less: about ₱365.25 saved per month.", sent)
    response = _with_user(lambda: client.post("/api/chat", json={
        "language": "en", "messages": [{"role": "user", "text": "How can I save?"}], "context": CONTEXT,
    }))
    assert response.status_code == 200
    body = response.json()
    assert body["validated"] is True and body["withheldFigures"] == []
    prompt = sent[0]["systemInstruction"]["parts"][0]["text"]
    assert "STRICT NUMBER RULE" in prompt and "₱365.25" in prompt


def test_chat_replaces_invented_figures_with_deterministic_summary(monkeypatch):
    sent = []
    _mock_gemini(monkeypatch, "Switch to an inverter and save ₱1,500 a month!", sent)
    response = _with_user(lambda: client.post("/api/chat", json={
        "language": "en", "messages": [{"role": "user", "text": "How can I save?"}], "context": CONTEXT,
    }))
    body = response.json()
    assert body["validated"] is False and body["withheldFigures"] == ["₱1,500"]
    assert "₱1,500" not in body["reply"]
    assert body["reply"] == deterministic_summary(*compute_facts(AdvisorContext.model_validate(CONTEXT)))


def test_chat_without_data_forbids_figures(monkeypatch):
    sent = []
    _mock_gemini(monkeypatch, "Unplug idle chargers and use natural light.", sent)
    response = _with_user(lambda: client.post("/api/chat", json={"language": "tl-taglish", "messages": [{"role": "user", "text": "Tips?"}]}))
    assert response.json()["validated"] is True
    prompt = sent[0]["systemInstruction"]["parts"][0]["text"]
    assert "FACTS: none available" in prompt and "Taglish" in prompt


def test_advisor_context_rejects_personal_identifiers():
    bad = {**CONTEXT, "latestBill": {**CONTEXT["latestBill"], "accountNumber": "123456789012"}}
    response = _with_user(lambda: client.post("/api/chat", json={"language": "en", "messages": [{"role": "user", "text": "Hi"}], "context": bad}))
    assert response.status_code == 422
    bad = {**CONTEXT, "address": "123 Mabini St"}
    response = _with_user(lambda: client.post("/api/chat", json={"language": "en", "messages": [{"role": "user", "text": "Hi"}], "context": bad}))
    assert response.status_code == 422
