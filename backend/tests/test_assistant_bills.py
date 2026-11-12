"""Regression: "how much the previous bill i upload" must find saved bills in the right scope,
distinguish latest vs previous periods, and never turn errors or wrong scope into "no bills"."""

from datetime import UTC, datetime

import pytest

from app.assistant import harness
from app.assistant.router import get_llm, get_tools
from app.assistant.tools import AssistantTools
from app.main import app
from test_rentals_api import OWNER, OWNER2, TENANT, base, env, invite_tenant, make_property, ok  # noqa: F401

CHAT = "/api/assistant/chat"
USER_QUESTION = "how much the previous bill i upload"


@pytest.fixture()
def bot(env, monkeypatch):
    client, _, service = env
    state = {"tools": AssistantTools(service.store, service)}
    harness._rate.clear()
    monkeypatch.setenv("SMARTWATTS_ASSISTANT_DEBUG", "1")
    app.dependency_overrides[get_tools] = lambda: state["tools"]
    app.dependency_overrides[get_llm] = lambda: None  # AI disabled: deterministic answers must still be accurate
    yield client, service, state
    app.dependency_overrides.pop(get_tools, None)
    app.dependency_overrides.pop(get_llm, None)


def ask(client, headers, text, workspace=None):
    return ok(client.post(CHAT, headers=headers, json={"messages": [{"role": "user", "text": text}], "workspace": workspace or {"type": "personal"}}))


def save_bill(service, uid, doc_id, start, end, kwh, amount, saved, source="ocr"):
    # Same shape the browser writes after "Save bill" (firestore.rules validBill).
    data = {"periodStart": start, "periodEnd": end, "kwh": kwh, "source": source, "createdAt": saved}
    if amount is not None:
        data["amountCentavos"] = amount
    service.store.create(f"users/{uid}/bills", doc_id, data)


def facts(body):
    return {f["id"]: f for f in body["facts"]}


def test_newly_saved_personal_bill_is_retrieved_with_amount_period_and_source(bot):
    client, service, _ = bot
    save_bill(service, "owner", "b1", "2026-10-01", "2026-10-31", 212.5, 268_450, datetime(2026, 11, 12, 9, tzinfo=UTC))
    body = ask(client, OWNER, USER_QUESTION)
    latest = facts(body)["bill-latest"]
    assert "current charges of ₱2,684.50" in latest["text"] and "2026-10-01 to 2026-10-31" in latest["text"] and "212.50 kWh" in latest["text"]
    assert latest["kind"] == "bill_derived"
    assert "scanned from your bill photo on your device and confirmed by you, saved 2026-11-12" in latest["source"]
    assert body["recordsUsed"] is True and body["mode"] == "deterministic" and "₱2,684.50" in body["reply"]
    assert body["diagnostics"]["workspace"] == "personal" and body["diagnostics"]["tools"][0]["outcome"] == "records_found"
    assert "bills" in body["diagnostics"]["intents"]


def test_latest_period_previous_period_and_last_uploaded_are_distinguished(bot):
    client, service, _ = bot
    save_bill(service, "owner", "oct", "2026-10-01", "2026-10-31", 250, 300_000, datetime(2026, 11, 2, tzinfo=UTC))
    save_bill(service, "owner", "sep", "2026-09-01", "2026-09-30", 200, 240_000, datetime(2026, 11, 10, tzinfo=UTC), source="manual")  # back-filled later
    body = ask(client, OWNER, "Compare my last two bills")
    f = facts(body)
    assert "2026-10-01 to 2026-10-31" in f["bill-latest"]["text"]
    assert "2026-09-01 to 2026-09-30" in f["bill-previous"]["text"] and "₱2,400.00" in f["bill-previous"]["text"]
    assert "2026-09-01 to 2026-09-30" in f["bill-last-saved"]["text"]  # most recently uploaded ≠ latest period
    assert "typed in and confirmed by you" in f["bill-previous"]["source"]
    assert "increased by 50.00 kWh" in f["bill-change"]["text"]


@pytest.mark.parametrize("question", [
    "How much was my previous bill?", "How much is the latest bill I uploaded?", "Show the amount from my MERALCO bill photo.",
    "What was my last electricity bill?", "How much did I pay last month?", "What is the amount due on my latest bill?",
])
def test_bill_question_variations_all_retrieve_bills(bot, question):
    client, service, _ = bot
    save_bill(service, "owner", "b1", "2026-10-01", "2026-10-31", 212.5, 268_450, datetime(2026, 11, 12, tzinfo=UTC))
    body = ask(client, OWNER, question)
    assert "bill-latest" in facts(body), question


def test_payment_and_amount_due_are_not_misrepresented(bot):
    client, service, _ = bot
    save_bill(service, "owner", "b1", "2026-10-01", "2026-10-31", 212.5, 268_450, datetime(2026, 11, 12, tzinfo=UTC))
    paid = ask(client, OWNER, "How much did I pay last month?")
    assert any("doesn't record payments" in m for m in paid["missing"])
    assert "paid ₱" not in paid["reply"].lower()
    due = ask(client, OWNER, "What is the amount due on my latest bill?")
    assert any("unpaid balance" in m for m in due["missing"])


