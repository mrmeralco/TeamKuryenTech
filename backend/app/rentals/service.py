"""SmartWatts Rentals (Tier 2) domain service.

Server-authoritative membership checks, property-scoped subscription
entitlements, billing workflows, and audit logging. Every privileged action
in the Rentals API goes through this class.

Privacy boundary: this service never reads ``users/{uid}/**`` (personal
appliances, schedules, savings plans, AI conversations). Owners and
administrators therefore cannot reach tenant-private data through it.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

from ..auth import AuthUser
from . import billing
from .billing import BillingError, parse_kwh_to_wh
from .config import RentalsConfig
from .store import AlreadyExistsError, BlobStore, DocumentStore

OWNER = "owner"
ADMIN = "admin"
TENANT = "tenant"
MANAGERS = {OWNER, ADMIN}
METER_KINDS = {"utility_individual", "utility_shared", "private_submeter"}
DOCUMENT_TYPES = {"application/pdf": b"%PDF", "image/png": b"\x89PNG", "image/jpeg": b"\xff\xd8\xff"}
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024


class DomainError(Exception):
    status_code = 400

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class NotFound(DomainError):
    status_code = 404


class Forbidden(DomainError):
    status_code = 403


class Conflict(DomainError):
    status_code = 409


class PaymentRequired(DomainError):
    """Feature requires an active Rentals subscription on this property."""

    status_code = 402


class Invalid(DomainError):
    status_code = 422


def _parse_date(value: object, field_name: str) -> date:
    if not isinstance(value, str):
        raise Invalid(f"{field_name} must be a YYYY-MM-DD date.")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise Invalid(f"{field_name} must be a YYYY-MM-DD date.") from error


def _optional_date(value: object, field_name: str) -> date | None:
    return None if value in (None, "") else _parse_date(value, field_name)


def _new_id() -> str:
    return secrets.token_hex(10)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _clean_text(value: object, field_name: str, *, minimum: int = 1, maximum: int = 200) -> str:
    if not isinstance(value, str):
        raise Invalid(f"{field_name} is required.")
    text = " ".join(value.split())
    if not minimum <= len(text) <= maximum:
        raise Invalid(f"{field_name} must contain {minimum} to {maximum} characters.")
    return text


def _optional_text(value: object, field_name: str, maximum: int = 200) -> str | None:
    if value in (None, ""):
        return None
    return _clean_text(value, field_name, maximum=maximum)


class RentalService:
    def __init__(
        self,
        store: DocumentStore,
        config: RentalsConfig | None = None,
        *,
        blobs: BlobStore | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.blobs = blobs
        self.config = config or RentalsConfig()
        self.clock = clock or (lambda: datetime.now(UTC))

    # ------------------------------------------------------------------ helpers
    def _now(self) -> str:
        return self.clock().isoformat()

    def _today(self) -> date:
        return self.clock().date()

    @staticmethod
    def _col(pid: str, name: str) -> str:
        return f"properties/{pid}/{name}"

    def _membership(self, pid: str, uid: str) -> dict | None:
        membership = self.store.get("memberships", f"{pid}_{uid}")
        return membership if membership and membership.get("status") == "active" else None

    def _require(self, pid: str, user: AuthUser, roles: set[str]) -> dict:
        membership = self._membership(pid, user.uid)
        if membership is None:
            # Non-members get 404 so property identifiers cannot be enumerated.
            raise NotFound("Property not found.")
        if membership["role"] not in roles:
            raise Forbidden("Your role on this property does not allow this action.")
        return membership

    def _audit(self, pid: str, user: AuthUser, action: str, target_type: str, target_id: str, details: dict | None = None) -> None:
        self.store.create(self._col(pid, "auditLogs"), _new_id(), {
            "at": self._now(),
            "actorUid": user.uid,
            "action": action,
            "targetType": target_type,
            "targetId": target_id,
            "details": details or {},
        })

    def _get(self, pid: str, name: str, doc_id: str, label: str) -> dict:
        doc = self.store.get(self._col(pid, name), doc_id) if isinstance(doc_id, str) and doc_id else None
        if doc is None:
            raise NotFound(f"{label} not found.")
        return doc

    # ------------------------------------------------------------ entitlements
    def entitlement(self, pid: str) -> dict:
        subscription = self.store.get("subscriptions", pid) or {"status": "inactive"}
        status = subscription.get("status", "inactive")
        period_end = subscription.get("currentPeriodEnd")
        expired = bool(period_end) and datetime.fromisoformat(period_end) <= self.clock()
        if status in {"active", "trial"} and expired:
            status = "expired"
        active = status in {"active", "trial"}
        return {
            "propertyId": pid,
            "status": status,
            "active": active,
            "currentPeriodEnd": period_end,
            "unitLimit": subscription.get("unitLimit", self.config.unit_limit_per_property),
            "priceCentavos": subscription.get("priceCentavos", self.config.price_centavos_per_property_month),
            "activationRequestedAt": subscription.get("activationRequestedAt"),
            "paymentsEnabled": False,
        }

    def _require_entitlement(self, pid: str) -> dict:
        entitlement = self.entitlement(pid)
        if not entitlement["active"]:
            raise PaymentRequired(
                "This property's SmartWatts Rentals subscription is not active. Existing records stay readable; "
                "request activation on the Subscription page to make changes."
            )
        return entitlement

    # ---------------------------------------------------------------- account
    def workspaces(self, user: AuthUser) -> dict:
        memberships = []
        for membership in self.store.query("memberships", uid=user.uid, status="active"):
            prop = self.store.get("properties", membership["propertyId"])
            if not prop:
                continue
            unit_label = None
            if membership.get("unitId"):
                unit = self.store.get(self._col(prop["id"], "units"), membership["unitId"])
                unit_label = unit.get("label") if unit else None
            memberships.append({
                "propertyId": prop["id"],
                "propertyName": prop["name"],
                "role": membership["role"],
                "unitId": membership.get("unitId"),
                "unitLabel": unit_label,
            })
        memberships.sort(key=lambda item: (item["propertyName"].lower(), item["role"]))
        return {
            # Every account always has the free personal workspace (Tier 1).
            # Tiers are not global: Rentals entitlements belong to each property.
            "personal": {"tier": 1, "plan": "personal", "name": "SmartWatts Personal", "priceCentavos": 0},
            "rentalMemberships": memberships,
            "canCreateProperty": not user.is_anonymous,
        }

    # ------------------------------------------------------------- properties
    def create_property(self, user: AuthUser, payload: dict) -> dict:
        name = _clean_text(payload.get("name"), "Property name", maximum=120)
        address = _clean_text(payload.get("address"), "Property address", maximum=240)
        pid = _new_id()
        now = self._now()
        self.store.create("properties", pid, {"name": name, "address": address, "ownerUid": user.uid, "createdAt": now})
        self.store.create("memberships", f"{pid}_{user.uid}", {
            "propertyId": pid, "uid": user.uid, "role": OWNER, "status": "active",
            "email": user.email, "createdAt": now,
        })
        subscription = {
            "propertyId": pid,
            "plan": "rentals",
            "status": "inactive",
            "unitLimit": self.config.unit_limit_per_property,
            "priceCentavos": self.config.price_centavos_per_property_month,
            "currency": self.config.currency,
            "paymentProvider": None,
            "createdAt": now,
        }
        if self.config.trial_days:
            subscription["status"] = "trial"
            subscription["currentPeriodEnd"] = (self.clock() + timedelta(days=self.config.trial_days)).isoformat()
        self.store.create("subscriptions", pid, subscription)
        self._audit(pid, user, "property.create", "property", pid, {"name": name})
        return self.get_property(user, pid)

    def get_property(self, user: AuthUser, pid: str) -> dict:
        membership = self._require(pid, user, {OWNER, ADMIN, TENANT})
        prop = self.store.get("properties", pid)
        if prop is None:
            raise NotFound("Property not found.")
        result = {"id": pid, "name": prop["name"], "role": membership["role"]}
        if membership["role"] in MANAGERS:
            result.update({"address": prop["address"], "entitlement": self.entitlement(pid)})
        return result

    def analytics(self, user: AuthUser, pid: str) -> dict:
        self._require(pid, user, MANAGERS)
        units = self.store.query(self._col(pid, "units"), status="active")
        occupancies = [o for o in self.store.query(self._col(pid, "occupancies")) if not o.get("endDate")]
        bills = [b for b in self.store.query(self._col(pid, "utilityBills")) if b.get("status") == "active"]
        bills.sort(key=lambda b: b["periodStart"])
        statements = self.store.query(self._col(pid, "statements"), status="finalized")
        per_unit: dict[str, dict] = {}
        for statement in statements:
            entry = per_unit.setdefault(statement["unitId"], {"unitId": statement["unitId"], "billedCentavos": 0, "measuredWh": 0})
            entry["billedCentavos"] += statement["totalCentavos"]
            entry["measuredWh"] += sum(
                line["wh"] or 0 for line in statement["lines"] if line["consumptionKind"] != "not_individually_measured"
            )
        labels = {u["id"]: u["label"] for u in self.store.query(self._col(pid, "units"))}
        return {
            "unitCount": len(units),
            "occupiedUnitCount": len({o["unitId"] for o in occupancies}),
            "meterCount": len(self.store.query(self._col(pid, "meters"))),
            "bills": [
                {"id": b["id"], "periodStart": b["periodStart"], "periodEnd": b["periodEnd"],
                 "totalWh": b["totalWh"], "amountCentavos": b["amountCentavos"], "meterId": b["meterId"]}
                for b in bills[-12:]
            ],
            "finalizedByUnit": [{**entry, "unitLabel": labels.get(uid, uid)} for uid, entry in sorted(per_unit.items())],
        }

    # ------------------------------------------------------------------ units
    def create_unit(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        entitlement = self._require_entitlement(pid)
        label = _clean_text(payload.get("label"), "Unit label", maximum=60)
        active = self.store.query(self._col(pid, "units"), status="active")
        if len(active) >= entitlement["unitLimit"]:
            raise PaymentRequired(f"This property's plan supports up to {entitlement['unitLimit']} units.")
        if any(unit["label"].lower() == label.lower() for unit in active):
            raise Conflict("A unit with this label already exists.")
        unit_id = _new_id()
        doc = {"label": label, "notes": _optional_text(payload.get("notes"), "Notes", 500), "status": "active", "createdAt": self._now()}
        self.store.create(self._col(pid, "units"), unit_id, doc)
        self._audit(pid, user, "unit.create", "unit", unit_id, {"label": label})
        return {**doc, "id": unit_id}

    def list_units(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, MANAGERS)
        units = self.store.query(self._col(pid, "units"))
        occupancies = [o for o in self.store.query(self._col(pid, "occupancies")) if not o.get("endDate")]
        for unit in units:
            current = next((o for o in occupancies if o["unitId"] == unit["id"]), None)
            unit["currentOccupancy"] = current
        return sorted(units, key=lambda u: u["label"].lower())

    # ----------------------------------------------------------------- meters
    def create_meter(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        kind = payload.get("kind")
        if kind not in METER_KINDS:
            raise Invalid("Meter type must be utility_individual, utility_shared, or private_submeter.")
        parent_id = payload.get("parentMeterId") or None
        if kind == "private_submeter":
            parent = self._get(pid, "meters", parent_id, "Parent meter") if parent_id else None
            if parent is None or parent["kind"] != "utility_shared":
                raise Invalid("A private submeter must belong to a shared utility meter on this property.")
        elif parent_id:
            raise Invalid("Only private submeters can have a parent meter.")
        meter_id = _new_id()
        doc = {
            "label": _clean_text(payload.get("label"), "Meter label", maximum=60),
            "kind": kind,
            "parentMeterId": parent_id,
            "serialNumber": _optional_text(payload.get("serialNumber"), "Serial number", 60),
            "utilityAccountNumber": _optional_text(payload.get("utilityAccountNumber"), "Utility account number", 60),
            "createdAt": self._now(),
        }
        self.store.create(self._col(pid, "meters"), meter_id, doc)
        self._audit(pid, user, "meter.create", "meter", meter_id, {"kind": kind, "label": doc["label"]})
        return {**doc, "id": meter_id}

    def list_meters(self, user: AuthUser, pid: str) -> dict:
        self._require(pid, user, MANAGERS)
        return {
            "meters": sorted(self.store.query(self._col(pid, "meters")), key=lambda m: m["label"].lower()),
            "assignments": sorted(self.store.query(self._col(pid, "meterAssignments")), key=lambda a: a["effectiveFrom"]),
            "agreements": self.store.query(self._col(pid, "allocationAgreements")),
        }

    def create_assignment(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        meter = self._get(pid, "meters", payload.get("meterId"), "Meter")
        unit = self._get(pid, "units", payload.get("unitId"), "Unit")
        if meter["kind"] == "utility_shared":
            raise Invalid("Shared meters are not assigned to one unit. Use an allocation agreement or private submeters.")
        start = _parse_date(payload.get("effectiveFrom"), "Effective from")
        end = _optional_date(payload.get("effectiveTo"), "Effective to")
        if end and end < start:
            raise Invalid("Effective to must be on or after effective from.")
        for existing in self.store.query(self._col(pid, "meterAssignments"), meterId=meter["id"]):
            if self._assignment(existing).overlaps(start, end or date.max):
                raise Conflict("This meter is already assigned to a unit during those dates.")
        for existing in self.store.query(self._col(pid, "meterAssignments"), unitId=unit["id"]):
            other_meter = self.store.get(self._col(pid, "meters"), existing["meterId"])
            if other_meter and other_meter["kind"] == meter["kind"] and self._assignment(existing).overlaps(start, end or date.max):
                raise Conflict("This unit already has a meter of this type during those dates.")
        assignment_id = _new_id()
        doc = {
            "meterId": meter["id"], "unitId": unit["id"], "effectiveFrom": start.isoformat(),
            "effectiveTo": end.isoformat() if end else None, "createdAt": self._now(), "createdBy": user.uid,
        }
        self.store.create(self._col(pid, "meterAssignments"), assignment_id, doc)
        self._audit(pid, user, "meterAssignment.create", "meterAssignment", assignment_id, doc)
        return {**doc, "id": assignment_id}

    def end_assignment(self, user: AuthUser, pid: str, assignment_id: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        assignment = self._get(pid, "meterAssignments", assignment_id, "Assignment")
        end = _parse_date(payload.get("effectiveTo"), "Effective to")
        if end < date.fromisoformat(assignment["effectiveFrom"]):
            raise Invalid("Effective to must be on or after effective from.")
        if assignment.get("effectiveTo"):
            raise Conflict("This assignment has already ended.")
        self.store.update(self._col(pid, "meterAssignments"), assignment_id, {"effectiveTo": end.isoformat()})
        self._audit(pid, user, "meterAssignment.end", "meterAssignment", assignment_id, {"effectiveTo": end.isoformat()})
        return {**assignment, "effectiveTo": end.isoformat()}

    @staticmethod
    def _assignment(doc: dict) -> billing.Assignment:
        return billing.Assignment(
            doc["id"], doc["meterId"], doc["unitId"], date.fromisoformat(doc["effectiveFrom"]),
            date.fromisoformat(doc["effectiveTo"]) if doc.get("effectiveTo") else None,
        )

    def create_agreement(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        meter = self._get(pid, "meters", payload.get("meterId"), "Meter")
        if meter["kind"] != "utility_shared":
            raise Invalid("Allocation agreements apply only to shared utility meters.")
        if payload.get("acknowledgeLegalReview") is not True:
            raise Invalid("Confirm that this allocation is lawful, written in the lease, and agreed with tenants.")
        description = _clean_text(payload.get("description"), "Agreement description", minimum=20, maximum=600)
        shares_in = payload.get("shares")
        if not isinstance(shares_in, list) or not shares_in:
            raise Invalid("Enter an explicit share for each unit covered by the agreement.")
        shares = []
        for share in shares_in:
            if not isinstance(share, dict):
                raise Invalid("Each share needs a unit and a positive whole-number weight.")
            unit = self._get(pid, "units", share.get("unitId"), "Unit")
            weight = share.get("weight")
            if isinstance(weight, bool) or not isinstance(weight, int) or not 1 <= weight <= 10000:
                raise Invalid("Each share weight must be a whole number from 1 to 10,000.")
            shares.append({"unitId": unit["id"], "weight": weight})
        if len({s["unitId"] for s in shares}) != len(shares):
            raise Invalid("Each unit may appear only once in an allocation.")
        start = _parse_date(payload.get("effectiveFrom"), "Effective from")
        end = _optional_date(payload.get("effectiveTo"), "Effective to")
        if end and end < start:
            raise Invalid("Effective to must be on or after effective from.")
        for existing in self.store.query(self._col(pid, "allocationAgreements"), meterId=meter["id"]):
            other = self._agreement(existing)
            if other.effective_from <= (end or date.max) and (other.effective_to or date.max) >= start:
                raise Conflict("Another allocation agreement already covers this meter during those dates.")
        agreement_id = _new_id()
        doc = {
            "meterId": meter["id"], "description": description, "shares": shares,
            "effectiveFrom": start.isoformat(), "effectiveTo": end.isoformat() if end else None,
            "legalReviewAcknowledgedBy": user.uid, "createdAt": self._now(),
        }
        self.store.create(self._col(pid, "allocationAgreements"), agreement_id, doc)
        self._audit(pid, user, "allocationAgreement.create", "allocationAgreement", agreement_id, {"meterId": meter["id"]})
        return {**doc, "id": agreement_id}

    @staticmethod
    def _agreement(doc: dict) -> billing.Agreement:
        return billing.Agreement(
            doc["id"], doc["meterId"], doc["description"],
            tuple((s["unitId"], s["weight"]) for s in doc["shares"]),
            date.fromisoformat(doc["effectiveFrom"]),
            date.fromisoformat(doc["effectiveTo"]) if doc.get("effectiveTo") else None,
        )

    # --------------------------------------------------------------- readings
    def _active_readings(self, pid: str, meter_id: str) -> list[dict]:
        return [r for r in self.store.query(self._col(pid, "meterReadings"), meterId=meter_id) if r["status"] == "active"]

    def _validate_reading(self, pid: str, meter_id: str, reading_date: date, wh: int, ignore_id: str | None = None) -> None:
        if reading_date > self._today():
            raise Invalid("Reading date cannot be in the future.")
        for other in self._active_readings(pid, meter_id):
            if other["id"] == ignore_id:
                continue
            other_date = date.fromisoformat(other["readingDate"])
            if other_date == reading_date:
                raise Conflict("A reading already exists for this date. Submit a correction instead.")
            if other_date < reading_date and other["valueWh"] > wh:
                raise Invalid(f"Reading is lower than the earlier reading on {other['readingDate']}. Meter values cannot go backwards.")
            if other_date > reading_date and other["valueWh"] < wh:
                raise Invalid(f"Reading is higher than the later reading on {other['readingDate']}. Check the date and value.")

    def record_reading(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        meter = self._get(pid, "meters", payload.get("meterId"), "Meter")
        if payload.get("confirmed") is not True:
            raise Invalid("Confirm that you checked the reading against the physical meter.")
        source = payload.get("source", "manual")
        if source not in {"manual", "photo_ocr"}:
            raise Invalid("Reading source must be manual or photo_ocr.")
        reading_date = _parse_date(payload.get("readingDate"), "Reading date")
        try:
            wh = parse_kwh_to_wh(payload.get("valueKwh"), field_name="Meter reading")
            suggested = payload.get("ocrSuggestedKwh")
            suggested_wh = parse_kwh_to_wh(suggested, field_name="OCR value") if suggested not in (None, "") else None
        except BillingError as error:
            raise Invalid(str(error)) from error
        self._validate_reading(pid, meter["id"], reading_date, wh)
        reading_id = _new_id()
        doc = {
            "meterId": meter["id"], "readingDate": reading_date.isoformat(), "valueWh": wh,
            "source": source, "ocrSuggestedWh": suggested_wh if source == "photo_ocr" else None,
            "verified": True, "verifiedBy": user.uid, "verifiedAt": self._now(),
            "status": "active", "supersedesId": None, "supersededById": None, "correctionReason": None,
            "createdAt": self._now(),
        }
        self.store.create(self._col(pid, "meterReadings"), reading_id, doc)
        self._audit(pid, user, "reading.create", "meterReading", reading_id, {"meterId": meter["id"], "valueWh": wh, "source": source})
        return {**doc, "id": reading_id}

    def correct_reading(self, user: AuthUser, pid: str, reading_id: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        original = self._get(pid, "meterReadings", reading_id, "Reading")
        if original["status"] != "active":
            raise Conflict("Only the current version of a reading can be corrected.")
        reason = _clean_text(payload.get("reason"), "Correction reason", minimum=5, maximum=300)
        reading_date = _parse_date(payload.get("readingDate") or original["readingDate"], "Reading date")
        try:
            wh = parse_kwh_to_wh(payload.get("valueKwh"), field_name="Meter reading")
        except BillingError as error:
            raise Invalid(str(error)) from error
        self._validate_reading(pid, original["meterId"], reading_date, wh, ignore_id=reading_id)
        new_id = _new_id()
        if not self.store.compare_and_update(
            self._col(pid, "meterReadings"), reading_id, {"status": "active"}, {"status": "superseded", "supersededById": new_id},
        ):
            raise Conflict("This reading was changed by someone else. Reload and try again.")
        doc = {
            **{k: v for k, v in original.items() if k != "id"},
            "readingDate": reading_date.isoformat(), "valueWh": wh, "source": "manual", "ocrSuggestedWh": None,
            "verifiedBy": user.uid, "verifiedAt": self._now(), "status": "active",
            "supersedesId": reading_id, "supersededById": None, "correctionReason": reason, "createdAt": self._now(),
        }
        self.store.create(self._col(pid, "meterReadings"), new_id, doc)
        affected = [
            s["id"] for s in self.store.query(self._col(pid, "statements"))
            if reading_id in s.get("sourceReadingIds", []) and s["status"] in {"draft", "finalized"}
        ]
        for statement_id in affected:
            # Finalized statements stay immutable; only drafts are blocked until regenerated.
            self.store.compare_and_update(
                self._col(pid, "statements"), statement_id, {"status": "draft"},
                {"needsReview": True, "reviewReason": "A source reading was corrected. Regenerate statements for this bill."},
            )
        self._audit(pid, user, "reading.correct", "meterReading", new_id, {
            "supersedesId": reading_id, "previousWh": original["valueWh"], "valueWh": wh, "reason": reason,
            "affectedStatementIds": affected,
        })
        return {**doc, "id": new_id, "affectedStatementIds": affected}

    def list_readings(self, user: AuthUser, pid: str, meter_id: str | None = None) -> list[dict]:
        self._require(pid, user, MANAGERS)
        filters = {"meterId": meter_id} if meter_id else {}
        readings = self.store.query(self._col(pid, "meterReadings"), **filters)
        return sorted(readings, key=lambda r: (r["meterId"], r["readingDate"], r["createdAt"]), reverse=True)

    # ------------------------------------------------------------ utility bills
    def create_bill(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        meter = self._get(pid, "meters", payload.get("meterId"), "Meter")
        if meter["kind"] not in {"utility_individual", "utility_shared"}:
            raise Invalid("Official utility bills must be recorded against a utility meter, not a private submeter.")
        start = _parse_date(payload.get("periodStart"), "Period start")
        end = _parse_date(payload.get("periodEnd"), "Period end")
        if end <= start:
            raise Invalid("The bill period end must be after its start.")
        if (end - start).days > self.config.max_bill_period_days:
            raise Invalid(f"A bill period cannot exceed {self.config.max_bill_period_days} days.")
        if end > self._today():
            raise Invalid("The bill period cannot end in the future.")
        try:
            total_wh = parse_kwh_to_wh(payload.get("totalKwh"), field_name="Bill kWh")
        except BillingError as error:
            raise Invalid(str(error)) from error
        amount = payload.get("amountCentavos")
        if isinstance(amount, bool) or not isinstance(amount, int) or not 0 < amount <= 10**11:
            raise Invalid("Bill amount must be a positive whole number of centavos.")
        if total_wh <= 0:
            raise Invalid("Bill kWh must be greater than zero.")
        for other in self.store.query(self._col(pid, "utilityBills"), meterId=meter["id"], status="active"):
            if date.fromisoformat(other["periodStart"]) < end and date.fromisoformat(other["periodEnd"]) > start:
                raise Conflict("Another bill for this meter overlaps this period.")
        bill_id = _new_id()
        doc = {
            "meterId": meter["id"], "periodStart": start.isoformat(), "periodEnd": end.isoformat(),
            "totalWh": total_wh, "amountCentavos": amount,
            "billNumber": _optional_text(payload.get("billNumber"), "Bill number", 60),
            "dueDate": _optional_date(payload.get("dueDate"), "Due date").isoformat() if payload.get("dueDate") else None,
            "documentPath": None, "documentContentType": None,
            "source": "photo_ocr_verified" if payload.get("source") == "photo_ocr" else "manual",
            "status": "active", "uploadedBy": user.uid, "createdAt": self._now(),
        }
        self.store.create(self._col(pid, "utilityBills"), bill_id, doc)
        self._audit(pid, user, "utilityBill.create", "utilityBill", bill_id, {"meterId": meter["id"], "amountCentavos": amount, "totalWh": total_wh})
        return {**doc, "id": bill_id}

    def attach_bill_document(self, user: AuthUser, pid: str, bill_id: str, content: bytes, content_type: str) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        bill = self._get(pid, "utilityBills", bill_id, "Bill")
        if self.blobs is None:
            raise DomainError("Bill document storage is not configured on the server. The bill figures are saved.")
        signature = DOCUMENT_TYPES.get(content_type)
        if signature is None or not content.startswith(signature):
            raise Invalid("Upload a PDF, PNG, or JPEG bill document.")
        if len(content) > MAX_DOCUMENT_BYTES:
            raise Invalid("Bill documents must be 10 MB or smaller.")
        path = f"properties/{pid}/utilityBills/{bill_id}/{_new_id()}"
        self.blobs.put(path, content, content_type)
        self.store.update(self._col(pid, "utilityBills"), bill_id, {"documentPath": path, "documentContentType": content_type})
        self._audit(pid, user, "utilityBill.attachDocument", "utilityBill", bill_id, {"bytes": len(content)})
        return {**bill, "documentPath": path, "documentContentType": content_type}

    def get_bill_document(self, user: AuthUser, pid: str, bill_id: str) -> tuple[bytes, str]:
        self._require(pid, user, MANAGERS)
        bill = self._get(pid, "utilityBills", bill_id, "Bill")
        if not bill.get("documentPath") or self.blobs is None:
            raise NotFound("No document is attached to this bill.")
        blob = self.blobs.get(bill["documentPath"])
        if blob is None:
            raise NotFound("No document is attached to this bill.")
        return blob

    def list_bills(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, MANAGERS)
        return sorted(self.store.query(self._col(pid, "utilityBills")), key=lambda b: b["periodStart"], reverse=True)

    # ------------------------------------------------------------- statements
    def _occupancies(self, pid: str) -> list[billing.Occupancy]:
        return [
            billing.Occupancy(
                o["id"], o["unitId"], o["tenantUid"], date.fromisoformat(o["startDate"]),
                date.fromisoformat(o["endDate"]) if o.get("endDate") else None,
            )
            for o in self.store.query(self._col(pid, "occupancies"))
        ]

    def generate_statements(self, user: AuthUser, pid: str, bill_id: str) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        bill_doc = self._get(pid, "utilityBills", bill_id, "Bill")
        if bill_doc["status"] != "active":
            raise Conflict("Statements can only be generated from the current version of a bill.")
        meter_doc = self._get(pid, "meters", bill_doc["meterId"], "Meter")
        bill = billing.Bill(
            bill_doc["id"], bill_doc["meterId"], date.fromisoformat(bill_doc["periodStart"]),
            date.fromisoformat(bill_doc["periodEnd"]), bill_doc["totalWh"], bill_doc["amountCentavos"],
        )
        meters = self.store.query(self._col(pid, "meters"))
        submeter_docs = [m for m in meters if m["kind"] == "private_submeter" and m.get("parentMeterId") == meter_doc["id"]]
        readings = [
            billing.Reading(r["id"], r["meterId"], date.fromisoformat(r["readingDate"]), r["valueWh"])
            for m in submeter_docs for r in self._active_readings(pid, m["id"]) if r.get("verified")
        ]
        agreements = [
            self._agreement(a) for a in self.store.query(self._col(pid, "allocationAgreements"), meterId=meter_doc["id"])
        ]
        agreement = next((a for a in agreements if a.covers(bill.period_start, bill.period_end)), None)
        if agreement is None and any(
            a.effective_from <= bill.period_end and (a.effective_to or date.max) >= bill.period_start for a in agreements
        ):
            raise BillingError("An allocation agreement only partly covers this bill period. Split the bill or adjust the agreement.")
        result = billing.calculate_bill(
            bill=bill,
            meter=billing.Meter(meter_doc["id"], meter_doc["kind"], meter_doc["label"]),
            submeters=[billing.Meter(m["id"], m["kind"], m["label"], m["parentMeterId"]) for m in submeter_docs],
            assignments=[self._assignment(a) for a in self.store.query(self._col(pid, "meterAssignments"))],
            readings=readings,
            occupancies=self._occupancies(pid),
            agreement=agreement,
            tolerance_days=self.config.reading_tolerance_days,
        )
        reconciliation = result.reconciliation(bill)
        if not reconciliation["balanced"]:  # pragma: no cover - invariant guard
            raise BillingError("Statement reconciliation failed; no statements were created.")

        existing = [s for s in self.store.query(self._col(pid, "statements"), utilityBillId=bill_id) if s["status"] in {"draft", "finalized"}]
        version = 1 + max((s["version"] for s in self.store.query(self._col(pid, "statements"), utilityBillId=bill_id)), default=0)
        run_id = f"{bill_id}-v{version}"
        for draft in (s for s in existing if s["status"] == "draft"):
            self.store.compare_and_update(self._col(pid, "statements"), draft["id"], {"status": "draft"}, {"status": "superseded", "supersededByRunId": run_id})

        groups: dict[tuple[str, str | None], list[billing.Line]] = {}
        for line in result.lines:
            groups.setdefault((line.unit_id, line.occupancy_id), []).append(line)
        statement_ids = []
        now = self._now()
        for (unit_id, occupancy_id), lines in sorted(groups.items(), key=lambda item: (item[0][0], item[0][1] or "")):
            previous = next(
                (s for s in existing if s["status"] == "finalized" and s["unitId"] == unit_id and s.get("occupancyId") == occupancy_id),
                None,
            )
            review_reasons = sorted({line.review_reason for line in lines if line.review_reason})
            statement_id = _new_id()
            self.store.create(self._col(pid, "statements"), statement_id, {
                "utilityBillId": bill_id, "billingRunId": run_id, "version": version,
                "unitId": unit_id, "occupancyId": occupancy_id,
                "tenantUid": None if review_reasons else lines[0].tenant_uid,
                "periodStart": bill_doc["periodStart"], "periodEnd": bill_doc["periodEnd"],
                "lines": [self._line_doc(line) for line in lines],
                "totalCentavos": sum(line.amount_centavos for line in lines),
                "sourceReadingIds": sorted({rid for line in lines for rid in line.source_reading_ids}),
                "status": "draft", "needsReview": bool(review_reasons), "reviewReason": " ".join(review_reasons) or None,
                "supersedesId": previous["id"] if previous else None,
                "legalReviewNotice": billing.LEGAL_REVIEW_NOTICE,
                "generatedAt": now, "generatedBy": user.uid, "finalizedAt": None, "finalizedBy": None,
            })
            statement_ids.append(statement_id)
        run = {
            "utilityBillId": bill_id, "version": version, "createdAt": now, "createdBy": user.uid,
            "statementIds": statement_ids, "reconciliation": reconciliation,
            "ownerBorne": [
                {"reason": item.reason, "amountCentavos": item.amount_centavos, "unitId": item.unit_id, "wh": item.wh}
                for item in result.owner_borne
            ],
        }
        self.store.create(self._col(pid, "billingRuns"), run_id, run)
        self._audit(pid, user, "statements.generate", "utilityBill", bill_id, {"runId": run_id, "statementCount": len(statement_ids)})
        return {**run, "id": run_id}

    @staticmethod
    def _line_doc(line: billing.Line) -> dict:
        return {
            "unitId": line.unit_id, "chargeBasis": line.charge_basis, "consumptionKind": line.consumption_kind,
            "description": line.description, "wh": line.wh, "amountCentavos": line.amount_centavos,
            "calculation": line.calculation, "needsReview": line.needs_review, "reviewReason": line.review_reason,
        }

    def get_reconciliation(self, user: AuthUser, pid: str, bill_id: str) -> dict:
        self._require(pid, user, MANAGERS)
        runs = self.store.query(self._col(pid, "billingRuns"), utilityBillId=bill_id)
        if not runs:
            raise NotFound("No statements have been generated for this bill yet.")
        return max(runs, key=lambda run: run["version"])

    def list_statements(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, MANAGERS)
        return sorted(
            self.store.query(self._col(pid, "statements")),
            key=lambda s: (s["periodStart"], s["unitId"], s["version"]), reverse=True,
        )

    def finalize_statement(self, user: AuthUser, pid: str, statement_id: str) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        statement = self._get(pid, "statements", statement_id, "Statement")
        if statement["status"] != "draft":
            raise Conflict("Only draft statements can be finalized.")
        if statement["needsReview"] or not statement.get("tenantUid"):
            raise Conflict("Resolve the review notes before finalizing this statement.")
        now = self._now()
        if not self.store.compare_and_update(
            self._col(pid, "statements"), statement_id, {"status": "draft", "needsReview": False},
            {"status": "finalized", "finalizedAt": now, "finalizedBy": user.uid},
        ):
            raise Conflict("This statement changed. Reload and try again.")
        if statement.get("supersedesId"):
            self.store.compare_and_update(
                self._col(pid, "statements"), statement["supersedesId"], {"status": "finalized"},
                {"status": "superseded", "supersededById": statement_id},
            )
        self._audit(pid, user, "statement.finalize", "statement", statement_id, {"totalCentavos": statement["totalCentavos"]})
        return {**statement, "status": "finalized", "finalizedAt": now, "finalizedBy": user.uid}

    def void_statement(self, user: AuthUser, pid: str, statement_id: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        statement = self._get(pid, "statements", statement_id, "Statement")
        reason = _clean_text(payload.get("reason"), "Void reason", minimum=5, maximum=300)
        if statement["status"] not in {"draft", "finalized"}:
            raise Conflict("This statement is already superseded or void.")
        if not self.store.compare_and_update(
            self._col(pid, "statements"), statement_id, {"status": statement["status"]},
            {"status": "void", "voidReason": reason, "voidedAt": self._now(), "voidedBy": user.uid},
        ):
            raise Conflict("This statement changed. Reload and try again.")
        self._audit(pid, user, "statement.void", "statement", statement_id, {"reason": reason, "previousStatus": statement["status"]})
        return {**statement, "status": "void", "voidReason": reason}

    # ------------------------------------------------------------ invitations
    def create_invitation(self, user: AuthUser, pid: str, payload: dict) -> dict:
        membership = self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        role = payload.get("role", TENANT)
        if role not in {TENANT, ADMIN}:
            raise Invalid("Invitations are for tenants or property administrators.")
        if role == ADMIN and membership["role"] != OWNER:
            raise Forbidden("Only the property owner can invite administrators.")
        unit_id = None
        move_in = None
        if role == TENANT:
            unit_id = self._get(pid, "units", payload.get("unitId"), "Unit")["id"]
            move_in = _parse_date(payload.get("moveInDate") or self._today().isoformat(), "Move-in date")
        email = payload.get("email")
        if email not in (None, ""):
            if not isinstance(email, str) or "@" not in email or len(email) > 254:
                raise Invalid("Enter a valid email address or leave it blank.")
            email = email.strip().lower()
        else:
            email = None
        token = secrets.token_urlsafe(32)
        invitation_id = _hash_token(token)
        expires = self.clock() + timedelta(hours=self.config.invitation_ttl_hours)
        self.store.create("invitations", invitation_id, {
            "propertyId": pid, "role": role, "unitId": unit_id,
            "moveInDate": move_in.isoformat() if move_in else None, "email": email,
            "status": "pending", "createdBy": user.uid, "createdAt": self._now(), "expiresAt": expires.isoformat(),
        })
        self._audit(pid, user, "invitation.create", "invitation", invitation_id[:12], {"role": role, "unitId": unit_id})
        # The raw token is returned once and never stored; only its SHA-256 hash is persisted.
        return {"id": invitation_id[:12], "token": token, "expiresAt": expires.isoformat(), "role": role, "unitId": unit_id}

    def list_invitations(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, MANAGERS)
        now = self.clock()
        items = []
        for invitation in self.store.query("invitations", propertyId=pid):
            status = invitation["status"]
            if status == "pending" and datetime.fromisoformat(invitation["expiresAt"]) <= now:
                status = "expired"
            items.append({
                "id": invitation["id"][:12], "role": invitation["role"], "unitId": invitation["unitId"],
                "email": invitation["email"], "status": status, "expiresAt": invitation["expiresAt"],
                "createdAt": invitation["createdAt"], "moveInDate": invitation.get("moveInDate"),
            })
        return sorted(items, key=lambda i: i["createdAt"], reverse=True)

    def revoke_invitation(self, user: AuthUser, pid: str, short_id: str) -> dict:
        self._require(pid, user, MANAGERS)
        match = next((i for i in self.store.query("invitations", propertyId=pid) if i["id"][:12] == short_id), None)
        if match is None:
            raise NotFound("Invitation not found.")
        if not self.store.compare_and_update("invitations", match["id"], {"status": "pending"}, {"status": "revoked", "revokedBy": user.uid, "revokedAt": self._now()}):
            raise Conflict("Only pending invitations can be revoked.")
        self._audit(pid, user, "invitation.revoke", "invitation", short_id)
        return {"id": short_id, "status": "revoked"}

    def _pending_invitation(self, token: object) -> dict:
        if not isinstance(token, str) or not 20 <= len(token) <= 200:
            raise NotFound("This invitation is invalid or has expired.")
        invitation = self.store.get("invitations", _hash_token(token))
        if (
            invitation is None or invitation["status"] != "pending"
            or datetime.fromisoformat(invitation["expiresAt"]) <= self.clock()
        ):
            raise NotFound("This invitation is invalid or has expired.")
        return invitation

    def preview_invitation(self, user: AuthUser, token: object) -> dict:
        invitation = self._pending_invitation(token)
        prop = self.store.get("properties", invitation["propertyId"]) or {}
        unit = self.store.get(self._col(invitation["propertyId"], "units"), invitation["unitId"]) if invitation["unitId"] else None
        return {
            "propertyName": prop.get("name"), "role": invitation["role"], "unitLabel": unit["label"] if unit else None,
            "moveInDate": invitation.get("moveInDate"), "expiresAt": invitation["expiresAt"],
            "emailRestricted": bool(invitation["email"]),
        }

    def redeem_invitation(self, user: AuthUser, token: object) -> dict:
        if user.is_anonymous:
            raise Forbidden("Create a permanent account before accepting a rental invitation.")
        invitation = self._pending_invitation(token)
        pid = invitation["propertyId"]
        if invitation["email"] and (not user.email_verified or (user.email or "").lower() != invitation["email"]):
            raise Forbidden("This invitation is for a different, verified email address.")
        existing = self.store.get("memberships", f"{pid}_{user.uid}")
        if existing and existing["status"] == "active":
            raise Conflict("You are already a member of this property.")
        move_in = date.fromisoformat(invitation["moveInDate"]) if invitation.get("moveInDate") else None
        if invitation["role"] == TENANT:
            for occupancy in self._occupancies(pid):
                if occupancy.unit_id == invitation["unitId"] and occupancy.overlaps(move_in, date.max):
                    raise Conflict("This unit is still occupied on the move-in date. Ask the owner to record the move-out first.")
        if not self.store.compare_and_update(
            "invitations", invitation["id"], {"status": "pending"},
            {"status": "accepted", "acceptedBy": user.uid, "acceptedAt": self._now()},
        ):
            raise NotFound("This invitation is invalid or has expired.")
        membership = {
            "propertyId": pid, "uid": user.uid, "role": invitation["role"], "status": "active",
            "unitId": invitation["unitId"], "email": user.email, "createdAt": self._now(),
        }
        if existing:
            self.store.update("memberships", f"{pid}_{user.uid}", {**membership, "revokedAt": None})
        else:
            self.store.create("memberships", f"{pid}_{user.uid}", membership)
        if invitation["role"] == TENANT:
            occupancy_id = _new_id()
            self.store.create(self._col(pid, "occupancies"), occupancy_id, {
                "unitId": invitation["unitId"], "tenantUid": user.uid, "tenantEmail": user.email,
                "startDate": move_in.isoformat(), "endDate": None, "createdAt": self._now(),
            })
        self._audit(pid, user, "invitation.accept", "membership", user.uid, {"role": invitation["role"], "unitId": invitation["unitId"]})
        return {"propertyId": pid, "role": invitation["role"], "unitId": invitation["unitId"]}

    # ------------------------------------------------- members and occupancy
    def list_members(self, user: AuthUser, pid: str) -> dict:
        self._require(pid, user, MANAGERS)
        return {
            "members": sorted(self.store.query("memberships", propertyId=pid), key=lambda m: (m["status"], m["role"], m.get("email") or "")),
            "occupancies": sorted(self.store.query(self._col(pid, "occupancies")), key=lambda o: o["startDate"], reverse=True),
        }

    def end_occupancy(self, user: AuthUser, pid: str, occupancy_id: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        occupancy = self._get(pid, "occupancies", occupancy_id, "Occupancy")
        if occupancy.get("endDate"):
            raise Conflict("This move-out was already recorded.")
        end = _parse_date(payload.get("endDate"), "Move-out date")
        if end < date.fromisoformat(occupancy["startDate"]):
            raise Invalid("Move-out date cannot be before the move-in date.")
        self.store.update(self._col(pid, "occupancies"), occupancy_id, {"endDate": end.isoformat(), "endedBy": user.uid})
        still_occupying = any(
            o["id"] != occupancy_id and not o.get("endDate")
            for o in self.store.query(self._col(pid, "occupancies"), tenantUid=occupancy["tenantUid"])
        )
        if not still_occupying:
            self._deactivate_member(pid, occupancy["tenantUid"])
        self._audit(pid, user, "occupancy.end", "occupancy", occupancy_id, {"endDate": end.isoformat()})
        return {**occupancy, "endDate": end.isoformat()}

    def _deactivate_member(self, pid: str, uid: str) -> None:
        self.store.compare_and_update(
            "memberships", f"{pid}_{uid}", {"status": "active"}, {"status": "revoked", "revokedAt": self._now()},
        )

    def revoke_member(self, user: AuthUser, pid: str, uid: str) -> dict:
        actor = self._require(pid, user, MANAGERS)
        target = self._membership(pid, uid)
        if target is None:
            raise NotFound("Member not found.")
        if target["role"] == OWNER:
            raise Forbidden("The property owner cannot be removed.")
        if target["role"] == ADMIN and actor["role"] != OWNER:
            raise Forbidden("Only the owner can remove administrators.")
        today = self._today().isoformat()
        for occupancy in self.store.query(self._col(pid, "occupancies"), tenantUid=uid):
            if not occupancy.get("endDate"):
                end = max(today, occupancy["startDate"])
                self.store.update(self._col(pid, "occupancies"), occupancy["id"], {"endDate": end, "endedBy": user.uid})
        self._deactivate_member(pid, uid)
        self._audit(pid, user, "membership.revoke", "membership", uid, {"role": target["role"]})
        return {"uid": uid, "status": "revoked"}

    # ------------------------------------------------------------------ tenant
    def my_statements(self, user: AuthUser, pid: str) -> list[dict]:
        """Finalized statements addressed to this tenant.

        Former tenants keep read access to their own finalized statements after
        move-out, but lose access to every other property record.
        """
        statements = self.store.query(self._col(pid, "statements"), tenantUid=user.uid)
        visible = [s for s in statements if s["status"] in {"finalized", "superseded", "void"} and s.get("finalizedAt")]
        if not visible and self._membership(pid, user.uid) is None:
            raise NotFound("Property not found.")
        bills = {b["id"]: b for b in self.store.query(self._col(pid, "utilityBills"))}
        for statement in visible:
            bill = bills.get(statement["utilityBillId"], {})
            statement["utilityBill"] = {
                "periodStart": bill.get("periodStart"), "periodEnd": bill.get("periodEnd"), "totalWh": bill.get("totalWh"),
                "amountCentavos": bill.get("amountCentavos"), "billNumber": bill.get("billNumber"),
            }
            statement.pop("sourceReadingIds", None)
        return sorted(visible, key=lambda s: (s["periodStart"], s["version"]), reverse=True)

    def my_unit(self, user: AuthUser, pid: str) -> dict:
        membership = self._require(pid, user, {TENANT})
        unit = self._get(pid, "units", membership["unitId"], "Unit")
        prop = self.store.get("properties", pid) or {}
        meters = {m["id"]: m for m in self.store.query(self._col(pid, "meters"))}
        assigned = [
            {"meterId": a["meterId"], "label": meters[a["meterId"]]["label"], "kind": meters[a["meterId"]]["kind"],
             "effectiveFrom": a["effectiveFrom"], "effectiveTo": a.get("effectiveTo")}
            for a in self.store.query(self._col(pid, "meterAssignments"), unitId=unit["id"]) if a["meterId"] in meters
        ]
        return {"propertyName": prop.get("name"), "unitId": unit["id"], "unitLabel": unit["label"], "meters": assigned}

    def my_meter_history(self, user: AuthUser, pid: str) -> list[dict]:
        """Verified readings from individual meters on the tenant's unit during their occupancy.

        Shared-meter readings are excluded: they are not individual consumption.
        """
        membership = self._require(pid, user, {TENANT})
        windows = [o for o in self._occupancies(pid) if o.tenant_uid == user.uid and o.unit_id == membership["unitId"]]
        meters = {m["id"]: m for m in self.store.query(self._col(pid, "meters"))}
        history = []
        for assignment in self.store.query(self._col(pid, "meterAssignments"), unitId=membership["unitId"]):
            meter = meters.get(assignment["meterId"])
            if not meter or meter["kind"] == "utility_shared":
                continue
            a = self._assignment(assignment)
            for reading in self._active_readings(pid, meter["id"]):
                day = date.fromisoformat(reading["readingDate"])
                in_assignment = a.effective_from <= day and (a.effective_to is None or day <= a.effective_to)
                in_occupancy = any(o.start - timedelta(days=self.config.reading_tolerance_days) <= day and (o.end is None or day <= o.end) for o in windows)
                if reading.get("verified") and in_assignment and in_occupancy:
                    history.append({
                        "meterLabel": meter["label"], "meterKind": meter["kind"], "readingDate": reading["readingDate"],
                        "valueWh": reading["valueWh"], "corrected": bool(reading.get("supersedesId")),
                    })
        return sorted(history, key=lambda r: (r["meterLabel"], r["readingDate"]), reverse=True)

    # ------------------------------------------------------------ subscription
    def get_subscription(self, user: AuthUser, pid: str) -> dict:
        self._require(pid, user, MANAGERS)
        return {**self.entitlement(pid), "plan": self.config.plan_info()}

    def request_activation(self, user: AuthUser, pid: str) -> dict:
        self._require(pid, user, {OWNER})
        self.store.update("subscriptions", pid, {"activationRequestedAt": self._now(), "activationRequestedBy": user.uid})
        self._audit(pid, user, "subscription.requestActivation", "subscription", pid)
        return self.entitlement(pid)

    def platform_set_subscription(self, user: AuthUser, pid: str, payload: dict) -> dict:
        """Manual activation by SmartWatts staff (platformAdmin claim). No payment is processed here."""
        if not user.platform_admin:
            raise Forbidden("Only SmartWatts staff can change subscription status.")
        if self.store.get("properties", pid) is None:
            raise NotFound("Property not found.")
        status = payload.get("status")
        if status not in {"active", "inactive", "canceled"}:
            raise Invalid("Status must be active, inactive, or canceled.")
        changes: dict = {"status": status, "updatedAt": self._now(), "updatedBy": user.uid}
        if status == "active":
            period_end = payload.get("currentPeriodEnd")
            try:
                parsed = datetime.fromisoformat(period_end) if isinstance(period_end, str) else None
            except ValueError:
                parsed = None
            if parsed is None or parsed.tzinfo is None or parsed <= self.clock():
                raise Invalid("Active subscriptions need a future currentPeriodEnd with a timezone.")
            changes["currentPeriodEnd"] = parsed.isoformat()
        self.store.update("subscriptions", pid, changes)
        self._audit(pid, user, "subscription.platformUpdate", "subscription", pid, {"status": status})
        return self.entitlement(pid)

    def list_audit_logs(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, MANAGERS)
        return sorted(self.store.query(self._col(pid, "auditLogs")), key=lambda log: log["at"], reverse=True)[:500]


__all__ = ["RentalService", "DomainError", "BillingError", "AlreadyExistsError"]
