import math

import pytest

from app import energy
from tests.conftest import SPEC


def U(d):
    return energy.Usage(d["wattage"], d["hoursPerDay"], d["days"], d["quantity"])


@pytest.mark.parametrize("case", SPEC["energyCases"], ids=lambda c: c["name"])
def test_energy_cases(case):
    assert energy.energy_kwh(U(case["input"])) == case["kwh"]


@pytest.mark.parametrize("case", SPEC["scenarioCases"], ids=lambda c: c["name"])
def test_scenario_cases(case):
    r = energy.compare(U(case["baseline"]), U(case["scenario"]), case["rate"])
    for key in ("baselineKwh", "scenarioKwh", "deltaKwh", "savedKwh", "savedPhp", "direction"):
        assert r[key] == case[key], key


@pytest.mark.parametrize("case", SPEC["invalidInputs"], ids=lambda c: c["name"])
def test_invalid_inputs(case):
    with pytest.raises(energy.CalcError):
        energy.energy_kwh(U(case["input"]))


@pytest.mark.parametrize("rate", SPEC["invalidRates"])
def test_invalid_rates(rate):
    u = energy.Usage(65, 8, 30, 1)
    with pytest.raises(energy.CalcError):
        energy.compare(u, u, rate)


@pytest.mark.parametrize("bad", [math.nan, math.inf, True, "8"])
def test_non_finite(bad):
    with pytest.raises(energy.CalcError):
        energy.energy_kwh(energy.Usage(65, bad, 30, 1))


def test_cost_rounding():
    assert energy.cost_php(energy.Usage(65, 8, 30, 1), 12.43) == 193.91  # 15.6 * 12.43 = 193.908
    assert energy.cost_php(energy.Usage(65, 8, 30, 1), None) is None
