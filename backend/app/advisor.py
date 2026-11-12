"""Grounded SmartWatts Energy Advisor.

The language model never produces its own peso or kWh figures:

1. The browser sends only the signed-in user's OWN appliance and bill figures (read from
   users/{uid}/** under Firestore rules). No names, addresses, account or meter numbers are
   accepted; rental/property data is never part of the advisor context.
2. This module recomputes every figure deterministically (it does not trust client totals).
3. Gemini receives the figures as numbered FACTS and must only cite them.
4. The reply is validated: any ₱ / kWh / % figure that is not a computed fact (or a number the
   user typed) causes the reply to be replaced by a deterministic summary.
"""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

AVERAGE_DAYS_PER_MONTH = Decimal("365.25") / Decimal("12")


class AdvisorAppliance(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=60)
    category: str = Field(default="other", max_length=40)
    quantity: int = Field(default=1, ge=1, le=50)
    watts: float = Field(default=0, ge=0, le=20000)
    hoursPerDay: float = Field(default=0, ge=0, le=24)
    daysPerWeek: float = Field(default=7, ge=0, le=7)
    testedKwhMonth: float | None = Field(default=None, gt=0, lt=5000)

    @model_validator(mode="after")
    def require_basis(self):
        if self.watts <= 0 and not self.testedKwhMonth:
            raise ValueError("Each appliance needs wattage or tested monthly kWh.")
        return self


class AdvisorBill(BaseModel):
    model_config = ConfigDict(extra="forbid")

    periodStart: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    periodEnd: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    kwh: float = Field(gt=0, lt=1_000_000)
    amountCentavos: int = Field(ge=0, lt=100_000_000_000)


class AdvisorContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    appliances: list[AdvisorAppliance] = Field(default_factory=list, max_length=50)
    latestBill: AdvisorBill | None = None


class Fact(BaseModel):
    id: str
    text: str


def _q(value: Decimal, places: str = "0.01") -> Decimal:
    return value.quantize(Decimal(places), rounding=ROUND_HALF_UP)


def _money(centavos: Decimal) -> str:
    return f"₱{_q(centavos / 100):,.2f}"


def _kwh(value: Decimal) -> str:
    return f"{_q(value):,.2f} kWh"


def monthly_kwh(appliance: AdvisorAppliance) -> tuple[Decimal, Literal["wattage", "tested_label"]]:
    if appliance.watts > 0:
        kwh = (
            Decimal(str(appliance.watts)) * appliance.quantity * Decimal(str(appliance.hoursPerDay))
            * (Decimal(str(appliance.daysPerWeek)) / 7) * AVERAGE_DAYS_PER_MONTH / 1000
        )
        return kwh, "wattage"
    return Decimal(str(appliance.testedKwhMonth)) * appliance.quantity, "tested_label"


def compute_facts(context: AdvisorContext | None) -> tuple[list[Fact], list[str]]:
    """Deterministic calculator. Returns numbered facts and the assumptions behind them."""
    if context is None:
        return [], []
    facts: list[Fact] = []
    assumptions: list[str] = []
    rate: Decimal | None = None
    bill = context.latestBill
    if bill:
        rate = Decimal(bill.amountCentavos) / Decimal(str(bill.kwh))
        facts.append(Fact(id="bill", text=(
            f"Latest recorded bill {bill.periodStart} to {bill.periodEnd}: {_kwh(Decimal(str(bill.kwh)))}, "
            f"{_money(Decimal(bill.amountCentavos))} (recorded from the user's bill)."
        )))
        facts.append(Fact(id="rate", text=f"Average cost from that bill: {_money(rate)} per kWh (bill amount ÷ kWh)."))
        assumptions.append("Peso estimates use the average cost per kWh of the latest bill; actual tariffs change monthly.")
    estimates = [(appliance, *monthly_kwh(appliance)) for appliance in context.appliances]
    estimates.sort(key=lambda item: item[1], reverse=True)
    if estimates:
        total = sum((kwh for _, kwh, _ in estimates), Decimal(0))
        facts.append(Fact(id="total", text=f"Estimated appliance total: {_kwh(total)} per month (estimate, not a meter reading)."))
        if bill and Decimal(str(bill.kwh)) > 0:
            share = _q(total / Decimal(str(bill.kwh)) * 100, "0.1")
            facts.append(Fact(id="coverage", text=f"Registered appliances explain about {share}% of the latest bill's kWh."))
        assumptions.append("Wattage appliances: watts × quantity × hours/day × (days/week ÷ 7) × 30.4375 days ÷ 1000.")
        assumptions.append("Energy-label appliances use the manufacturer's tested kWh/month × quantity; hours are not applied.")
    for index, (appliance, kwh, basis) in enumerate(estimates[:10], start=1):
        detail = f"{appliance.quantity} × {appliance.name}: {_kwh(kwh)} per month"
        detail += " (from wattage and schedule)" if basis == "wattage" else " (manufacturer tested consumption)"
        if rate is not None:
            detail += f", about {_money(kwh * rate)} per month"
        facts.append(Fact(id=f"a{index}", text=detail + "."))
        if basis == "wattage" and appliance.hoursPerDay >= 1:
            saved = Decimal(str(appliance.watts)) * appliance.quantity * (Decimal(str(appliance.daysPerWeek)) / 7) * AVERAGE_DAYS_PER_MONTH / 1000
            saving = f"Using {appliance.name} 1 hour less per day saves about {_kwh(saved)} per month"
            if rate is not None:
                saving += f" (about {_money(saved * rate)})"
            facts.append(Fact(id=f"s{index}", text=saving + "."))
    return facts, assumptions


