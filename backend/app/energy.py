"""Deterministic energy calculator (server side).

Mirrors frontend/src/lib/energy.ts. Both implementations are tested against
spec/calc-cases.json so they cannot drift apart.

Units: wattage in W, hours per day in h, days in d, rate in PHP/kWh.
Rounding: 2 decimals, half away from zero, applied only to outputs.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from math import isfinite

MAX_DAYS = 45
MAX_HOURS = 24
MAX_RATE = 100.0  # PHP/kWh sanity ceiling; real PH rates are far below this


class CalcError(ValueError):
    """Raised for inputs the calculator refuses to compute."""


@dataclass(frozen=True)
class Usage:
    wattage: float
    hours_per_day: float
    days: float
    quantity: int


def round2(value: float) -> float:
    # str() first so 3.9000000000000004 rounds as 3.90 rather than through binary noise.
    return float(Decimal(repr(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _finite(name: str, value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        raise CalcError(f"{name} must be a finite number")
    return float(value)


def validate_usage(u: Usage) -> None:
    w = _finite("wattage", u.wattage)
    h = _finite("hours_per_day", u.hours_per_day)
    d = _finite("days", u.days)
    if w <= 0:
        raise CalcError("wattage must be greater than 0")
    if h < 0 or h > MAX_HOURS:
        raise CalcError("hours_per_day must be between 0 and 24")
    if d <= 0 or d > MAX_DAYS:
        raise CalcError(f"days must be between 1 and {MAX_DAYS}")
    if isinstance(u.quantity, bool) or not isinstance(u.quantity, (int, float)) or u.quantity != int(u.quantity) or u.quantity < 1:
        raise CalcError("quantity must be a positive whole number")


def validate_rate(rate: float | None) -> None:
    if rate is None:
        return
    r = _finite("rate", rate)
    if r <= 0 or r > MAX_RATE:
        raise CalcError("rate must be greater than 0 and at most 100 PHP/kWh")


def energy_kwh_raw(u: Usage) -> float:
    validate_usage(u)
    return (u.wattage * u.hours_per_day * u.days * u.quantity) / 1000.0


def energy_kwh(u: Usage) -> float:
    return round2(energy_kwh_raw(u))


def cost_php(u: Usage, rate: float | None) -> float | None:
    validate_rate(rate)
    if rate is None:
        return None
    return round2(energy_kwh_raw(u) * rate)


def compare(baseline: Usage, scenario: Usage, rate: float | None) -> dict:
    validate_rate(rate)
    b = energy_kwh_raw(baseline)
    s = energy_kwh_raw(scenario)
    delta = s - b
    saved = b - s
    if abs(delta) < 1e-9:
        direction = "none"
        delta = saved = 0.0
    else:
        direction = "increase" if delta > 0 else "decrease"
    return {
        "baselineKwh": round2(b),
        "scenarioKwh": round2(s),
        "deltaKwh": round2(delta),
        "savedKwh": round2(saved),
        "savedPhp": None if rate is None else round2(saved * rate),
        "direction": direction,
    }
