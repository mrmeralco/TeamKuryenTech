"""Pure, deterministic billing calculations for SmartWatts Rentals.

LEGAL / REGULATORY NOTICE: these workflows have NOT been reviewed for
compliance with Philippine energy regulations (e.g. ERC rules on submetering
and pass-through charges) or lease law. They must be reviewed by qualified
counsel before being used to bill real tenants.

Conventions
-----------
* Money is always integer centavos. Energy is always integer watt-hours (Wh).
* There is no universal price per kWh. Submeter charges are derived from the
  specific parent utility bill (at cost: bill amount x unit Wh / bill Wh),
  rounded DOWN to the centavo so tenants are never over-charged by rounding.
* Shared-meter consumption is never presented as individual measured usage.
  It can only be charged through an explicit, owner-described allocation
  agreement; there is no default (equal) split.
* Every line records its charge basis and consumption kind so statements can
  distinguish official bills, measured consumption, and allocations.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Literal

ChargeBasis = Literal["official_utility_bill", "private_submeter_consumption", "allocation_based_charge"]
ConsumptionKind = Literal["verified_meter_consumption", "private_submeter_consumption", "not_individually_measured"]
MeterKind = Literal["utility_individual", "utility_shared", "private_submeter"]

LEGAL_REVIEW_NOTICE = (
    "Requires legal/regulatory review before production use. SmartWatts does not certify that this "
    "statement complies with energy regulations or your lease."
)


class BillingError(ValueError):
    """Raised when source data cannot produce a trustworthy statement."""


def parse_kwh_to_wh(value: object, *, field_name: str = "kWh") -> int:
    """Convert a kWh value (number or numeric string, max 3 decimals) to integer Wh."""
    if isinstance(value, bool) or value is None:
        raise BillingError(f"{field_name} must be a number.")
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError) as error:
        raise BillingError(f"{field_name} must be a number.") from error
    if not number.is_finite() or number < 0:
        raise BillingError(f"{field_name} must be zero or greater.")
    wh = number * 1000
    if wh != wh.to_integral_value():
        raise BillingError(f"{field_name} supports at most 3 decimal places.")
    if wh > Decimal(10) ** 15:
        raise BillingError(f"{field_name} is too large.")
    return int(wh)


def wh_to_kwh_text(wh: int) -> str:
    return f"{Decimal(wh) / 1000:.3f}"


def prorate_down(total_centavos: int, part_wh: int, whole_wh: int) -> int:
    if whole_wh <= 0:
        raise BillingError("The parent bill must have a positive kWh total.")
    if part_wh < 0:
        raise BillingError("Consumption cannot be negative.")
    return (total_centavos * part_wh) // whole_wh


def allocate_by_weights(amount_centavos: int, weights: list[tuple[str, int]]) -> dict[str, int]:
    """Largest-remainder allocation so the parts always sum exactly to the amount."""
    if amount_centavos < 0:
        raise BillingError("Allocation amount cannot be negative.")
    if not weights or any(weight <= 0 for _, weight in weights):
        raise BillingError("Allocation weights must be positive.")
    if len({key for key, _ in weights}) != len(weights):
        raise BillingError("Each unit may appear only once in an allocation.")
    total_weight = sum(weight for _, weight in weights)
    shares = {key: (amount_centavos * weight) // total_weight for key, weight in weights}
    remainders = sorted(
        ((amount_centavos * weight) % total_weight, index, key) for index, (key, weight) in enumerate(weights)
    )
    leftover = amount_centavos - sum(shares.values())
    # Highest remainder first; ties resolved by original order for determinism.
    for _, _, key in sorted(remainders, key=lambda item: (-item[0], item[1]))[:leftover]:
        shares[key] += 1
    return shares


@dataclass(frozen=True)
class Bill:
    id: str
    meter_id: str
    period_start: date
    period_end: date
    total_wh: int
    amount_centavos: int


@dataclass(frozen=True)
class Meter:
    id: str
    kind: MeterKind
    label: str
    parent_meter_id: str | None = None


@dataclass(frozen=True)
class Assignment:
    id: str
    meter_id: str
    unit_id: str
    effective_from: date
    effective_to: date | None = None

    def covers(self, start: date, end: date) -> bool:
        return self.effective_from <= start and (self.effective_to is None or self.effective_to >= end)

    def overlaps(self, start: date, end: date) -> bool:
        return self.effective_from <= end and (self.effective_to is None or self.effective_to >= start)


@dataclass(frozen=True)
class Occupancy:
    id: str
    unit_id: str
    tenant_uid: str
    start: date
    end: date | None = None

    def overlaps(self, start: date, end: date) -> bool:
        return self.start <= end and (self.end is None or self.end >= start)

    def covers(self, start: date, end: date) -> bool:
        return self.start <= start and (self.end is None or self.end >= end)


@dataclass(frozen=True)
class Reading:
    id: str
    meter_id: str
    reading_date: date
    wh: int


@dataclass(frozen=True)
class Agreement:
    id: str
    meter_id: str
    description: str
    shares: tuple[tuple[str, int], ...]
    effective_from: date
    effective_to: date | None = None

    def covers(self, start: date, end: date) -> bool:
        return self.effective_from <= start and (self.effective_to is None or self.effective_to >= end)


@dataclass
class Line:
    unit_id: str
    occupancy_id: str | None
    tenant_uid: str | None
    charge_basis: ChargeBasis
    consumption_kind: ConsumptionKind
    description: str
    wh: int | None
    amount_centavos: int
    calculation: dict
    source_reading_ids: tuple[str, ...] = ()
    needs_review: bool = False
    review_reason: str | None = None


@dataclass
class OwnerBorne:
    reason: str
    amount_centavos: int
    unit_id: str | None = None
    wh: int | None = None


@dataclass
class BillingResult:
    lines: list[Line] = field(default_factory=list)
    owner_borne: list[OwnerBorne] = field(default_factory=list)

    def reconciliation(self, bill: Bill) -> dict:
        tenant = sum(line.amount_centavos for line in self.lines if not line.needs_review)
        review = sum(line.amount_centavos for line in self.lines if line.needs_review)
        owner = sum(item.amount_centavos for item in self.owner_borne)
        accounted = tenant + review + owner
        return {
            "billAmountCentavos": bill.amount_centavos,
            "billTotalWh": bill.total_wh,
            "tenantChargesCentavos": tenant,
            "pendingReviewCentavos": review,
            "ownerBorneCentavos": owner,
            "accountedCentavos": accounted,
            "balanced": accounted == bill.amount_centavos,
        }


def _closest_reading(readings: list[Reading], target: date, tolerance_days: int) -> Reading | None:
    candidates = [r for r in readings if abs((r.reading_date - target).days) <= tolerance_days]
    if not candidates:
        return None
    return min(candidates, key=lambda r: (abs((r.reading_date - target).days), r.reading_date))


def submeter_consumption(
    readings: list[Reading], start: date, end: date, tolerance_days: int, meter_label: str
) -> tuple[int, Reading, Reading]:
    """Consumption between verified readings nearest to start and end of a window."""
    ordered = sorted(readings, key=lambda r: r.reading_date)
    previous = _closest_reading(ordered, start, tolerance_days)
    current = _closest_reading(ordered, end, tolerance_days)
    if previous is None:
        raise BillingError(f"Missing verified reading for {meter_label} within {tolerance_days} day(s) of {start.isoformat()}.")
    if current is None:
        raise BillingError(f"Missing verified reading for {meter_label} within {tolerance_days} day(s) of {end.isoformat()}.")
    if current.reading_date <= previous.reading_date:
        raise BillingError(f"Readings for {meter_label} do not cover {start.isoformat()} to {end.isoformat()}.")
    if current.wh < previous.wh:
        raise BillingError(f"Readings for {meter_label} decrease over time; correct the reading history first.")
    return current.wh - previous.wh, previous, current


def _attribute(
    unit_id: str, occupancies: list[Occupancy], start: date, end: date
) -> tuple[Occupancy | None, str | None, bool]:
    """Return (occupancy, review_reason, vacant) for a whole-period charge."""
    overlapping = [o for o in occupancies if o.unit_id == unit_id and o.overlaps(start, end)]
    if not overlapping:
        return None, None, True
    if len(overlapping) == 1 and overlapping[0].covers(start, end):
        return overlapping[0], None, False
    return None, "Occupancy changed during the bill period. Split this charge manually or record submeter readings.", False


def calculate_bill(
    *,
    bill: Bill,
    meter: Meter,
    submeters: list[Meter],
    assignments: list[Assignment],
    readings: list[Reading],
    occupancies: list[Occupancy],
    agreement: Agreement | None,
    tolerance_days: int,
) -> BillingResult:
    """Turn one official utility bill into tenant charge lines plus owner-borne amounts."""
    if bill.period_end <= bill.period_start:
        raise BillingError("The bill period end must be after its start.")
    if bill.amount_centavos <= 0 or bill.total_wh <= 0:
        raise BillingError("The bill amount and kWh must be greater than zero.")
    if meter.id != bill.meter_id:
        raise BillingError("The bill does not belong to this meter.")

    start, end = bill.period_start, bill.period_end
    result = BillingResult()
    bill_basis = {
        "utilityBillId": bill.id,
        "billPeriodStart": start.isoformat(),
        "billPeriodEnd": end.isoformat(),
        "billAmountCentavos": bill.amount_centavos,
        "billTotalWh": bill.total_wh,
    }

    if meter.kind == "utility_individual":
        # Scenario A: one official utility meter serves exactly one unit.
        covering = [a for a in assignments if a.meter_id == meter.id and a.covers(start, end)]
        if len(covering) != 1:
            raise BillingError(f"{meter.label} must be assigned to exactly one unit for the entire bill period.")
        unit_id = covering[0].unit_id
        occupancy, reason, vacant = _attribute(unit_id, occupancies, start, end)
        if vacant:
            result.owner_borne.append(OwnerBorne("Vacant unit", bill.amount_centavos, unit_id, bill.total_wh))
        else:
            result.lines.append(Line(
                unit_id=unit_id,
                occupancy_id=occupancy.id if occupancy else None,
                tenant_uid=occupancy.tenant_uid if occupancy else None,
                charge_basis="official_utility_bill",
                consumption_kind="verified_meter_consumption",
                description=f"Official utility bill for {meter.label} (individual utility meter).",
                wh=bill.total_wh,
                amount_centavos=bill.amount_centavos,
                calculation={**bill_basis, "method": "Pass-through of the official utility bill amount."},
                needs_review=reason is not None,
                review_reason=reason,
            ))
        return result

    if meter.kind != "utility_shared":
        raise BillingError("Utility bills can only be recorded against utility meters.")

    # Scenario B: private submeters under the shared/main utility meter.
    submetered_centavos = 0
    submetered_wh = 0
    for submeter in sorted(submeters, key=lambda m: m.id):
        sub_assignments = [a for a in assignments if a.meter_id == submeter.id and a.overlaps(start, end)]
        if not sub_assignments:
            continue
        if len(sub_assignments) != 1 or not sub_assignments[0].covers(start, end):
            raise BillingError(f"{submeter.label} changed units during the bill period; bill it manually.")
        unit_id = sub_assignments[0].unit_id
        sub_readings = [r for r in readings if r.meter_id == submeter.id]
        full_wh, _, _ = submeter_consumption(sub_readings, start, end, tolerance_days, submeter.label)
        submetered_wh += full_wh
        unit_occupancies = sorted(
            (o for o in occupancies if o.unit_id == unit_id and o.overlaps(start, end)), key=lambda o: o.start
        )
        tenant_wh = 0
        for occupancy in unit_occupancies:
            window_start = max(start, occupancy.start)
            window_end = min(end, occupancy.end) if occupancy.end else end
            wh, prev, curr = submeter_consumption(sub_readings, window_start, window_end, tolerance_days, submeter.label)
            tenant_wh += wh
            amount = prorate_down(bill.amount_centavos, wh, bill.total_wh)
            submetered_centavos += amount
            result.lines.append(Line(
                unit_id=unit_id,
                occupancy_id=occupancy.id,
                tenant_uid=occupancy.tenant_uid,
                charge_basis="private_submeter_consumption",
                consumption_kind="private_submeter_consumption",
                description=f"Private submeter {submeter.label}: {wh_to_kwh_text(wh)} kWh at this bill's average cost.",
                wh=wh,
                amount_centavos=amount,
                calculation={
                    **bill_basis,
                    "method": "billAmountCentavos x unitWh / billTotalWh, rounded down to the centavo.",
                    "submeterId": submeter.id,
                    "previousReading": {"id": prev.id, "date": prev.reading_date.isoformat(), "wh": prev.wh},
                    "currentReading": {"id": curr.id, "date": curr.reading_date.isoformat(), "wh": curr.wh},
                    "unitWh": wh,
                },
                source_reading_ids=(prev.id, curr.id),
            ))
        if tenant_wh > full_wh:
            raise BillingError(f"Occupancy readings for {submeter.label} exceed the full-period consumption.")
        vacancy_wh = full_wh - tenant_wh
        if vacancy_wh:
            amount = prorate_down(bill.amount_centavos, vacancy_wh, bill.total_wh)
            submetered_centavos += amount
            result.owner_borne.append(OwnerBorne("Submeter consumption while the unit was vacant", amount, unit_id, vacancy_wh))

    if submetered_wh > bill.total_wh:
        raise BillingError("Submeter consumption exceeds the parent utility bill. Check readings and the bill kWh.")

    # Scenario C: remaining shared consumption. Only an explicit agreement may allocate it.
    remainder = bill.amount_centavos - submetered_centavos
    remainder_wh = bill.total_wh - submetered_wh
    if remainder <= 0:
        return result
    if agreement is None:
        result.owner_borne.append(OwnerBorne(
            "Shared consumption not covered by a written allocation agreement (not charged to tenants)",
            remainder, None, remainder_wh,
        ))
        return result
    if agreement.meter_id != meter.id or not agreement.covers(start, end):
        raise BillingError("The allocation agreement does not cover this meter and bill period.")

    shares = allocate_by_weights(remainder, list(agreement.shares))
    total_weight = sum(weight for _, weight in agreement.shares)
    for unit_id, weight in agreement.shares:
        amount = shares[unit_id]
        occupancy, reason, vacant = _attribute(unit_id, occupancies, start, end)
        if vacant:
            result.owner_borne.append(OwnerBorne("Allocation share of a vacant unit", amount, unit_id, None))
            continue
        result.lines.append(Line(
            unit_id=unit_id,
            occupancy_id=occupancy.id if occupancy else None,
            tenant_uid=occupancy.tenant_uid if occupancy else None,
            charge_basis="allocation_based_charge",
            consumption_kind="not_individually_measured",
            description=(
                f"Allocation of shared meter {meter.label} under agreement: {agreement.description} "
                "This is an agreed allocation, not measured unit consumption."
            ),
            wh=None,
            amount_centavos=amount,
            calculation={
                **bill_basis,
                "method": "Remaining shared amount x unit weight / total weight (largest-remainder rounding).",
                "allocationAgreementId": agreement.id,
                "sharedRemainderCentavos": remainder,
                "sharedRemainderWh": remainder_wh,
                "unitWeight": weight,
                "totalWeight": total_weight,
            },
            needs_review=reason is not None,
            review_reason=reason,
        ))
    return result
