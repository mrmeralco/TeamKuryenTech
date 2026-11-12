"""Grounded Energy Advisor (flowchart step 14).

Pipeline:
  validate request -> compute deterministic household facts -> LLM (Gemini) with a
  calculator tool -> execute tool calls with energy.py -> generate answer ->
  check the answer's peso/kWh figures against computed numbers -> return.

The LLM never does arithmetic that we show as fact: any peso or kWh figure it
mentions that does not match a computed value is flagged as unverified.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from . import energy


# ------------------------------------------------------------------ schemas

class RateIn(BaseModel):
    valuePhpPerKwh: float = Field(gt=0, le=energy.MAX_RATE)
    source: Literal["bill_derived", "user_entered", "reference"]
    label: str = Field(max_length=160)
    month: str = Field(max_length=20)


class BillIn(BaseModel):
    periodStart: str = Field(max_length=10)
    periodEnd: str = Field(max_length=10)
    kwh: float = Field(ge=0, le=100000)
    amountPhp: float = Field(ge=0, le=10_000_000)


class ApplianceIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=60)
    type: str = Field(max_length=30)
    wattage: float = Field(gt=0, le=10000)
    quantity: int = Field(ge=1, le=100)
    hoursPerDay: float = Field(ge=0, le=24)
    daysPerPeriod: float = Field(gt=0, le=energy.MAX_DAYS)
    variablePower: bool = False


class HouseholdIn(BaseModel):
    bills: list[BillIn] = Field(default_factory=list, max_length=36)
    rate: RateIn | None = None
    appliances: list[ApplianceIn] = Field(default_factory=list, max_length=60)


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=2000)


class AdvisorRequest(BaseModel):
    message: str = Field(min_length=1, max_length=800)
    language: Literal["en", "fil"] = "en"
    history: list[Turn] = Field(default_factory=list, max_length=8)
    household: HouseholdIn


# ------------------------------------------------------------------ facts

def _usage(a: ApplianceIn, **override: Any) -> energy.Usage:
    return energy.Usage(
        wattage=override.get("wattage", a.wattage),
        hours_per_day=override.get("hours_per_day", a.hoursPerDay),
        days=override.get("days", a.daysPerPeriod),
        quantity=override.get("quantity", a.quantity),
    )


def compute_facts(h: HouseholdIn) -> dict:
    rate = h.rate.valuePhpPerKwh if h.rate else None
    appliances = []
    total_est = 0.0
    for a in h.appliances:
        kwh = energy.energy_kwh(_usage(a))
        total_est += energy.energy_kwh_raw(_usage(a))
        appliances.append(
            {
                "id": a.id,
                "name": a.name,
                "type": a.type,
                "wattage": a.wattage,
                "quantity": a.quantity,
                "hoursPerDay": a.hoursPerDay,
                "daysPerPeriod": a.daysPerPeriod,
                "estimatedKwh": kwh,
                "estimatedCostPhp": energy.cost_php(_usage(a), rate),
                "variablePower": a.variablePower,
            }
        )
    total_est_r = energy.round2(total_est)
    for item in appliances:
        item["shareOfEstimatePct"] = energy.round2(item["estimatedKwh"] / total_est * 100) if total_est > 0 else None
    appliances.sort(key=lambda x: x["estimatedKwh"], reverse=True)

    bills = sorted(h.bills, key=lambda b: b.periodEnd)
    latest = bills[-1] if bills else None
    previous = bills[-2] if len(bills) >= 2 else None
    bill_change = None
    if latest and previous:
        bill_change = {
            "kwhChange": energy.round2(latest.kwh - previous.kwh),
            "amountChangePhp": energy.round2(latest.amountPhp - previous.amountPhp),
            "previousPeriodEnd": previous.periodEnd,
        }

    missing = []
    if not bills:
        missing.append("no confirmed electricity bill")
    if not appliances:
        missing.append("no confirmed appliances")
    if rate is None:
        missing.append("no confirmed electricity rate, so peso estimates are unavailable")

    return {
        "rate": h.rate.model_dump() if h.rate else None,
        "latestBill": latest.model_dump() if latest else None,
        "billChangeVsPrevious": bill_change,
        "appliances": appliances,
        "totalEstimatedApplianceKwh": total_est_r,
        "estimatedShareOfLatestBillPct": energy.round2(total_est / latest.kwh * 100) if latest and latest.kwh > 0 else None,
        "missingInformation": missing,
    }


# ------------------------------------------------------------------ tool

TOOL_NAME = "simulate_usage_change"
TOOL_DECLARATION = {
    "name": TOOL_NAME,
    "description": (
        "Deterministic SmartWatts calculator. Computes the estimated change in kWh and pesos "
        "for one confirmed appliance when its usage changes. Use for ANY what-if or savings number."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "appliance_id": {"type": "string", "description": "id of a confirmed appliance from the facts"},
            "new_hours_per_day": {"type": "number", "description": "proposed hours per day (0-24)"},
            "new_days": {"type": "number", "description": "proposed days used in the billing period"},
            "new_quantity": {"type": "integer", "description": "proposed number of identical units"},
        },
        "required": ["appliance_id"],
    },
}


def run_tool(h: HouseholdIn, args: dict) -> dict:
    a = next((x for x in h.appliances if x.id == args.get("appliance_id")), None)
    if a is None:
        return {"error": "unknown appliance_id; only confirmed appliances can be simulated"}
    override: dict[str, Any] = {}
    if args.get("new_hours_per_day") is not None:
        override["hours_per_day"] = args["new_hours_per_day"]
    if args.get("new_days") is not None:
        override["days"] = args["new_days"]
    if args.get("new_quantity") is not None:
        override["quantity"] = args["new_quantity"]
    rate = h.rate.valuePhpPerKwh if h.rate else None
    try:
        result = energy.compare(_usage(a), _usage(a, **override), rate)
    except energy.CalcError as exc:
        return {"error": str(exc)}
    return {
        "appliance": a.name,
        "baseline": {"hoursPerDay": a.hoursPerDay, "days": a.daysPerPeriod, "quantity": a.quantity},
        "scenario": {
            "hoursPerDay": override.get("hours_per_day", a.hoursPerDay),
            "days": override.get("days", a.daysPerPeriod),
            "quantity": override.get("quantity", a.quantity),
        },
        "rateUsed": h.rate.model_dump() if h.rate else None,
        **result,
    }


# ------------------------------------------------------------------ verification

_FIG_RX = re.compile(
    r"(?:₱|php|\bp)\s?(-?\d[\d,]*(?:\.\d+)?)|(-?\d[\d,]*(?:\.\d+)?)\s?(?:kwh|php|pesos?)",
    re.IGNORECASE,
)


def _collect_numbers(obj: Any, out: set[float]) -> None:
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        out.add(round(abs(float(obj)), 2))
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_numbers(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _collect_numbers(v, out)


def unsupported_figures(reply: str, grounded: list[Any]) -> list[str]:
    allowed: set[float] = set()
    for g in grounded:
        _collect_numbers(g, allowed)
    bad = []
    for m in _FIG_RX.finditer(reply):
        raw = m.group(1) or m.group(2)
        try:
            value = round(abs(float(raw.replace(",", ""))), 2)
        except ValueError:
            continue
        if not any(abs(value - a) <= 0.01 for a in allowed):
            bad.append(m.group(0).strip())
    return bad


# ------------------------------------------------------------------ LLM

SYSTEM_PROMPT = """You are the SmartWatts Energy Advisor for Filipino households served by Meralco.
Rules you must follow:
1. Use ONLY the household FACTS provided below and results from the simulate_usage_change tool.
2. Never invent appliances, usage hours, electricity rates, meter readings or bill amounts.
3. Every peso (₱) or kWh figure you state must come exactly from FACTS or a tool result. For any
   what-if or savings question, call simulate_usage_change; do not compute numbers yourself.
