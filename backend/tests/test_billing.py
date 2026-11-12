from datetime import date

import pytest

from app.rentals.billing import (
    Agreement, Assignment, Bill, BillingError, Meter, Occupancy, Reading,
    allocate_by_weights, calculate_bill, parse_kwh_to_wh, prorate_down,
)

D = date.fromisoformat
BILL_START, BILL_END = D("2026-09-01"), D("2026-09-30")


def bill(meter_id="main", amount=1_234_567, wh=1_000_000):
    return Bill("b1", meter_id, BILL_START, BILL_END, wh, amount)


def test_kwh_parsing_uses_integer_watt_hours():
    assert parse_kwh_to_wh("123.456") == 123456
    assert parse_kwh_to_wh(0) == 0
    for bad in ("-1", "1.2345", "abc", None, True):
        with pytest.raises(BillingError):
            parse_kwh_to_wh(bad)


def test_prorate_rounds_down_and_allocation_is_exact():
    assert prorate_down(1000, 1, 3) == 333
    shares = allocate_by_weights(1000, [("a", 1), ("b", 1), ("c", 1)])
    assert shares == {"a": 334, "b": 333, "c": 333}
    assert sum(allocate_by_weights(99_999, [("a", 3), ("b", 7), ("c", 11)]).values()) == 99_999
    with pytest.raises(BillingError):
        allocate_by_weights(100, [("a", 0)])


def test_scenario_a_individual_meter_passes_official_bill_to_single_occupant():
    result = calculate_bill(
        bill=bill("m1"), meter=Meter("m1", "utility_individual", "Unit 1 meter"), submeters=[],
        assignments=[Assignment("a1", "m1", "u1", D("2026-01-01"))],
        readings=[], occupancies=[Occupancy("o1", "u1", "tenant-1", D("2026-01-01"))],
        agreement=None, tolerance_days=3,
    )
    [line] = result.lines
    assert line.charge_basis == "official_utility_bill"
    assert line.consumption_kind == "verified_meter_consumption"
    assert line.amount_centavos == 1_234_567 and line.tenant_uid == "tenant-1"
    assert result.reconciliation(bill("m1"))["balanced"]


def test_scenario_a_requires_assignment_covering_period():
    with pytest.raises(BillingError, match="exactly one unit"):
        calculate_bill(
            bill=bill("m1"), meter=Meter("m1", "utility_individual", "M1"), submeters=[],
            assignments=[Assignment("a1", "m1", "u1", D("2026-09-10"))], readings=[], occupancies=[],
            agreement=None, tolerance_days=3,
        )


def test_scenario_a_move_out_mid_period_is_flagged_for_review_not_auto_split():
    result = calculate_bill(
        bill=bill("m1"), meter=Meter("m1", "utility_individual", "M1"), submeters=[],
        assignments=[Assignment("a1", "m1", "u1", D("2026-01-01"))], readings=[],
        occupancies=[
            Occupancy("o1", "u1", "t1", D("2026-01-01"), D("2026-09-15")),
            Occupancy("o2", "u1", "t2", D("2026-09-16")),
        ],
        agreement=None, tolerance_days=3,
    )
    [line] = result.lines
    assert line.needs_review and line.tenant_uid is None
    assert result.reconciliation(bill("m1"))["pendingReviewCentavos"] == 1_234_567


def _submeter_setup(occupancies, readings, agreement=None, amount=1_000_000, wh=1_000_000):
    return calculate_bill(
        bill=bill(amount=amount, wh=wh),
        meter=Meter("main", "utility_shared", "Main meter"),
        submeters=[Meter("s1", "private_submeter", "Sub 1", "main"), Meter("s2", "private_submeter", "Sub 2", "main")],
        assignments=[Assignment("a1", "s1", "u1", D("2026-01-01")), Assignment("a2", "s2", "u2", D("2026-01-01"))],
        readings=readings, occupancies=occupancies, agreement=agreement, tolerance_days=3,
    )


BASE_READINGS = [
    Reading("r1", "s1", D("2026-09-01"), 10_000_000), Reading("r2", "s1", D("2026-09-30"), 10_300_000),
    Reading("r3", "s2", D("2026-08-31"), 5_000_000), Reading("r4", "s2", D("2026-10-01"), 5_200_000),
]


def test_scenario_b_submeters_use_parent_bill_average_cost_and_leave_remainder_with_owner():
    result = _submeter_setup(
        [Occupancy("o1", "u1", "t1", D("2026-01-01")), Occupancy("o2", "u2", "t2", D("2026-01-01"))], BASE_READINGS,
    )
    by_unit = {line.unit_id: line for line in result.lines}
    assert by_unit["u1"].wh == 300_000 and by_unit["u1"].amount_centavos == 300_000
    assert by_unit["u2"].wh == 200_000 and by_unit["u2"].amount_centavos == 200_000
    assert by_unit["u1"].charge_basis == "private_submeter_consumption"
    assert by_unit["u1"].source_reading_ids == ("r1", "r2")
    # 500 kWh of shared/common consumption: no agreement, so never charged to tenants.
    assert [(o.reason.startswith("Shared consumption"), o.amount_centavos) for o in result.owner_borne] == [(True, 500_000)]
    assert result.reconciliation(bill(amount=1_000_000, wh=1_000_000))["balanced"]