def test_no_bill_explains_that_an_unsaved_scan_is_not_stored(bot):
    client, _, _ = bot
    body = ask(client, OWNER, USER_QUESTION)  # OCR preview without pressing Save leaves no record
    assert body["facts"] == [] and body["recordsUsed"] is False
    assert any("isn't stored until you review the figures" in m for m in body["missing"])
    assert body["diagnostics"]["tools"][0]["outcome"] == "no_records"


def test_bill_without_amount_is_reported_not_invented(bot):
    client, service, _ = bot
    save_bill(service, "owner", "b1", "2026-10-01", "2026-10-31", 212.5, None, datetime(2026, 11, 12, tzinfo=UTC))
    service.store.create("users/owner/bills", "broken", {"kwh": 10, "amountCentavos": 100})  # no billing period
    body = ask(client, OWNER, USER_QUESTION)
    assert "no amount saved" in facts(body)["bill-latest"]["text"]
    assert any("saved without an amount" in m for m in body["missing"])
    assert any("missing a billing period" in m for m in body["missing"])
    assert "₱" not in facts(body)["bill-latest"]["text"]


def test_storage_failure_is_never_reported_as_no_bills(bot):
    client, service, state = bot

    class BrokenStore:
        def query(self, *_args, **_kwargs):
            raise RuntimeError("firestore unavailable")

        def get(self, *_args, **_kwargs):
            raise RuntimeError("firestore unavailable")

    state["tools"] = AssistantTools(BrokenStore(), service)
    body = ask(client, OWNER, USER_QUESTION)
    assert body["retrieval"] == "partial_error"
    assert any("doesn't mean you have no bills" in m for m in body["missing"])
    assert not any("No saved bills were found" in m for m in body["missing"])


def test_rentals_scope_does_not_mix_personal_figures_but_offers_switch(bot):
    """The reported bug: owner asked in a Rentals property workspace while the bill was saved in Personal."""
    client, service, _ = bot
    pid = make_property(client)
    save_bill(service, "owner", "b1", "2026-10-01", "2026-10-31", 212.5, 268_450, datetime(2026, 11, 12, tzinfo=UTC))
    body = ask(client, OWNER, USER_QUESTION, {"type": "rental", "propertyId": pid})
    assert body["contextLabel"].startswith("SmartWatts Rentals")
    assert "₱2,684.50" not in str(body)  # never mixes Personal figures into the Rentals answer
    assert any("No utility bills are saved for this property" in m for m in body["missing"])
    assert any("You have 1 bill(s) saved in SmartWatts Personal" in m for m in body["missing"])
    assert body["scopeHint"] == {"switchTo": "personal", "personalBillCount": 1}
    # Switching to Personal then answers from the saved bill.
    assert "₱2,684.50" in ask(client, OWNER, USER_QUESTION)["reply"]


def test_owner_retrieves_newly_saved_property_bill(bot):
    client, _, _ = bot
    pid = make_property(client)
    meter = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "Main", "kind": "utility_individual"}), 201)
    ok(client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": meter["id"], "periodStart": "2026-09-01", "periodEnd": "2026-09-30", "totalKwh": "180", "amountCentavos": 216_000}), 201)
    body = ask(client, OWNER, USER_QUESTION, {"type": "rental", "propertyId": pid})
    assert "₱2,160.00" in facts(body)["pbill-1"]["text"] and body["scopeHint"] is None


def test_cross_account_and_cross_property_bills_are_never_returned(bot):
    client, service, _ = bot
    save_bill(service, "owner2", "theirs", "2026-10-01", "2026-10-31", 999, 777_700, datetime(2026, 11, 12, tzinfo=UTC))
    mine = ask(client, OWNER, USER_QUESTION)
    assert "₱7,777.00" not in str(mine) and mine["facts"] == []
    other_pid = make_property(client, OWNER2, name="Other Place")
    assert client.post(CHAT, headers=OWNER, json={"messages": [{"role": "user", "text": USER_QUESTION}],
                                                  "workspace": {"type": "rental", "propertyId": other_pid}}).status_code == 404


def test_tenant_sees_only_published_statements_and_gets_scope_hint(bot):
    client, service, _ = bot
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    invite_tenant(client, pid, unit["id"])
    save_bill(service, "tenant", "own", "2026-10-01", "2026-10-31", 150, 180_000, datetime(2026, 11, 12, tzinfo=UTC))
    body = ask(client, TENANT, USER_QUESTION, {"type": "rental", "propertyId": pid})
    assert not any(f["id"].startswith("pbill-") for f in body["facts"])  # no owner utility bills for tenants
    assert any("hasn't published" in m for m in body["missing"])
    assert body["scopeHint"]["switchTo"] == "personal" and "₱1,800.00" not in str(body)


def test_diagnostics_are_hidden_unless_debug_enabled(bot, monkeypatch):
    client, _, _ = bot
    monkeypatch.setenv("SMARTWATTS_ASSISTANT_DEBUG", "")
    assert ask(client, OWNER, USER_QUESTION)["diagnostics"] is None
