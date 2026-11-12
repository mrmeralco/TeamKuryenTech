"""Idempotent SmartWatts Rentals demo-fixture seeding (emulator / isolated demo stores only).

Every record is created through :class:`RentalService` — the same validated code paths the API
uses — so the Owner and Tenant dashboards read genuine persisted records, not UI-only values:

* the owner creates the property, units, meters and assignments, and records readings and bills;
* the owner requests activation and a *seed operator* identity (an in-process ``AuthUser`` with
  ``platform_admin=True``) records an ``administrative_grant`` through the normal transition.
  No Firebase custom claim is read or written;
* the tenant joins Unit 101 by redeeming an email-restricted invitation (exact verified email);
* statements are generated from the bills, reviewed and published by the owner.

Safety:

* The fixture is validated (schema, referential integrity, interval arithmetic) before any write.
* A fixture-owned property carries ``demoFixtureId`` / ``demoLabel``. A complete seed is a no-op on
  re-run; an incomplete one must be rolled back first. Non-fixture records are never updated.
* Rollback deletes only records that belong to a fixture-marked property, and refuses when that
  property has members other than the fixture identities.
* Mail: the shared notification outbox is swapped for a throwaway in-memory store and a sender that
  refuses delivery for the whole run, and the outbox is never processed.

The fixture's three *property* bills are stored as one bill per individual utility meter (the app
records official bills per meter); the per-period sums equal the fixture totals exactly.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from ..auth import AuthUser
from .config import RentalsConfig
from .service import RentalService
from .store import DocumentStore, InMemoryStore

SCHEMA_VERSION = "1.0"
SEED_OPERATOR_UID = "demo-seed-operator"
GRANT_REASON = "SmartWatts Owner and Tenant NFC demonstration (synthetic emulator fixture grant)."
PROPERTY_SUBCOLLECTIONS = (
    "units", "meters", "meterAssignments", "allocationAgreements", "meterReadings", "utilityBills",
    "statements", "billingRuns", "occupancies", "reviewRequests", "auditLogs",
)
PROPERTY_SCOPED_COLLECTIONS = ("memberships", "invitations", "subscriptionEvents", "rentalNotifications")
METER_KIND_MAP = {"individual": "utility_individual"}


class SeedError(Exception):
    """The fixture, target, or existing data does not allow a safe seed."""


@dataclass(frozen=True)
class Account:
    """A verified sign-in account resolved by exact email from the target Auth service."""

    role: str
    email: str
    uid: str
    email_verified: bool
    disabled: bool = False

    def auth_user(self) -> AuthUser:
        return AuthUser(uid=self.uid, sign_in_provider="password", email=self.email, email_verified=self.email_verified)


# --------------------------------------------------------------------------- fixture
def load_fixture(path: str | Path) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SeedError(f"Cannot read fixture {path}: {error}") from error


def _iso(value: object, where: str, errors: list[str]) -> date | None:
    try:
        return date.fromisoformat(value) if isinstance(value, str) and len(value) == 10 else None
    except ValueError:
        pass
    errors.append(f"{where}: expected a YYYY-MM-DD date, got {value!r}")
    return None


def _whole(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_fixture(fixture: dict, today: date) -> dict:
    """Validates the fixture and returns the derived per-meter plan. Raises SeedError listing every problem."""
    errors: list[str] = []
    if fixture.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {SCHEMA_VERSION!r}")
    policy = fixture.get("environmentPolicy") or {}
    if policy.get("productionWritesAllowed") is not False:
        errors.append("environmentPolicy.productionWritesAllowed must be false")
    if policy.get("replaceExistingRecords") is not False:
        errors.append("environmentPolicy.replaceExistingRecords must be false")
    if not isinstance(fixture.get("demoLabel"), str) or not fixture["demoLabel"].strip():
        errors.append("demoLabel is required so the UI can label the data as synthetic")

    identities = fixture.get("identities") or {}
    for role in ("platformStaff", "owner", "tenant"):
        email = (identities.get(role) or {}).get("email")
        if not isinstance(email, str) or "@" not in email:
            errors.append(f"identities.{role}.email is required")
    if (identities.get("platformStaff") or {}).get("seedStaffClaims") is not False:
        errors.append("identities.platformStaff.seedStaffClaims must be false (staff claims are never seeded)")
    emails = [(identities.get(r) or {}).get("email", "").lower() for r in ("platformStaff", "owner", "tenant")]
    if len(set(emails)) != 3:
        errors.append("staff, owner and tenant must be three different accounts")
    tenant_email = (identities.get("tenant") or {}).get("email", "").lower()

    prop = fixture.get("property") or {}
    for key in ("fixtureId", "name", "address"):
        if not isinstance(prop.get(key), str) or not prop[key].strip():
            errors.append(f"property.{key} is required")
    if prop.get("currency") != "PHP":
        errors.append("property.currency must be PHP")
    unit_limit = prop.get("unitLimit")
    if not _whole(unit_limit) or not 1 <= unit_limit <= 10:
        errors.append("property.unitLimit must be a whole number from 1 to 10")
    if prop.get("meteringModel") != "individually-metered":
        errors.append("only the individually-metered model is supported (shared meters are never treated as measured use)")

    units = prop.get("units") or []
    meters = prop.get("meters") or []
    unit_ids = [u.get("fixtureId") for u in units]
    meter_ids = [m.get("fixtureId") for m in meters]
    if not units or len(set(unit_ids)) != len(units):
        errors.append("property.units must be non-empty with unique fixtureIds")
    if len({(u.get("label") or "").lower() for u in units}) != len(units):
        errors.append("unit labels must be unique")
    if _whole(unit_limit) and len(units) > unit_limit:
        errors.append("more units than the property's unit limit")
    if len(set(meter_ids)) != len(meters):
        errors.append("meter fixtureIds must be unique")
    units_by_id = {u.get("fixtureId"): u for u in units}
    for m in meters:
        if m.get("kind") not in METER_KIND_MAP:
            errors.append(f"meter {m.get('fixtureId')}: unsupported kind {m.get('kind')!r}")
        if m.get("unit") != "kWh":
            errors.append(f"meter {m.get('fixtureId')}: unit must be kWh")
        unit = units_by_id.get(m.get("unitFixtureId"))
        if unit is None:
            errors.append(f"meter {m.get('fixtureId')}: unknown unit {m.get('unitFixtureId')!r}")
        elif unit.get("meterFixtureId") != m.get("fixtureId"):
            errors.append(f"meter {m.get('fixtureId')}: unit {unit['fixtureId']} points to a different meter")
    occupied = []
    for u in units:
        if u.get("meterFixtureId") not in meter_ids:
            errors.append(f"unit {u.get('fixtureId')}: unknown meter {u.get('meterFixtureId')!r}")
        if u.get("occupancy") == "occupied":
            occupied.append(u)
            if (u.get("tenantEmail") or "").lower() != tenant_email:
                errors.append(f"unit {u.get('fixtureId')}: occupied units must name the fixture tenant's email")
            _iso(u.get("occupancyStart"), f"unit {u.get('fixtureId')}.occupancyStart", errors)
        elif u.get("occupancy") == "vacant":
            if u.get("tenantEmail") is not None or u.get("occupancyStart") is not None:
                errors.append(f"unit {u.get('fixtureId')}: a vacant unit cannot have a tenant or occupancy start")
        else:
            errors.append(f"unit {u.get('fixtureId')}: occupancy must be occupied or vacant")
    if len(occupied) != 1:
        errors.append("exactly one occupied unit (the fixture tenant's) is supported")

    # Readings: per meter, unique dates, never decreasing, never in the future.
    readings: dict[str, dict[date, int]] = {mid: {} for mid in meter_ids}
    for r in prop.get("meterReadings") or []:
        mid = r.get("meterFixtureId")
        day = _iso(r.get("date"), f"reading {mid}", errors)
        value = r.get("readingKwh")
        if mid not in readings:
            errors.append(f"reading: unknown meter {mid!r}")
            continue
        if not _whole(value) or value < 0:
            errors.append(f"reading {mid} {r.get('date')}: readingKwh must be a non-negative whole number")
            continue
        if day is None:
            continue
        if day > today:
            errors.append(f"reading {mid} {day}: date is in the future")
        if day in readings[mid]:
            errors.append(f"reading {mid} {day}: duplicate date")
        readings[mid][day] = value
    for mid, series in readings.items():
        values = [series[d] for d in sorted(series)]
        if any(b < a for a, b in zip(values, values[1:])):
            errors.append(f"meter {mid}: readings go backwards")
        if not series:
            errors.append(f"meter {mid}: no readings")

    # Interval usage between the reading on periodStart and the reading the day after periodEnd.
    def interval(mid: str, start: date, end: date) -> int | None:
        series = readings.get(mid, {})
        after = end + timedelta(days=1)
        if start not in series or after not in series:
            errors.append(f"meter {mid}: needs readings on {start} and {after} to measure {start} – {end}")
            return None
        return series[after] - series[start]

    statements = prop.get("tenantStatements") or []
    rates = {s.get("illustrativeRatePhpPerKwh") for s in statements}
    rate = next(iter(rates)) if len(rates) == 1 else None
    if not _whole(rate) or rate <= 0:
        errors.append("all statements must share one positive whole-peso illustrative rate")
        rate = None

    bill_plan = []
    bills = sorted(prop.get("utilityBills") or [], key=lambda b: b.get("periodStart") or "")
    for i, b in enumerate(bills):
        where = f"bill {b.get('fixtureId')}"
        start = _iso(b.get("periodStart"), f"{where}.periodStart", errors)
        end = _iso(b.get("periodEnd"), f"{where}.periodEnd", errors)
        _iso(b.get("dueDate"), f"{where}.dueDate", errors)
        if b.get("paymentStatus") != "unknown":
            errors.append(f"{where}: paymentStatus must be 'unknown' (no payment confirmation exists)")
        if not _whole(b.get("billedKwh")) or not _whole(b.get("amountDuePhp")):
            errors.append(f"{where}: billedKwh and amountDuePhp must be whole numbers")
            continue
        if start is None or end is None:
            continue
        if end <= start or (end - start).days > RentalsConfig().max_bill_period_days:
            errors.append(f"{where}: invalid billing period")
        if end > today:
            errors.append(f"{where}: period ends in the future")
        if i and bills[i - 1].get("periodEnd", "") >= b["periodStart"]:
            errors.append(f"{where}: overlaps the previous bill")
        per_meter = []
        for m in meters:
            kwh = interval(m["fixtureId"], start, end)
            if kwh is not None:
                per_meter.append({"meterFixtureId": m["fixtureId"], "kwh": kwh,
                                  "amountCentavos": kwh * rate * 100 if rate else None})
        if len(per_meter) == len(meters):
            if sum(p["kwh"] for p in per_meter) != b["billedKwh"]:
                errors.append(f"{where}: billedKwh {b['billedKwh']} != sum of meter intervals {sum(p['kwh'] for p in per_meter)}")
            if rate and b["billedKwh"] * rate != b["amountDuePhp"]:
                errors.append(f"{where}: amountDuePhp {b['amountDuePhp']} != billedKwh x illustrative rate")
        bill_plan.append({**b, "meters": per_meter})

    occupied_unit = occupied[0] if len(occupied) == 1 else {}
    bill_periods = {b.get("periodStart", "")[:7]: b for b in bills}
    if len({s.get("period") for s in statements}) != len(statements):
        errors.append("one statement per period is expected")
    for s in statements:
        where = f"statement {s.get('fixtureId')}"
        if s.get("unitFixtureId") != occupied_unit.get("fixtureId"):
            errors.append(f"{where}: statements are only for the occupied unit")
        if s.get("notificationEnabled") is not False:
            errors.append(f"{where}: notificationEnabled must be false")
        if s.get("status") != "published-demo":
            errors.append(f"{where}: status must be published-demo")
        bill = bill_periods.get(s.get("period"))
        if bill is None:
            errors.append(f"{where}: no utility bill for period {s.get('period')!r}")
            continue
        start, end = _iso(bill.get("periodStart"), where, errors), _iso(bill.get("periodEnd"), where, errors)
        occ_start = _iso(occupied_unit.get("occupancyStart"), where, errors)
        if start and occ_start and occ_start > start:
            errors.append(f"{where}: the tenant's occupancy must cover the whole billing period")
        measured = interval(occupied_unit.get("meterFixtureId"), start, end) if start and end else None
        if measured is not None and measured != s.get("meteredKwh"):
            errors.append(f"{where}: meteredKwh {s.get('meteredKwh')} != meter interval {measured}")
        if rate and _whole(s.get("meteredKwh")) and s["meteredKwh"] * rate != s.get("calculatedAmountPhp"):
            errors.append(f"{where}: calculatedAmountPhp != meteredKwh x illustrative rate")

    if errors:
        raise SeedError("Fixture validation failed:\n  - " + "\n  - ".join(dict.fromkeys(errors)))
    return {"rate": rate, "bills": bill_plan, "occupiedUnit": occupied_unit, "readings": readings}


# --------------------------------------------------------------------------- mail guard
class _BlockedSender:
    """Records attempted deliveries and refuses every one of them."""

    def __init__(self) -> None:
        self.attempts: list[tuple[str, str]] = []

    def __call__(self, template: str, to: str, data: dict) -> None:
        self.attempts.append((template, to))
        raise RuntimeError("Email delivery is disabled while seeding demo fixtures.")


@contextlib.contextmanager
def mail_sandbox() -> Iterator[dict]:
    """Isolates the shared notification outbox for the duration of a seed run."""
    from ..notifications.service import notification_service

    sandbox_store, sender = InMemoryStore(), _BlockedSender()
    previous = (notification_service.store, notification_service.email_sender)
    notification_service.store, notification_service.email_sender = sandbox_store, sender
    report = {"queuedInSandbox": 0, "deliveryAttempts": 0, "delivered": 0}
    try:
        yield report
    finally:
        report["queuedInSandbox"] = len(sandbox_store.query("notifications_outbox"))
        report["deliveryAttempts"] = len(sender.attempts)
        notification_service.store, notification_service.email_sender = previous


# --------------------------------------------------------------------------- seeder
class DemoSeeder:
    def __init__(
        self,
        store: DocumentStore,
        fixture: dict,
        accounts: dict[str, Account],
        *,
        clock: Callable[[], datetime] | None = None,
        grant_days: int = 30,
    ) -> None:
        self.store = store
        self.fixture = fixture
        self.accounts = accounts
        self.clock = clock or (lambda: datetime.now(UTC))
        self.grant_days = grant_days
        unit_limit = (fixture.get("property") or {}).get("unitLimit") or 10
        self.service = RentalService(store, RentalsConfig(unit_limit_per_property=unit_limit), clock=self.clock)
        self.plan = validate_fixture(fixture, self.clock().date())
        self._verify_accounts()

    # ------------------------------------------------------------ identity
    def _verify_accounts(self) -> None:
        identities = self.fixture["identities"]
        for role in ("owner", "tenant"):
            account = self.accounts.get(role)
            expected = identities[role]["email"]
            if account is None:
                raise SeedError(f"No {role} account was resolved for {expected}.")
            if account.email.lower() != expected.lower():
                raise SeedError(f"{role} account email {account.email!r} does not match the fixture ({expected!r}).")
            if account.disabled or not account.email_verified:
                raise SeedError(f"{role} account {expected} must be enabled and email-verified.")
        if self.accounts["owner"].uid == self.accounts["tenant"].uid:
            raise SeedError("Owner and tenant resolved to the same UID.")
        if any(a.uid == SEED_OPERATOR_UID for a in self.accounts.values()):
            raise SeedError("An account uses the reserved seed-operator UID.")

    @property
    def fixture_id(self) -> str:
        return self.fixture["property"]["fixtureId"]

    def fixture_properties(self) -> list[dict]:
        return self.store.query("properties", demoFixtureId=self.fixture_id)

    def status(self) -> dict:
        found = self.fixture_properties()
        if not found:
            return {"state": "absent", "propertyIds": []}
        complete = len(found) == 1 and found[0].get("seedStatus") == "complete"
        return {"state": "complete" if complete else "incomplete", "propertyIds": [p["id"] for p in found]}

    # ------------------------------------------------------------ preview
    def preview(self) -> dict:
        prop = self.fixture["property"]
        meter_label = {m["fixtureId"]: self._meter_label(m["fixtureId"]) for m in prop["meters"]}
        return {
            "fixtureId": self.fixture_id,
            "existing": self.status(),
            "accounts": {role: {"email": a.email, "uid": a.uid} for role, a in self.accounts.items()},
            "property": {"name": prop["name"], "address": prop["address"], "demoLabel": self.fixture["demoLabel"]},
            "subscription": {"action": "request → approve", "activationSource": "administrative_grant",
                             "actorUid": SEED_OPERATOR_UID, "periodDays": self.grant_days,
                             "note": "Emulator fixture grant through the normal transition; no custom claims touched."},
            "units": [{"label": u["label"], "occupancy": u["occupancy"]} for u in prop["units"]],
            "meters": [{"label": meter_label[m["fixtureId"]], "kind": METER_KIND_MAP[m["kind"]]} for m in prop["meters"]],
            "meterReadings": [{"meter": meter_label[r["meterFixtureId"]], "date": r["date"], "kWh": r["readingKwh"]}
                              for r in prop["meterReadings"]],
            "tenantMembership": {"unit": self.plan["occupiedUnit"]["label"], "via": "email-restricted invitation, redeemed by the verified tenant",
                                 "moveInDate": self.plan["occupiedUnit"]["occupancyStart"]},
            "utilityBills": [
                {"period": f"{b['periodStart']} – {b['periodEnd']}", "meter": meter_label[m["meterFixtureId"]],
                 "kWh": m["kwh"], "amountPhp": m["amountCentavos"] / 100, "dueDate": b["dueDate"]}
                for b in self.plan["bills"] for m in b["meters"]
            ],
            "propertyBillTotals": [{"period": b["periodStart"][:7], "kWh": b["billedKwh"], "amountPhp": b["amountDuePhp"]}
                                   for b in self.plan["bills"]],
            "tenantStatements": [{"period": s["period"], "kWh": s["meteredKwh"], "amountPhp": s["calculatedAmountPhp"],
                                  "status": "published (finalized)"} for s in prop["tenantStatements"]],
            "illustrativeRatePhpPerKwh": self.plan["rate"],
            "email": "outbox sandboxed; delivery refused; never processed",
        }

    def _meter_label(self, meter_fixture_id: str) -> str:
        unit = next(u for u in self.fixture["property"]["units"] if u["meterFixtureId"] == meter_fixture_id)
        return f"Meter {unit['label'].removeprefix('Unit ').strip()}"

    # ------------------------------------------------------------ apply
    def apply(self) -> dict:
        state = self.status()
        if state["state"] == "complete":
            return {"result": "already-seeded", "propertyId": state["propertyIds"][0], "created": {}}
        if state["state"] == "incomplete":
            raise SeedError(
                f"An incomplete or duplicated fixture seed exists ({', '.join(state['propertyIds'])}). "
                "Run with --rollback first; nothing was changed."
            )
        with mail_sandbox() as mail:
            created = self._create_all()
        if mail["deliveryAttempts"] or mail["delivered"]:  # pragma: no cover - the outbox is never processed here
            raise SeedError("An email delivery was attempted during seeding.")
        return {"result": "seeded", "propertyId": created.pop("propertyId"), "created": created, "email": mail}

    def _create_all(self) -> dict:
        svc, prop_fx = self.service, self.fixture["property"]
        owner, tenant = self.accounts["owner"].auth_user(), self.accounts["tenant"].auth_user()
        operator = AuthUser(uid=SEED_OPERATOR_UID, sign_in_provider="password", email=None, email_verified=True, platform_admin=True)

        pid = svc.create_property(owner, {"name": prop_fx["name"], "address": prop_fx["address"]})["id"]
        # Fixture marker on the fixture-owned property only (drives duplicate detection, rollback and the UI label).
        self.store.update("properties", pid, {
            "demoFixtureId": self.fixture_id, "demoLabel": self.fixture["demoLabel"], "demoSchemaVersion": SCHEMA_VERSION,
            "seedStatus": "in_progress", "seededAt": self.clock().isoformat(),
        })

        unit_ids, meter_ids = {}, {}
        for u in prop_fx["units"]:
            unit_ids[u["fixtureId"]] = svc.create_unit(owner, pid, {"label": u["label"], "notes": "Synthetic demo unit."})["id"]
        first_reading = {mid: min(series) for mid, series in self.plan["readings"].items()}
        for m in prop_fx["meters"]:
            meter_ids[m["fixtureId"]] = svc.create_meter(owner, pid, {
                "label": self._meter_label(m["fixtureId"]), "kind": METER_KIND_MAP[m["kind"]],
                "serialNumber": f"DEMO-{m['fixtureId'].upper()}",
            })["id"]
            svc.create_assignment(owner, pid, {"meterId": meter_ids[m["fixtureId"]], "unitId": unit_ids[m["unitFixtureId"]],
                                               "effectiveFrom": first_reading[m["fixtureId"]].isoformat()})

        # Subscription: owner request → administrative grant through the normal, audited transition.
        svc.request_activation(owner, pid)
        version = (self.store.get("subscriptions", pid) or {}).get("version") or 0
        svc.platform_subscription_action(operator, pid, "approve", {
            "confirm": True, "expectedVersion": version, "activationSource": "administrative_grant",
            "reason": GRANT_REASON, "periodEnd": (self.clock().date() + timedelta(days=self.grant_days)).isoformat(),
        })

        for r in sorted(prop_fx["meterReadings"], key=lambda r: (r["meterFixtureId"], r["date"])):
            svc.record_reading(owner, pid, {"meterId": meter_ids[r["meterFixtureId"]], "readingDate": r["date"],
                                            "valueKwh": str(r["readingKwh"]), "confirmed": True, "source": "manual"})

        occupied = self.plan["occupiedUnit"]
        invite = svc.create_invitation(owner, pid, {"role": "tenant", "unitId": unit_ids[occupied["fixtureId"]],
                                                    "moveInDate": occupied["occupancyStart"], "email": occupied["tenantEmail"]})
        svc.redeem_invitation(tenant, invite["token"])

        bill_ids = []
        for b in self.plan["bills"]:
            for m in b["meters"]:
                bill_ids.append(svc.create_bill(owner, pid, {
                    "meterId": meter_ids[m["meterFixtureId"]], "periodStart": b["periodStart"], "periodEnd": b["periodEnd"],
                    "totalKwh": str(m["kwh"]), "amountCentavos": m["amountCentavos"], "dueDate": b["dueDate"],
                    "billNumber": f"DEMO-{b['periodStart'][:7]}-{self._meter_label(m['meterFixtureId']).split()[-1]}",
                })["id"])

        published = []
        for bill_id in bill_ids:
            run = svc.generate_statements(owner, pid, bill_id)
            for statement_id in run["statementIds"]:
                svc.review_statement(owner, pid, statement_id)
                published.append(svc.finalize_statement(owner, pid, statement_id))
        self._check_statements(published, unit_ids[occupied["fixtureId"]], tenant.uid)

        counts = {
            "properties": 1, "units": len(unit_ids), "meters": len(meter_ids), "meterAssignments": len(meter_ids),
            "meterReadings": len(prop_fx["meterReadings"]), "utilityBills": len(bill_ids),
            "publishedStatements": len(published), "tenantMemberships": 1, "occupancies": 1,
            "subscription": "active (administrative_grant)",
        }
        self.store.update("properties", pid, {"seedStatus": "complete", "seedSummary": {k: v for k, v in counts.items() if k != "subscription"}})
        return {"propertyId": pid, **counts}

    def _check_statements(self, published: list[dict], unit_id: str, tenant_uid: str) -> None:
        expected = {s["period"]: s for s in self.fixture["property"]["tenantStatements"]}
        if len(published) != len(expected):
            raise SeedError(f"Expected {len(expected)} published statements, generated {len(published)}.")
        for s in published:
            fx = expected.get(s["periodStart"][:7])
            measured_wh = sum(line["wh"] or 0 for line in s["lines"])
            if (fx is None or s["unitId"] != unit_id or s["tenantUid"] != tenant_uid
                    or s["totalCentavos"] != fx["calculatedAmountPhp"] * 100 or measured_wh != fx["meteredKwh"] * 1000):
                raise SeedError(f"Generated statement {s['id']} does not match the fixture.")

    # ------------------------------------------------------------ rollback
    def rollback(self) -> dict:
        allowed = {a.uid for a in self.accounts.values()}
        removed: dict[str, int] = {}
        properties = self.fixture_properties()
        for prop in properties:
            pid = prop["id"]
            if prop.get("demoFixtureId") != self.fixture_id:  # pragma: no cover - query guarantees this
                continue
            foreign = [m["uid"] for m in self.store.query("memberships", propertyId=pid) if m["uid"] not in allowed]
            if foreign:
                raise SeedError(f"Fixture property {pid} has non-fixture members; refusing to roll it back.")
        for prop in properties:
            pid = prop["id"]
            for name in PROPERTY_SUBCOLLECTIONS:
                for doc in self.store.query(f"properties/{pid}/{name}"):
                    self.store.delete(f"properties/{pid}/{name}", doc["id"])
                    removed[name] = removed.get(name, 0) + 1
            for name in PROPERTY_SCOPED_COLLECTIONS:
                for doc in self.store.query(name, propertyId=pid):
                    self.store.delete(name, doc["id"])
                    removed[name] = removed.get(name, 0) + 1
            if self.store.get("subscriptions", pid):
                self.store.delete("subscriptions", pid)
                removed["subscriptions"] = removed.get("subscriptions", 0) + 1
            self.store.delete("properties", pid)
            removed["properties"] = removed.get("properties", 0) + 1
        return {"result": "rolled-back" if properties else "nothing-to-roll-back",
                "propertyIds": [p["id"] for p in properties], "removed": removed}