_FIGURE = re.compile(
    r"(?:₱|php\s?|p(?=\s?\d))\s?(\d[\d,]*(?:\.\d+)?)"
    r"|(\d[\d,]*(?:\.\d+)?)\s?(?:kwh|%|percent|pesos?\b)",
    re.IGNORECASE,
)
_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _numbers(text: str) -> set[Decimal]:
    values = set()
    for raw in _NUMBER.findall(text):
        try:
            values.add(_q(Decimal(raw.replace(",", ""))))
        except ArithmeticError:
            continue
    return values


def unverified_figures(reply: str, facts: list[Fact], user_text: str) -> list[str]:
    """₱ / kWh / % figures in the reply that are not computed facts or numbers the user supplied."""
    allowed = _numbers(" ".join(fact.text for fact in facts)) | _numbers(user_text)
    bad = []
    for match in _FIGURE.finditer(reply):
        raw = match.group(1) or match.group(2)
        try:
            value = _q(Decimal(raw.replace(",", "")))
        except ArithmeticError:
            continue
        if value not in allowed:
            bad.append(match.group(0).strip())
    return bad


def language_instruction(code: str) -> str:
    if code.lower() == "tl-taglish":
        return ("Reply in Taglish: the natural conversational mix of Tagalog and English used in Metro Manila. "
                "Keep numbers, units, and peso amounts exactly as given.")
    return f"Reply only in the language identified by language code '{code}'. Keep numbers, units, and peso amounts exactly as given."


def system_prompt(language: str, facts: list[Fact], assumptions: list[str]) -> str:
    base = (
        "You are the SmartWatts energy-saving advisor. Be helpful, concise, and practical. "
        f"{language_instruction(language)} "
        "Never claim access to live or real-time electricity data or meters. Never present estimates as measured readings. "
        "STRICT NUMBER RULE: do not calculate or invent any peso, kWh, or percentage figure. Only quote figures that appear "
        "verbatim in the FACTS below. If the user needs a figure that is not in FACTS, explain which information is missing "
        "(for example: appliance wattage, usage hours, or a recent bill) instead of estimating it."
    )
    if not facts:
        return base + "\nFACTS: none available. Give general energy-saving guidance without peso, kWh, or percentage figures."
    lines = "\n".join(f"[{fact.id}] {fact.text}" for fact in facts)
    notes = "\n".join(f"- {item}" for item in assumptions)
    return f"{base}\nFACTS (computed by SmartWatts from the user's own data):\n{lines}\nASSUMPTIONS:\n{notes}"


def deterministic_summary(facts: list[Fact], assumptions: list[str]) -> str:
    if not facts:
        return ("I can't give figures yet. Add your appliances (with wattage or energy-label kWh) and a recent bill, "
                "and I'll calculate estimates from them.")
    body = "\n".join(f"• {fact.text}" for fact in facts)
    notes = " ".join(assumptions)
    return f"Here are the figures SmartWatts calculated from your data:\n{body}\n\nAssumptions: {notes}"
