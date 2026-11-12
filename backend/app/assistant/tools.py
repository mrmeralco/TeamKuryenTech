"""Narrowly scoped, read-only retrieval tools for the SmartWatts assistant.

Authorization rules (never relaxed by anything the model or the user's text says):
* Personal tools read only ``users/{uid}/...`` where ``uid`` comes from the verified Firebase token.
* Rentals tools go through ``RentalService`` methods, which re-check membership, role, unit scope
  and entitlement on every call. Owners/admins get manager views; tenants only their own unit,
  published statements, and individual-meter history.
* The property comes from the UI's workspace selection and must match an active membership of
  the caller. No identifier produced by a language model is ever used.
* Every number is computed here, deterministically, and labelled with its kind and source.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from ..advisor import AVERAGE_DAYS_PER_MONTH, AdvisorAppliance, monthly_kwh
from . import bills as bill_model
from ..auth import AuthUser
from ..rentals.service import MANAGERS, TENANT, DomainError, PaymentRequired, RentalService
from ..rentals.store import DocumentStore

# Bounded retrieval: never load a user's whole history into a prompt.
MAX_APPLIANCES = 50
MAX_BILLS = 24
MAX_PLANS = 10
MAX_READINGS = 120

KINDS = {
    "actual_reading": "Actual reading",
    "bill_derived": "From a recorded bill",
    "user_entered": "User-entered",
    "estimate": "Estimate",
    "simulation": "Simulation",
    "allocation": "Shared-meter allocation",
    "status": "Account status",
    "browser_reported": "Stored in this browser (unverified)",
}


@dataclass
class Fact:
    id: str
    text: str
    kind: str
    source: str

    def as_dict(self) -> dict:
        return {**asdict(self), "kindLabel": KINDS.get(self.kind, self.kind)}


@dataclass
class Workspace:
    kind: str  # "personal" | "owner" | "tenant"
    label: str
    property_id: str | None = None
    role: str | None = None


@dataclass
class ToolResult:
    facts: list[Fact] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    followups: list[str] = field(default_factory=list)
    # Content-free retrieval evidence: tool, source category, record count, outcome, missing-field categories.
    diagnostics: list[dict] = field(default_factory=list)
    scope_hint: dict | None = None


def _q(value: Decimal | float, places: str = "0.01") -> Decimal:
    return Decimal(str(value)).quantize(Decimal(places), rounding=ROUND_HALF_UP)


def peso(centavos: Decimal | float | int) -> str:
    return f"₱{_q(Decimal(str(centavos)) / 100):,.2f}"


def kwh(value: Decimal | float) -> str:
    return f"{_q(value):,.2f} kWh"


def wh_kwh(wh: int | None) -> str:
    return kwh(Decimal(wh or 0) / 1000)


def pct(new: Decimal, old: Decimal) -> str | None:
    if old == 0:
        return None
    change = _q((new - old) / old * 100, "0.1")
    return f"{'+' if change > 0 else ''}{change}%"


def clean_label(value: object, maximum: int = 60) -> str:
    """User-entered labels are data, not instructions: strip control characters and bound length."""
    text = " ".join(str(value or "").split())
    text = "".join(ch for ch in text if ch.isprintable())
    return text[:maximum] or "Unnamed"


class AssistantTools:
    def __init__(self, store: DocumentStore | None, rentals: RentalService | None) -> None:
        self.store = store
        self.rentals = rentals

    # ------------------------------------------------------------ workspace
    def resolve_workspace(self, user: AuthUser, requested: dict | None) -> Workspace:
        requested = requested or {}
        if requested.get("type") != "rental":
            return Workspace("personal", "SmartWatts Personal")
        pid = requested.get("propertyId")
        if not isinstance(pid, str) or not pid or self.rentals is None or user.is_anonymous:
            raise DomainError("Choose a rental property you belong to.")
        membership = self.rentals._membership(pid, user.uid)
        if membership is None:
            from ..rentals.service import NotFound
            raise NotFound("Property not found.")
        prop = self.store.get("properties", pid) or {}
        if membership["role"] == TENANT:
            unit = self.store.get(f"properties/{pid}/units", membership.get("unitId") or "") or {}
            return Workspace("tenant", f"SmartWatts Rentals — {clean_label(prop.get('name'))} · Your Unit {clean_label(unit.get('label'), 30)}",
                             pid, TENANT)
        return Workspace("owner", f"SmartWatts Rentals — {clean_label(prop.get('name'))}", pid, membership["role"])

    # ------------------------------------------------------------ personal
    def _personal(self, uid: str, kind: str, limit: int) -> list[dict]:
        if self.store is None:
            return []
        return self.store.query(f"users/{uid}/{kind}")[:limit]

    def personal_appliances(self, user: AuthUser, rate_centavos: Decimal | None) -> ToolResult:
        result = ToolResult()
        rows = []
        for doc in self._personal(user.uid, "appliances", MAX_APPLIANCES):
            try:
                appliance = AdvisorAppliance(
                    name=clean_label(doc.get("name")), category=str(doc.get("category") or "other")[:40],
                    quantity=int(doc.get("quantity") or 1), watts=float(doc.get("watts") or 0),
                    hoursPerDay=float(doc.get("hoursPerDay") or 0), daysPerWeek=float(doc.get("daysPerWeek") or 7),
                    testedKwhMonth=float(doc["testedKwhMonth"]) if doc.get("testedKwhMonth") else None,
                )
            except (ValueError, TypeError):
                result.missing.append(f"Appliance “{clean_label(doc.get('name'))}” has no usable wattage or energy-label kWh.")
                continue
            monthly, basis = monthly_kwh(appliance)
            rows.append((appliance, monthly, basis))
        if not rows:
            result.missing.append("No appliances with wattage or energy-label kWh are registered (My Appliances).")
            return result
        rows.sort(key=lambda row: row[1], reverse=True)
        total = sum((row[1] for row in rows), Decimal(0))
        result.facts.append(Fact("appl-total", f"Estimated total for {len(rows)} registered appliance(s): {kwh(total)} per month.",
                                 "estimate", "My Appliances (wattage × usage hours)"))
        for index, (appliance, monthly, basis) in enumerate(rows[:8], start=1):
            text = f"{appliance.quantity} × {appliance.name}: {kwh(monthly)} per month"
            text += " from wattage and schedule" if basis == "wattage" else " from the manufacturer's tested kWh"
            if rate_centavos is not None:
                text += f", about {peso(monthly * rate_centavos)} per month"
            result.facts.append(Fact(f"appl-{index}", text + ".", "estimate", f"Appliance record “{appliance.name}”"))
        top = rows[0][0]
        result.facts.append(Fact("appl-top", f"Highest estimated consumer: {top.name} ({kwh(rows[0][1])} per month).", "estimate",
                                 f"Appliance record “{top.name}”"))
        result.assumptions.append("Wattage estimates: watts × quantity × hours/day × (days/week ÷ 7) × 30.4375 days ÷ 1000.")
        if rate_centavos is None:
            result.missing.append("No bill is recorded, so peso costs can't be estimated (Bill Upload & History).")
        result.followups.append(f"What if I use {top.name} 2 hours less per day?")
        self._appliances_cache = rows
        return result

    def simulate_reduction(self, user: AuthUser, appliance_hint: str, hours: Decimal, rate_centavos: Decimal | None) -> ToolResult:
        """Deterministic what-if: reduce one registered appliance's daily hours."""
        result = ToolResult()
        rows = getattr(self, "_appliances_cache", None)
        if rows is None:
            self.personal_appliances(user, rate_centavos)
            rows = getattr(self, "_appliances_cache", [])
        hint = appliance_hint.lower()
        match = next((row for row in rows if row[2] == "wattage" and any(word in row[0].name.lower() for word in hint.split() if len(word) > 2)), None)
        if match is None:
            match = next((row for row in rows if row[2] == "wattage" and row[0].category.lower() in hint), None)
        if match is None:
            result.missing.append("I couldn't find a registered appliance with wattage and hours that matches that name.")
            return result
        appliance = match[0]
        new_hours = max(Decimal(0), Decimal(str(appliance.hoursPerDay)) - hours)
        reduced_by = Decimal(str(appliance.hoursPerDay)) - new_hours
        saved = (Decimal(str(appliance.watts)) * appliance.quantity * reduced_by * (Decimal(str(appliance.daysPerWeek)) / 7)
                 * AVERAGE_DAYS_PER_MONTH / 1000)
        text = (f"Simulation: using {appliance.name} {_q(reduced_by, '0.1')} hour(s) less per day "
                f"({_q(Decimal(str(appliance.hoursPerDay)), '0.1')} → {_q(new_hours, '0.1')} h) saves about {kwh(saved)} per month")
        if rate_centavos is not None:
            text += f", about {peso(saved * rate_centavos)} per month at your latest bill's average rate"
        result.facts.append(Fact("sim-1", text + ".", "simulation", f"Appliance record “{appliance.name}” + latest bill rate"))
        result.assumptions.append("Simulations assume the same wattage and days per week; actual savings depend on real use.")
        return result

    def personal_bills(self, user: AuthUser) -> tuple[ToolResult, Decimal | None]:
        result = ToolResult()
        if self.store is None:
            result.missing.append("SmartWatts couldn't reach your saved bills (storage isn't configured on the server). This doesn't mean you have no bills.")
            result.diagnostics.append({"tool": "get_personal_bills", "source": "personal_bills", "records": 0, "outcome": bill_model.RETRIEVAL_ERROR})
            return result, None
        found = bill_model.retrieve_personal_bills(self.store, user.uid, MAX_BILLS)
        result.diagnostics.append({"tool": "get_personal_bills", "source": "personal_bills", "records": found.record_count,
                                   "outcome": found.outcome, "missingFields": sorted(found.unreadable)})
        if found.outcome == bill_model.RETRIEVAL_ERROR:
            result.missing.append("I couldn't load your saved bills right now (a temporary error). This doesn't mean you have no bills — please try again.")
            return result, None
        if found.unreadable.get("billing_period") or found.unreadable.get("amount_and_kwh"):
            count = found.unreadable.get("billing_period", 0) + found.unreadable.get("amount_and_kwh", 0)
            result.missing.append(f"{count} saved bill record(s) are missing a billing period or figures, so I can't use them. Re-save them in Bill Upload & History.")
        if found.outcome == bill_model.NO_RECORDS:
            result.missing.append("No saved bills were found in SmartWatts Personal. A scanned bill photo isn't stored until you review the figures, "
                                  "tick the confirmation box, and press “Save bill” in Bill Upload & History.")
            result.followups.append("How do I save a bill from a photo?")
            return result, None
        if found.outcome == bill_model.UNREADABLE_ONLY:
            return result, None

        def describe(bill: bill_model.SavedBill) -> str:
            parts = []
            if bill.amount_centavos is not None:
                parts.append(f"current charges of {peso(bill.amount_centavos)}")
            else:
                parts.append("no amount saved")
            if bill.kwh is not None:
                parts.append(kwh(bill.kwh))
            return ", ".join(parts)

        def source(bill: bill_model.SavedBill) -> str:
            saved = f", saved {bill.saved_at.date().isoformat()}" if bill.saved_at else ""
            return f"Saved bill {bill.period_label} ({bill.source_label}{saved})"

        latest = found.latest_by_period()
        newest_upload = found.latest_saved()
        result.facts.append(Fact("bill-latest", f"Latest billing period on record: {latest.period_label} — {describe(latest)}.",
                                 "bill_derived", source(latest)))
        if newest_upload is not None and newest_upload is not latest:
            result.facts.append(Fact("bill-last-saved", f"Most recently saved bill: {newest_upload.period_label} — {describe(newest_upload)}.",
                                     "bill_derived", source(newest_upload)))
        if latest.amount_centavos is None:
            result.missing.append(f"The bill for {latest.period_label} was saved without an amount, so I can't tell you its charges.")
        rate = Decimal(latest.amount_centavos) / latest.kwh if latest.amount_centavos is not None and latest.kwh else None
        if rate is not None:
            result.facts.append(Fact("bill-rate", f"Average cost on that bill: {peso(rate)} per kWh (current charges ÷ kWh).", "bill_derived",
                                     source(latest)))
        previous = found.previous_by_period()
        if previous is not None:
            result.facts.append(Fact("bill-previous", f"Previous billing period: {previous.period_label} — {describe(previous)}.",
                                     "bill_derived", source(previous)))
            if latest.kwh is not None and previous.kwh is not None and latest.amount_centavos is not None and previous.amount_centavos is not None:
                d_kwh, d_amount = latest.kwh - previous.kwh, latest.amount_centavos - previous.amount_centavos
                change = pct(latest.kwh, previous.kwh)
                result.facts.append(Fact(
                    "bill-change",
                    f"From the previous bill ({previous.period_label}) to the latest ({latest.period_label}), billed consumption "
                    f"{'increased' if d_kwh > 0 else 'decreased' if d_kwh < 0 else 'did not change'} by {kwh(abs(d_kwh))}"
                    f"{f' ({change})' if change else ''} and current charges changed by {'+' if d_amount >= 0 else '-'}{peso(abs(d_amount))}.",
                    "bill_derived", f"Saved bills {previous.period_label} and {latest.period_label}"))
        else:
            result.missing.append("Only one bill is saved, so there is no previous billing period to compare with yet.")
            result.followups.append("How do I add my previous bill?")
        result.assumptions.append("Bill amounts are the “total current charges” you confirmed when saving (this period's charges, "
                                  "excluding any unpaid balance). SmartWatts has no payment records, so it can't confirm what was paid.")
        result.followups.append("Compare my last two bills")
        return result, rate

    def personal_bill_count(self, user: AuthUser) -> int | None:
        """Count only (no figures) of the caller's own Personal bills — used to explain workspace scope."""
        if self.store is None:
            return None
        found = bill_model.retrieve_personal_bills(self.store, user.uid, MAX_BILLS)
        return None if found.outcome == bill_model.RETRIEVAL_ERROR else len(found.bills)

    def personal_savings(self, user: AuthUser) -> ToolResult:
        result = ToolResult()
        plans = self._personal(user.uid, "savingsPlans", MAX_PLANS)
        if not plans:
            result.missing.append("No savings scenarios are saved (Savings Simulator).")
        for index, plan in enumerate(plans, start=1):
            try:
                result.facts.append(Fact(f"plan-{index}",
                                         f"Saved scenario “{clean_label(plan.get('title'))}”: {kwh(Decimal(str(plan['monthlyKwhSaved'])))} and "
                                         f"{peso(int(plan['monthlySavingsCentavos']))} saved per month (simulation).",
                                         "simulation", f"Savings scenario “{clean_label(plan.get('title'))}”"))
            except (KeyError, ValueError, TypeError):
                continue
        return result

    def personal_usage_days(self, user: AuthUser) -> ToolResult:
        result = ToolResult()
        by_day: dict[str, Decimal] = {}
        for doc in self._personal(user.uid, "readings", MAX_READINGS):
            created = doc.get("createdAt")
            day = created.date().isoformat() if hasattr(created, "date") else str(created or "")[:10]
            try:
                by_day[day] = by_day.get(day, Decimal(0)) + Decimal(str(doc["kwh"]))
            except (KeyError, ValueError, TypeError, ArithmeticError):
                continue
        if not by_day:
            result.missing.append("No daily usage records are saved, so I can't rank days. SmartWatts doesn't read meters automatically; "
                                  "add bills or readings to track consumption.")
            return result
        for index, (day, total) in enumerate(sorted(by_day.items(), key=lambda item: item[1], reverse=True)[:3], start=1):
            result.facts.append(Fact(f"day-{index}", f"{day}: {kwh(total)} recorded.", "user_entered", f"Usage record {day}"))
        return result

    @staticmethod
    def browser_state(state: dict | None) -> ToolResult:
        result = ToolResult()
        if not state:
            return result
        coins = state.get("coinBalanceCents")
        if isinstance(coins, int) and 0 <= coins <= 10_000_000:
            result.facts.append(Fact("coins", f"Watts Coins balance shown in this browser: {_q(Decimal(coins) / 100)} coins.",
                                     "browser_reported", "Watts Coins (stored in this browser)"))
        target = state.get("monthlyTargetKwh")
        if isinstance(target, (int, float)) and 50 <= target <= 2000:
            result.facts.append(Fact("goal", f"Monthly energy goal set in this browser: {kwh(Decimal(str(target)))}.",
                                     "browser_reported", "Energy Goals (stored in this browser)"))
        return result

    # ------------------------------------------------------------ rentals (owner/admin)
    def subscription(self, user: AuthUser, ws: Workspace) -> ToolResult:
        result = ToolResult()
        sub = self.rentals.get_subscription(user, ws.property_id)
        text = f"Subscription status: {sub['lifecycle'].replace('_', ' ')}."
        if sub.get("currentPeriodEnd"):
            text += f" Entitlement period ends {sub['currentPeriodEnd'][:10]}."
        if sub.get("statusReason"):
            text += f" Reason recorded by SmartWatts staff: {clean_label(sub['statusReason'], 200)}."
        text += f" Next step: {sub['nextAction']['label']}."
        result.facts.append(Fact("sub", text, "status", "Subscription page"))
        return result

    def owner_overview(self, user: AuthUser, ws: Workspace) -> ToolResult:
        result = ToolResult()
        prop = self.rentals.get_property(user, ws.property_id)
        setup = prop.get("setup") or {}
        result.facts.append(Fact("prop-setup", f"Property setup: {setup.get('unitCount', 0)} active unit(s) of {prop['entitlement']['unitLimit']}, "
                                               f"{setup.get('meterCount', 0)} meter(s).", "status", "Property overview"))
        if setup.get("unitsWithoutBillingArrangement"):
            labels = ", ".join(clean_label(label, 30) for label in setup["unitsWithoutBillingArrangement"][:10])
            result.facts.append(Fact("prop-unconfigured", f"Units without a meter or allocation agreement: {labels}.", "status", "Property overview"))
        try:
            analytics = self.rentals.analytics(user, ws.property_id)
        except PaymentRequired:
            result.missing.append("Property analytics need an active subscription, so missing-reading checks aren't available.")
            return result
        alerts = analytics.get("missingReadingsAlerts", [])
        if alerts:
            listed = "; ".join(f"{clean_label(a['meterLabel'], 30)} ({a['issue']})" for a in alerts[:10])
            result.facts.append(Fact("missing-readings", f"Meters needing a reading: {listed}.", "status", "Property analytics · readings"))
        else:
            result.facts.append(Fact("missing-readings", "No meters are missing readings for the latest billing period.", "status",
                                     "Property analytics · readings"))
        summary = analytics.get("statementsSummary", {})
        result.facts.append(Fact("stmt-summary", f"Statements: {summary.get('finalizedCount', 0)} published, {summary.get('draftCount', 0)} draft, "
                                                 f"{summary.get('needsReviewCount', 0)} needing fixes.", "status", "Tenant statements"))
        return result

    def owner_readings(self, user: AuthUser, ws: Workspace) -> ToolResult:
        result = ToolResult()
        meters = {m["id"]: m for m in self.rentals.list_meters(user, ws.property_id)["meters"]}
        readings = [r for r in self.rentals.list_readings(user, ws.property_id) if r["status"] == "active"][:MAX_READINGS]
        latest: dict[str, dict] = {}
        for r in readings:
            if r.get("intervalWh") is not None and (r["meterId"] not in latest or r["readingDate"] > latest[r["meterId"]]["readingDate"]):
                latest[r["meterId"]] = r
        if not latest:
            result.missing.append("No meter has two readings yet, so interval consumption can't be calculated.")
            return result
        ranked = sorted(latest.values(), key=lambda r: r["intervalWh"], reverse=True)
        for index, r in enumerate(ranked[:5], start=1):
            meter = meters.get(r["meterId"], {})
            shared = meter.get("kind") == "utility_shared"
            text = (f"{clean_label(meter.get('label'), 30)}: {wh_kwh(r['intervalWh'])} over {r['intervalDays']} day(s) ending {r['readingDate']}"
                    f"{' (shared meter: building total, not one unit)' if shared else ''}.")
            if r.get("anomalies"):
                text += " Flagged: " + " ".join(r["anomalies"])
            result.facts.append(Fact(f"interval-{index}", text, "actual_reading", f"Meter readings up to {r['readingDate']}"))
        top = ranked[0]
        result.facts.append(Fact("interval-top", f"Highest latest-interval consumption: {clean_label(meters.get(top['meterId'], {}).get('label'), 30)} "
                                                 f"({wh_kwh(top['intervalWh'])}).", "actual_reading", f"Meter readings up to {top['readingDate']}"))
        return result

    def owner_bills(self, user: AuthUser, ws: Workspace) -> ToolResult:
        result = ToolResult()
        meters = {m["id"]: m for m in self.rentals.list_meters(user, ws.property_id)["meters"]}
        bills = [b for b in self.rentals.list_bills(user, ws.property_id) if b.get("status") == "active"][:MAX_BILLS]
        result.diagnostics.append({"tool": "get_utility_bill_summary", "source": "property_utility_bills", "records": len(bills),
                                   "outcome": bill_model.RECORDS_FOUND if bills else bill_model.NO_RECORDS})
        if not bills:
            result.missing.append("No utility bills are saved for this property (Utility Bills page). A bill photo only suggests figures; "
                                  "the bill is stored after you press “Save bill”, which needs an active subscription.")
            return result
        by_meter: dict[str, list[dict]] = {}
        for b in sorted(bills, key=lambda b: b["periodEnd"]):
            by_meter.setdefault(b["meterId"], []).append(b)
        for index, (meter_id, series) in enumerate(by_meter.items(), start=1):
            label = clean_label(meters.get(meter_id, {}).get("label"), 30)
            last = series[-1]
            text = f"{label}: latest bill {last['periodStart']} to {last['periodEnd']}, {wh_kwh(last['totalWh'])}, {peso(last['amountCentavos'])}"
            if len(series) >= 2:
                prev = series[-2]
                change = pct(Decimal(last["totalWh"]), Decimal(prev["totalWh"]))
                text += f"; previous bill {wh_kwh(prev['totalWh'])}, {peso(prev['amountCentavos'])}{f' ({change} kWh)' if change else ''}"
            result.facts.append(Fact(f"pbill-{index}", text + " (owner-entered).", "bill_derived", f"Utility bills · {label}"))
        return result

    # ------------------------------------------------------------ rentals (tenant)
    def tenant_unit(self, user: AuthUser, ws: Workspace) -> ToolResult:
        result = ToolResult()
        unit = self.rentals.my_unit(user, ws.property_id)
        if unit["meters"]:
            meters = ", ".join(f"{clean_label(m['label'], 30)} ({m['kind'].replace('_', ' ')})" for m in unit["meters"])
            result.facts.append(Fact("unit-meters", f"Your unit's meter(s): {meters}.", "status", "Your Unit"))
        for index, a in enumerate(unit.get("sharedArrangements", []), start=1):
            share = _q(Decimal(a["unitWeight"]) / Decimal(a["totalWeight"]) * 100, "0.1")
            result.facts.append(Fact(f"unit-share-{index}",
                                     f"{clean_label(a['meterLabel'], 30)} is a shared meter. Your agreed share is {a['unitWeight']} of {a['totalWeight']} "
                                     f"({share}%) of the shared consumption allocated to tenants. This is an allocation, not a measurement of your unit.",
                                     "allocation", "Allocation agreement"))
        if not unit["meters"] and not unit.get("sharedArrangements"):
            result.missing.append("Your landlord hasn't set up a meter or allocation for your unit yet.")
        return result

    def tenant_statements(self, user: AuthUser, ws: Workspace) -> ToolResult:
        result = ToolResult()
        published = [s for s in self.rentals.my_statements(user, ws.property_id) if s["status"] == "finalized"][:MAX_BILLS]
        if not published:
            result.missing.append("Your landlord hasn't published any statements for you yet.")
            return result
        published.sort(key=lambda s: s["periodEnd"])

        def parts(statement: dict) -> tuple[int, int]:
            measured = sum(line.get("wh") or 0 for line in statement["lines"] if line.get("consumptionKind") != "not_individually_measured")
            allocated = sum(line.get("wh") or 0 for line in statement["lines"] if line.get("consumptionKind") == "not_individually_measured"
                            or line.get("chargeBasis") == "allocation_based_charge")
            return measured, allocated

        last = published[-1]
        measured, allocated = parts(last)
        text = (f"Latest published statement {last['periodStart']} to {last['periodEnd']} (version {last['version']}): {peso(last['totalCentavos'])}; "
                f"measured {wh_kwh(measured)}")
        text += f", allocated share {wh_kwh(allocated)}" if allocated else ""
        result.facts.append(Fact("stmt-latest", text + ".", "bill_derived", f"Statement {last['periodStart']} – {last['periodEnd']} v{last['version']}"))
        if allocated:
            result.facts.append(Fact("stmt-allocation", "Part of this statement is a shared-meter allocation under your lease agreement, not measured use of your unit.",
                                     "allocation", f"Statement v{last['version']}"))
        if len(published) >= 2:
            prev = published[-2]
            p_measured, p_allocated = parts(prev)
            diff = last["totalCentavos"] - prev["totalCentavos"]
            text = (f"Compared with the previous statement ({prev['periodStart']} to {prev['periodEnd']}: {peso(prev['totalCentavos'])}), the total changed by "
                    f"{'+' if diff >= 0 else '-'}{peso(abs(diff))}; measured use changed from {wh_kwh(p_measured)} to {wh_kwh(measured)}")
            if allocated or p_allocated:
                text += f" and the allocated share from {wh_kwh(p_allocated)} to {wh_kwh(allocated)}"
            parent_now, parent_prev = last.get("utilityBill") or {}, prev.get("utilityBill") or {}
            if parent_now.get("amountCentavos") and parent_prev.get("amountCentavos") and parent_now.get("totalWh") and parent_prev.get("totalWh"):
                rate_now = Decimal(parent_now["amountCentavos"]) / (Decimal(parent_now["totalWh"]) / 1000)
                rate_prev = Decimal(parent_prev["amountCentavos"]) / (Decimal(parent_prev["totalWh"]) / 1000)
                text += f"; the utility bill's average rate went from {peso(rate_prev)} to {peso(rate_now)} per kWh"
            result.facts.append(Fact("stmt-change", text + ".", "bill_derived",
                                     f"Statements v{prev['version']} ({prev['periodEnd']}) and v{last['version']} ({last['periodEnd']})"))
        else:
            result.missing.append("Only one published statement exists, so there's no previous month to compare.")
        return result

    def tenant_readings(self, user: AuthUser, ws: Workspace) -> ToolResult:
        result = ToolResult()
        history = self.rentals.my_meter_history(user, ws.property_id)[:MAX_READINGS]
        if not history:
            result.missing.append("No individual meter readings are available for your unit (shared-meter readings are not shown).")
            return result
        for index, r in enumerate(history[:5], start=1):
            result.facts.append(Fact(f"tread-{index}", f"{clean_label(r['meterLabel'], 30)} read {wh_kwh(r['valueWh'])} on {r['readingDate']}"
                                                       f"{' (corrected)' if r.get('corrected') else ''}.", "actual_reading",
                                     f"Meter reading {r['readingDate']}"))
        return result


__all__ = ["AssistantTools", "Fact", "ToolResult", "Workspace", "MANAGERS", "KINDS"]