def test_scenario_b_missing_reading_is_an_error_not_a_guess():
    with pytest.raises(BillingError, match="Missing verified reading"):
        _submeter_setup([Occupancy("o1", "u1", "t1", D("2026-01-01"))], BASE_READINGS[:1] + BASE_READINGS[2:])


def test_scenario_b_decreasing_readings_rejected():
    readings = [Reading("r1", "s1", D("2026-09-01"), 900), Reading("r2", "s1", D("2026-09-30"), 100)]
    with pytest.raises(BillingError, match="decrease"):
        _submeter_setup([], readings + BASE_READINGS[2:])


def test_scenario_b_submeters_exceeding_parent_bill_rejected():
    with pytest.raises(BillingError, match="exceeds"):
        _submeter_setup([], BASE_READINGS, wh=400_000)


def test_scenario_b_move_out_and_move_in_split_by_boundary_readings():
    readings = [
        Reading("r1", "s1", D("2026-09-01"), 0), Reading("r15", "s1", D("2026-09-15"), 100_000),
        Reading("r30", "s1", D("2026-09-30"), 250_000),
    ] + BASE_READINGS[2:]
    result = _submeter_setup(
        [
            Occupancy("o1", "u1", "t1", D("2026-01-01"), D("2026-09-15")),
            Occupancy("o3", "u1", "t3", D("2026-09-16")),
            Occupancy("o2", "u2", "t2", D("2026-01-01")),
        ],
        readings,
    )
    u1 = sorted((line for line in result.lines if line.unit_id == "u1"), key=lambda line: line.tenant_uid)
    assert [(line.tenant_uid, line.wh) for line in u1] == [("t1", 100_000), ("t3", 150_000)]
    assert result.reconciliation(bill(amount=1_000_000, wh=1_000_000))["balanced"]


def test_scenario_b_vacant_unit_consumption_is_owner_borne():
    result = _submeter_setup([Occupancy("o2", "u2", "t2", D("2026-01-01"))], BASE_READINGS)
    assert {line.unit_id for line in result.lines} == {"u2"}
    assert any(item.unit_id == "u1" and item.wh == 300_000 for item in result.owner_borne)


def test_scenario_c_shared_meter_without_agreement_charges_no_tenant():
    result = calculate_bill(
        bill=bill(), meter=Meter("main", "utility_shared", "Main"), submeters=[], assignments=[], readings=[],
        occupancies=[Occupancy("o1", "u1", "t1", D("2026-01-01")), Occupancy("o2", "u2", "t2", D("2026-01-01"))],
        agreement=None, tolerance_days=3,
    )
    assert result.lines == []  # no default equal split
    assert sum(item.amount_centavos for item in result.owner_borne) == 1_234_567


def test_scenario_c_explicit_agreement_allocates_exactly_and_is_labelled_unmeasured():
    agreement = Agreement("ag1", "main", "Lease clause 7: unit 1 pays 60%, unit 2 pays 40%.", (("u1", 3), ("u2", 2)), D("2026-01-01"))
    result = calculate_bill(
        bill=bill(), meter=Meter("main", "utility_shared", "Main"), submeters=[], assignments=[], readings=[],
        occupancies=[Occupancy("o1", "u1", "t1", D("2026-01-01")), Occupancy("o2", "u2", "t2", D("2026-01-01"))],
        agreement=agreement, tolerance_days=3,
    )
    assert sum(line.amount_centavos for line in result.lines) == 1_234_567
    assert all(line.charge_basis == "allocation_based_charge" for line in result.lines)
    assert all(line.consumption_kind == "not_individually_measured" and line.wh is None for line in result.lines)
    assert all("not measured" in line.description for line in result.lines)


def test_mixed_submeters_plus_agreement_allocates_only_remainder():
    agreement = Agreement("ag1", "main", "Common area lights split per lease clause 9.", (("u1", 1), ("u2", 1)), D("2026-01-01"))
    result = _submeter_setup(
        [Occupancy("o1", "u1", "t1", D("2026-01-01")), Occupancy("o2", "u2", "t2", D("2026-01-01"))],
        BASE_READINGS, agreement=agreement,
    )
    allocations = [line for line in result.lines if line.charge_basis == "allocation_based_charge"]
    assert sum(line.amount_centavos for line in allocations) == 500_000
    assert result.reconciliation(bill(amount=1_000_000, wh=1_000_000))["ownerBorneCentavos"] == 0