4. Appliance figures are ESTIMATES from rated wattage and the user's reported usage. You cannot know
   which appliance actually caused the bill. Say "likely" or "estimated", never "caused".
5. If information is missing (see missingInformation), say what is missing and how to add it in SmartWatts.
6. Reply in the user's language: English, Filipino, or Taglish, matching how they wrote.
   Preferred language setting: {language}.
7. Be practical and brief (under 160 words). Use short paragraphs or bullets. No markdown tables.
8. Peso savings on appliance estimates do not guarantee the same drop in the actual bill; mention this when giving peso figures.

FACTS (JSON):
{facts}
"""


class GenAIClient(Protocol):  # minimal surface we use; allows test fakes
    models: Any


class AdvisorUnavailable(RuntimeError):
    pass


def ask(req: AdvisorRequest, client: GenAIClient, model: str, timeout_s: float) -> dict:
    from google.genai import types

    facts = compute_facts(req.household)
    system = SYSTEM_PROMPT.format(
        language="Filipino" if req.language == "fil" else "English",
        facts=json.dumps(facts, ensure_ascii=False),
    )
    contents: list[Any] = [
        types.Content(role="user" if t.role == "user" else "model", parts=[types.Part(text=t.text)])
        for t in req.history
    ]
    contents.append(types.Content(role="user", parts=[types.Part(text=req.message)]))
    config = types.GenerateContentConfig(
        system_instruction=system,
        tools=[types.Tool(function_declarations=[types.FunctionDeclaration(**TOOL_DECLARATION)])],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        temperature=0.3,
        http_options=types.HttpOptions(timeout=int(timeout_s * 1000)),
    )

    tool_results: list[dict] = []
    tool_log: list[dict] = []
    reply = ""
    try:
        for _ in range(4):
            resp = client.models.generate_content(model=model, contents=contents, config=config)
            calls = resp.function_calls or []
            if not calls:
                reply = (resp.text or "").strip()
                break
            contents.append(resp.candidates[0].content)
            parts = []
            for call in calls:
                args = dict(call.args or {})
                result = run_tool(req.household, args) if call.name == TOOL_NAME else {"error": "unknown tool"}
                tool_results.append(result)
                tool_log.append({"name": call.name, "args": args, "result": result})
                parts.append(types.Part.from_function_response(name=call.name, response={"result": result}))
            contents.append(types.Content(role="user", parts=parts))
    except Exception as exc:  # network, auth, quota, timeout — never leak details to client
        raise AdvisorUnavailable(type(exc).__name__) from exc

    if not reply:
        raise AdvisorUnavailable("empty response")

    return {
        "reply": reply,
        "toolCalls": tool_log,
        "facts": facts,
        "unverifiedFigures": unsupported_figures(reply, [facts, tool_results]),
        "model": model,
    }
