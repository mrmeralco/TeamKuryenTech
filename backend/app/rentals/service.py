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
from . import subscriptions as subs
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
UNIT_OCCUPANCY = {"vacant", "occupied", "maintenance"}
# Lifecycles where owners may configure units, meters, and allocation rules.
# Operational workflows (invitations, readings, bills, statements, analytics)
# always require an active entitlement instead.
SETUP_LIFECYCLES = {"draft", "pending_activation", "active"}
SUBSCRIPTION_LIFECYCLE = {
    subs.INACTIVE: "draft", subs.PENDING: "pending_activation", subs.ACTIVE: "active",
    subs.SUSPENDED: "suspended", subs.EXPIRED: "expired", subs.DISABLED: "disabled",
}
# Reading interval anomaly: average daily use this many times the meter's median.
ANOMALY_FACTOR = 3


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

    def _manager_uids(self, pid: str) -> list[str]:
        return [m["uid"] for m in self.store.query("memberships", propertyId=pid, status="active") if m["role"] in MANAGERS]

    def _notify(self, pid: str, recipients: list[str], kind: str, title: str, body: str, *, page: str | None = None) -> None:
        """Persist an operational event for each recipient (separate from UI toasts)."""
        prop = self.store.get("properties", pid) or {}
        now = self._now()
        for uid in dict.fromkeys(recipients):
            self.store.create("rentalNotifications", _new_id(), {
                "recipientUid": uid, "propertyId": pid, "propertyName": prop.get("name"),
                "kind": kind, "title": title, "body": body, "page": page, "createdAt": now, "readAt": None,
            })

    def _get(self, pid: str, name: str, doc_id: str, label: str) -> dict:
        doc = self.store.get(self._col(pid, name), doc_id) if isinstance(doc_id, str) and doc_id else None
        if doc is None:
            raise NotFound(f"{label} not found.")
        return doc

    # ------------------------------------------------------------ entitlements
    def entitlement(self, pid: str) -> dict:
        subscription = self.store.get("subscriptions", pid) or {"status": subs.INACTIVE}
        status = subs.effective_status(subscription, self.clock())
        prop = self.store.get("properties", pid) or {}
        archived = bool(prop.get("archivedAt"))
        active = status == subs.ACTIVE and not archived
        lifecycle = "archived" if archived else SUBSCRIPTION_LIFECYCLE[status]
        return {
            "propertyId": pid,
            "status": status,
            "lifecycle": lifecycle,
            "archived": archived,
            "active": active,
            "currentPeriodStart": subscription.get("currentPeriodStart"),
            "currentPeriodEnd": subscription.get("currentPeriodEnd"),
            "unitLimit": subscription.get("unitLimit", self.config.unit_limit_per_property),
            "priceCentavos": subscription.get("priceCentavos", self.config.price_centavos_per_property_month),
            "activationRequestedAt": subscription.get("activationRequestedAt") if status == subs.PENDING else None,
            "lastRequestedAt": subscription.get("activationRequestedAt"),
            "decidedAt": subscription.get("decidedAt"),
            "activationSource": subscription.get("activationSource"),
            "statusReason": subscription.get("statusReason"),
            "lastAction": subscription.get("lastAction"),
            "updatedAt": subscription.get("updatedAt"),
            "version": subscription.get("version") or 0,
            "nextAction": subs.owner_next_action(status),
            "paymentsEnabled": False,
        }

    def _require_setup(self, pid: str) -> dict:
        """Configuration writes: allowed on drafts so owners can prepare before paying."""
        entitlement = self.entitlement(pid)
        if entitlement["lifecycle"] == "archived":
            raise Conflict("This property is archived and read-only.")
        if entitlement["lifecycle"] not in SETUP_LIFECYCLES:
            raise PaymentRequired(
                "This property's SmartWatts Rentals subscription is not active. Existing records stay readable; "
                "request activation on the Subscription page to make changes."
            )
        return entitlement

    def _require_entitlement(self, pid: str) -> dict:
        entitlement = self.entitlement(pid)
        if entitlement["archived"]:
            raise Conflict("This property is archived and read-only.")
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
            entry = {
                "propertyId": prop["id"],
                "propertyName": prop["name"],
                "lifecycle": self.entitlement(prop["id"])["lifecycle"] if membership["role"] in MANAGERS else None,
                "role": membership["role"],
                "unitId": membership.get("unitId"),
                "unitLabel": unit_label,
            }
            if prop.get("demoLabel"):
                entry["demoLabel"] = prop["demoLabel"]
            memberships.append(entry)
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
            "ownerUid": user.uid,
            "version": 0,
            "createdAt": now,
        }
        if self.config.trial_days:
            subscription["status"] = "trial"
            subscription["currentPeriodEnd"] = (self.clock() + timedelta(days=self.config.trial_days)).isoformat()
        self.store.create("subscriptions", pid, subscription)
        self._audit(pid, user, "property.create", "property", pid, {"name": name})
        self._notify(pid, [user.uid], "property.created", "Property created",
                     f"{name} was created as a draft. Add units and meters, then request activation.", page="rental-overview")
        return self.get_property(user, pid)

    def get_property(self, user: AuthUser, pid: str) -> dict:
        membership = self._require(pid, user, {OWNER, ADMIN, TENANT})
        prop = self.store.get("properties", pid)
        if prop is None:
            raise NotFound("Property not found.")
        result = {"id": pid, "name": prop["name"], "role": membership["role"]}
        if prop.get("demoLabel"):
            # Synthetic demo-fixture property (emulator seed): the UI must label it as sample data.
            result["demoLabel"] = prop["demoLabel"]
        if membership["role"] in MANAGERS:
            result.update({"address": prop["address"], "entitlement": self.entitlement(pid), "setup": self._setup_progress(pid)})
        return result

    def _setup_progress(self, pid: str) -> dict:
        units = [u for u in self.store.query(self._col(pid, "units")) if u.get("status") == "active"]
        meters = [m for m in self.store.query(self._col(pid, "meters")) if m.get("status", "active") == "active"]
        assignments = [a for a in self.store.query(self._col(pid, "meterAssignments")) if not a.get("effectiveTo")]
        agreements = self.store.query(self._col(pid, "allocationAgreements"))
        assigned_units = {a["unitId"] for a in assignments}
        covered_units = {s["unitId"] for a in agreements if not a.get("effectiveTo") for s in a["shares"]}
        unconfigured = [u["label"] for u in units if u["id"] not in assigned_units | covered_units]
        return {
            "unitCount": len(units),
            "meterCount": len(meters),
            "assignmentCount": len(assignments),
            "agreementCount": len(agreements),
            "unitsWithoutBillingArrangement": sorted(unconfigured, key=str.lower),
            "memberCount": len(self.store.query("memberships", propertyId=pid, status="active")),
        }

    def archive_property(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, {OWNER})
        if payload.get("confirm") is not True:
            raise Invalid("Confirm that you want to archive this property.")
        prop = self.store.get("properties", pid)
        if prop.get("archivedAt"):
            raise Conflict("This property is already archived.")
        if any(not o.get("endDate") for o in self.store.query(self._col(pid, "occupancies"))):
            raise Conflict("Record move-outs for current tenants before archiving the property.")
        self.store.update("properties", pid, {"archivedAt": self._now(), "archivedBy": user.uid})
        self._audit(pid, user, "property.archive", "property", pid)
        return self.get_property(user, pid)

    def analytics(self, user: AuthUser, pid: str, date_from: str | None = None, date_to: str | None = None) -> dict:
        self._require(pid, user, MANAGERS)
        entitlement = self._require_entitlement(pid)
        start_filter = _optional_date(date_from, "From date")
        end_filter = _optional_date(date_to, "To date")
        if start_filter and end_filter and end_filter < start_filter:
            raise Invalid("The To date must be on or after the From date.")

        def in_range(record: dict) -> bool:
            # A billing period is included when it overlaps the requested range.
            if start_filter and date.fromisoformat(record["periodEnd"]) < start_filter:
                return False
            if end_filter and date.fromisoformat(record["periodStart"]) > end_filter:
                return False
            return True

        prop = self.store.get("properties", pid) or {"id": pid, "name": "Property", "address": ""}

        all_units = self.store.query(self._col(pid, "units"))
        active_units = [u for u in all_units if u.get("status") == "active"]
        unit_labels = {u["id"]: u["label"] for u in all_units}

        all_occupancies = self.store.query(self._col(pid, "occupancies"))
        active_occupancies = [o for o in all_occupancies if not o.get("endDate")]
        occupied_unit_ids = {o["unitId"] for o in active_occupancies}

        meters = self.store.query(self._col(pid, "meters"))
        meter_labels = {m["id"]: m["label"] for m in meters}
        meters_by_kind = {
            "utility_individual": len([m for m in meters if m.get("kind") == "utility_individual"]),
            "utility_shared": len([m for m in meters if m.get("kind") == "utility_shared"]),
            "private_submeter": len([m for m in meters if m.get("kind") == "private_submeter"]),
        }

        assignments = self.store.query(self._col(pid, "meterAssignments"))
        unit_meters: dict[str, list[dict]] = {}
        for a in assignments:
            if not a.get("endDate"):
                unit_meters.setdefault(a["unitId"], []).append({
                    "meterId": a["meterId"],
                    "meterLabel": meter_labels.get(a["meterId"], a["meterId"]),
                })

        all_bills = [b for b in self.store.query(self._col(pid, "utilityBills")) if in_range(b)]
        active_bills = [b for b in all_bills if b.get("status") == "active"]
        active_bills.sort(key=lambda b: b["periodStart"])

        all_readings = self.store.query(self._col(pid, "meterReadings"))
        active_readings = [r for r in all_readings if r.get("status") == "active"]

        latest_bill = active_bills[-1] if active_bills else None
        missing_readings_alerts = []
        for m in meters:
            m_readings = [r for r in active_readings if r.get("meterId") == m["id"] and r.get("verified")]
            if not m_readings:
                missing_readings_alerts.append({
                    "meterId": m["id"],
                    "meterLabel": m["label"],
                    "kind": m.get("kind"),
                    "issue": "No verified readings recorded for this meter.",
                })
            elif latest_bill:
                has_recent = any(r.get("readingDate") >= latest_bill["periodStart"] for r in m_readings)
                if not has_recent:
                    missing_readings_alerts.append({
                        "meterId": m["id"],
                        "meterLabel": m["label"],
                        "kind": m.get("kind"),
                        "issue": f"Missing recent reading for billing period {latest_bill['periodStart']} to {latest_bill['periodEnd']}.",
                    })

        all_statements = [s for s in self.store.query(self._col(pid, "statements")) if in_range(s)]
        finalized_statements = [s for s in all_statements if s.get("status") == "finalized"]
        draft_statements = [s for s in all_statements if s.get("status") == "draft"]
        needs_review_statements = [s for s in all_statements if s.get("needsReview")]

        total_official_wh = sum(b["totalWh"] for b in active_bills)
        total_official_centavos = sum(b["amountCentavos"] for b in active_bills)
        total_tenant_billed_centavos = sum(s["totalCentavos"] for s in finalized_statements)

        total_measured_wh = 0
        total_allocated_wh = 0
        for s in finalized_statements:
            for line in s.get("lines", []):
                if line.get("consumptionKind") == "not_individually_measured" or line.get("chargeBasis") == "allocation_based_charge":
                    total_allocated_wh += (line.get("wh") or 0)
                else:
                    total_measured_wh += (line.get("wh") or 0)

        # Billing periods comparison
        periods = []
        for i, b in enumerate(active_bills):
            p_statements = [s for s in finalized_statements if s.get("utilityBillId") == b["id"]]
            p_drafts = [s for s in draft_statements if s.get("utilityBillId") == b["id"]]
            p_measured_wh = sum(
                line.get("wh") or 0
                for s in p_statements
                for line in s.get("lines", [])
                if line.get("consumptionKind") != "not_individually_measured"
            )
            p_allocated_wh = sum(
                line.get("wh") or 0
                for s in p_statements
                for line in s.get("lines", [])
                if line.get("consumptionKind") == "not_individually_measured"
            )
            p_tenant_centavos = sum(s["totalCentavos"] for s in p_statements)

            kwh_change_pct = None
            cost_change_pct = None
            # Compare with the previous bill of the SAME meter; different meters are not comparable.
            prev_b = next((x for x in reversed(active_bills[:i]) if x["meterId"] == b["meterId"]), None)
            if prev_b is not None:
                if prev_b.get("totalWh", 0) > 0:
                    kwh_change_pct = round(((b["totalWh"] - prev_b["totalWh"]) / prev_b["totalWh"]) * 100, 1)
                if prev_b.get("amountCentavos", 0) > 0:
                    cost_change_pct = round(((b["amountCentavos"] - prev_b["amountCentavos"]) / prev_b["amountCentavos"]) * 100, 1)

            periods.append({
                "billId": b["id"],
                "meterId": b["meterId"],
                "meterLabel": meter_labels.get(b["meterId"], b["meterId"]),
                "periodStart": b["periodStart"],
                "periodEnd": b["periodEnd"],
                "utilityTotalWh": b["totalWh"],
                "utilityAmountCentavos": b["amountCentavos"],
                "utilityKwh": round(b["totalWh"] / 1000, 2),
                "tenantBilledCentavos": p_tenant_centavos,
                "tenantMeasuredWh": p_measured_wh,
                "tenantAllocatedWh": p_allocated_wh,
                "finalizedCount": len(p_statements),
                "draftCount": len(p_drafts),
                "kwhChangePercent": kwh_change_pct,
                "costChangePercent": cost_change_pct,
            })

        # Property-level trend: total of every utility bill per exact billing period, compared with the previous
        # period only when both periods cover the same meters (otherwise the totals are not comparable).
        period_totals: dict[tuple[str, str], dict] = {}
        for b in active_bills:
            total = period_totals.setdefault((b["periodStart"], b["periodEnd"]), {"wh": 0, "centavos": 0, "meters": set()})
            total["wh"] += b["totalWh"]
            total["centavos"] += b["amountCentavos"]
            total["meters"].add(b["meterId"])
        period_over_period = None
        ordered_periods = sorted(period_totals)
        if len(ordered_periods) >= 2:
            cur_key, prev_key = ordered_periods[-1], ordered_periods[-2]
            cur_t, prev_t = period_totals[cur_key], period_totals[prev_key]
            if cur_t["meters"] == prev_t["meters"]:
                kwh_diff = (cur_t["wh"] - prev_t["wh"]) / 1000
                cost_diff_centavos = cur_t["centavos"] - prev_t["centavos"]
                period_over_period = {
                    "currentPeriod": f"{cur_key[0]} to {cur_key[1]}",
                    "previousPeriod": f"{prev_key[0]} to {prev_key[1]}",
                    "kwhChange": round(kwh_diff, 2),
                    "kwhChangePercent": round((cur_t["wh"] - prev_t["wh"]) / prev_t["wh"] * 100, 1) if prev_t["wh"] else None,
                    "costChangeCentavos": cost_diff_centavos,
                    "costChangePercent": round(cost_diff_centavos / prev_t["centavos"] * 100, 1) if prev_t["centavos"] else None,
                    "meterCount": len(cur_t["meters"]),
                }

        # Unit-level analytics
        units_analytics = []
        for u in sorted(all_units, key=lambda x: x.get("label", "").lower()):
            uid = u["id"]
            u_statements = [s for s in all_statements if s.get("unitId") == uid]
            u_finalized = [s for s in u_statements if s.get("status") == "finalized"]
            u_draft = [s for s in u_statements if s.get("status") == "draft"]

            u_billed_centavos = sum(s["totalCentavos"] for s in u_finalized)
            u_measured_wh = sum(
                line.get("wh") or 0
                for s in u_finalized
                for line in s.get("lines", [])
                if line.get("consumptionKind") != "not_individually_measured"
            )
            u_allocated_wh = sum(
                line.get("wh") or 0
                for s in u_finalized
                for line in s.get("lines", [])
                if line.get("consumptionKind") == "not_individually_measured"
            )

            u_history = []
            for s in sorted(u_statements, key=lambda x: x.get("periodStart", "")):
                s_measured = sum(line.get("wh") or 0 for line in s.get("lines", []) if line.get("consumptionKind") != "not_individually_measured")
                s_allocated = sum(line.get("wh") or 0 for line in s.get("lines", []) if line.get("consumptionKind") == "not_individually_measured")
                u_history.append({
                    "id": s["id"],
                    "periodStart": s["periodStart"],
                    "periodEnd": s["periodEnd"],
                    "status": s["status"],
                    "totalCentavos": s["totalCentavos"],
                    "measuredWh": s_measured,
                    "allocatedWh": s_allocated,
                    "needsReview": s.get("needsReview", False),
                    "reviewReason": s.get("reviewReason"),
                    "lines": s.get("lines", []),
                })

            u_change_pct = None
            if len(u_history) >= 2:
                latest_wh = u_history[-1]["measuredWh"] + u_history[-1]["allocatedWh"]
                prior_wh = u_history[-2]["measuredWh"] + u_history[-2]["allocatedWh"]
                if prior_wh > 0:
                    u_change_pct = round(((latest_wh - prior_wh) / prior_wh) * 100, 1)

            current_occ = next((o for o in active_occupancies if o["unitId"] == uid), None)
            unit_occ_count = len([o for o in all_occupancies if o["unitId"] == uid])

            units_analytics.append({
                "unitId": uid,
                "unitLabel": u.get("label", uid),
                "status": u.get("status", "active"),
                "isOccupied": uid in occupied_unit_ids,
                "currentOccupancy": {
                    "tenantUid": current_occ["tenantUid"],
                    "startDate": current_occ["startDate"],
                } if current_occ else None,
                "occupancyCount": unit_occ_count,
                "meters": unit_meters.get(uid, []),
                "totalBilledCentavos": u_billed_centavos,
                "totalMeasuredWh": u_measured_wh,
                "totalAllocatedWh": u_allocated_wh,
                "finalizedStatementsCount": len(u_finalized),
                "draftStatementsCount": len(u_draft),
                "consumptionChangePercent": u_change_pct,
                "latestStatement": u_history[-1] if u_history else None,
                "statements": u_history[-6:],
            })

        # Shared meters & allocations
        shared_meters = []
        for m in meters:
            if m.get("kind") == "utility_shared":
                submeters = [s for s in meters if s.get("parentMeterId") == m["id"]]
                agreements = self.store.query(self._col(pid, "allocationAgreements"), meterId=m["id"])
                shared_meters.append({
                    "meterId": m["id"],
                    "meterLabel": m["label"],
                    "submeterCount": len(submeters),
                    "submeters": [{"id": s["id"], "label": s["label"]} for s in submeters],
                    "agreementsCount": len(agreements),
                    "allocationMethodology": "Submeter deduction + explicit agreed share allocation",
                    "legalNotice": billing.LEGAL_REVIEW_NOTICE,
                })

        # Monthly Trends (last 12 bills)
        monthly_trends = []
        for b in active_bills[-12:]:
            p_statements = [s for s in finalized_statements if s.get("utilityBillId") == b["id"]]
            p_measured = sum(line.get("wh") or 0 for s in p_statements for line in s.get("lines", []) if line.get("consumptionKind") != "not_individually_measured")
            p_allocated = sum(line.get("wh") or 0 for s in p_statements for line in s.get("lines", []) if line.get("consumptionKind") == "not_individually_measured")
            monthly_trends.append({
                "period": f"{b['periodStart'][:7]}",
                "periodStart": b["periodStart"],
                "periodEnd": b["periodEnd"],
                "utilityKwh": round(b["totalWh"] / 1000, 2),
                "utilityCentavos": b["amountCentavos"],
                "tenantMeasuredKwh": round(p_measured / 1000, 2),
                "tenantAllocatedKwh": round(p_allocated / 1000, 2),
                "tenantBilledCentavos": sum(s["totalCentavos"] for s in p_statements),
            })

        meter_trends = []
        for m in meters:
            m_bills = [b for b in active_bills if b["meterId"] == m["id"]]
            if m_bills:
                meter_trends.append({
                    "meterId": m["id"], "meterLabel": m["label"], "kind": m.get("kind"),
                    "points": [{"periodStart": b["periodStart"], "periodEnd": b["periodEnd"], "kwh": round(b["totalWh"] / 1000, 2),
                                "amountCentavos": b["amountCentavos"]} for b in m_bills],
                })

        return {
            "propertyId": pid,
            "filters": {"from": start_filter.isoformat() if start_filter else None, "to": end_filter.isoformat() if end_filter else None},
            "meterTrends": meter_trends,
            "propertyName": prop.get("name", "Property"),
            "address": prop.get("address"),
            "entitlement": entitlement,
            "unitCount": len(active_units),
            "totalUnitCount": len(all_units),
            "occupiedUnitCount": len(occupied_unit_ids),
            "vacantUnitCount": max(0, len(active_units) - len(occupied_unit_ids)),
            "occupancyRate": round((len(occupied_unit_ids) / len(active_units)) * 100, 1) if active_units else 0.0,
            "meterCount": len(meters),
            "metersByType": meters_by_kind,
            "totalOfficialBilledCentavos": total_official_centavos,
            "totalOfficialBilledWh": total_official_wh,
            "totalTenantBilledCentavos": total_tenant_billed_centavos,
            "totalTenantMeasuredWh": total_measured_wh,
            "totalTenantAllocatedWh": total_allocated_wh,
            "statementsSummary": {
                "finalizedCount": len(finalized_statements),
                "finalizedCentavos": total_tenant_billed_centavos,
                "draftCount": len(draft_statements),
                "draftCentavos": sum(s["totalCentavos"] for s in draft_statements),
                "needsReviewCount": len(needs_review_statements),
            },
            "bills": [
                {"id": b["id"], "periodStart": b["periodStart"], "periodEnd": b["periodEnd"],
                 "totalWh": b["totalWh"], "amountCentavos": b["amountCentavos"], "meterId": b["meterId"]}
                for b in active_bills[-12:]
            ],
            "billingPeriods": periods,
            "periodOverPeriod": period_over_period,
            "unitsAnalytics": units_analytics,
            "sharedMeters": shared_meters,
            "missingReadingsAlerts": missing_readings_alerts,
            "monthlyTrends": monthly_trends,
            "legalNotice": billing.LEGAL_REVIEW_NOTICE,
            "finalizedByUnit": [
                {
                    "unitId": u["unitId"],
                    "unitLabel": u["unitLabel"],
                    "billedCentavos": u["totalBilledCentavos"],
                    "measuredWh": u["totalMeasuredWh"],
                }
                for u in units_analytics if u["totalBilledCentavos"] > 0 or u["totalMeasuredWh"] > 0
            ],
        }

    def portfolio_analytics(self, user: AuthUser) -> dict:
        memberships = self.store.query("memberships", uid=user.uid, status="active")
        manager_memberships = [m for m in memberships if m.get("role") in MANAGERS]
        if not manager_memberships:
            return {
                "totalProperties": 0,
                "activePropertiesCount": 0,
                "properties": [],
                "activeProperties": [],
                "portfolioTotals": None,
                "message": "No managed properties found.",
            }

        properties_summary = []
        active_properties = []
        portfolio_wh = 0
        portfolio_billed_centavos = 0
        portfolio_tenant_centavos = 0
        portfolio_units = 0
        portfolio_occupied = 0

        for m in manager_memberships:
            pid = m["propertyId"]
            prop = self.store.get("properties", pid)
            if not prop:
                continue
            ent = self.entitlement(pid)
            item = {
                "propertyId": pid,
                "propertyName": prop.get("name", "Property"),
                "address": prop.get("address"),
                "role": m.get("role"),
                "entitlement": ent,
                "unlocked": ent["active"],
            }
            if ent["active"]:
                p_analytics = self.analytics(user, pid)
                item["analytics"] = p_analytics
                active_properties.append(p_analytics)
                portfolio_wh += p_analytics["totalOfficialBilledWh"]
                portfolio_billed_centavos += p_analytics["totalOfficialBilledCentavos"]
                portfolio_tenant_centavos += p_analytics["totalTenantBilledCentavos"]
                portfolio_units += p_analytics["unitCount"]
                portfolio_occupied += p_analytics["occupiedUnitCount"]
            properties_summary.append(item)

        totals = None
        if active_properties:
            totals = {
                "activePropertyCount": len(active_properties),
                "totalUnits": portfolio_units,
                "totalOccupiedUnits": portfolio_occupied,
                "occupancyRate": round((portfolio_occupied / portfolio_units) * 100, 1) if portfolio_units else 0.0,
                "portfolioConsumptionWh": portfolio_wh,
                "portfolioConsumptionKwh": round(portfolio_wh / 1000, 2),
                "portfolioUtilityBilledCentavos": portfolio_billed_centavos,
                "portfolioTenantBilledCentavos": portfolio_tenant_centavos,
            }

        return {
            "totalProperties": len(properties_summary),
            "activePropertiesCount": len(active_properties),
            "properties": properties_summary,
            "activeProperties": active_properties,
            "portfolioTotals": totals,
        }

    # ------------------------------------------------------------------ units
    @staticmethod
    def _occupancy_status(value: object, default: str = "vacant") -> str:
        if value in (None, ""):
            return default
        if value not in UNIT_OCCUPANCY:
            raise Invalid("Occupancy status must be vacant, occupied, or maintenance.")
        return value

    def create_unit(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        entitlement = self._require_setup(pid)
        label = _clean_text(payload.get("label"), "Unit label", maximum=60)
        active = self.store.query(self._col(pid, "units"), status="active")
        if len(active) >= entitlement["unitLimit"]:
            raise PaymentRequired(f"This property's plan supports up to {entitlement['unitLimit']} units.")
        if any(unit["label"].lower() == label.lower() for unit in active):
            raise Conflict("A unit with this label already exists.")
        unit_id = _new_id()
        doc = {
            "label": label, "notes": _optional_text(payload.get("notes"), "Notes", 500), "status": "active",
            "occupancyStatus": self._occupancy_status(payload.get("occupancyStatus")), "createdAt": self._now(),
        }
        self.store.create(self._col(pid, "units"), unit_id, doc)
        self._audit(pid, user, "unit.create", "unit", unit_id, {"label": label})
        return {**doc, "id": unit_id}

    def update_unit(self, user: AuthUser, pid: str, unit_id: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_setup(pid)
        unit = self._get(pid, "units", unit_id, "Unit")
        if unit.get("status") != "active":
            raise Conflict("Archived units cannot be edited.")
        changes: dict = {}
        if "label" in payload:
            label = _clean_text(payload.get("label"), "Unit label", maximum=60)
            others = [u for u in self.store.query(self._col(pid, "units"), status="active") if u["id"] != unit_id]
            if any(u["label"].lower() == label.lower() for u in others):
                raise Conflict("A unit with this label already exists.")
            changes["label"] = label
        if "notes" in payload:
            changes["notes"] = _optional_text(payload.get("notes"), "Notes", 500)
        if "occupancyStatus" in payload:
            changes["occupancyStatus"] = self._occupancy_status(payload.get("occupancyStatus"))
        if not changes:
            raise Invalid("Nothing to update.")
        changes["updatedAt"] = self._now()
        self.store.update(self._col(pid, "units"), unit_id, changes)
        self._audit(pid, user, "unit.update", "unit", unit_id, {k: v for k, v in changes.items() if k != "updatedAt"})
        return {**unit, **changes}

    def archive_unit(self, user: AuthUser, pid: str, unit_id: str, payload: dict) -> dict:
        """Soft-archive: readings, bills, statements, and tenancy history are kept."""
        self._require(pid, user, MANAGERS)
        self._require_setup(pid)
        unit = self._get(pid, "units", unit_id, "Unit")
        if unit.get("status") != "active":
            raise Conflict("This unit is already archived.")
        if payload.get("confirm") is not True:
            raise Invalid("Confirm that you want to archive this unit.")
        if any(o["unitId"] == unit_id and not o.get("endDate") for o in self.store.query(self._col(pid, "occupancies"))):
            raise Conflict("Record the current tenant's move-out before archiving this unit.")
        if any(i["unitId"] == unit_id and i["status"] == "pending" for i in self.store.query("invitations", propertyId=pid)):
            raise Conflict("Revoke pending invitations for this unit before archiving it.")
        today = self._today().isoformat()
        ended = []
        for assignment in self.store.query(self._col(pid, "meterAssignments"), unitId=unit_id):
            if not assignment.get("effectiveTo"):
                end = max(today, assignment["effectiveFrom"])
                self.store.update(self._col(pid, "meterAssignments"), assignment["id"], {"effectiveTo": end})
                ended.append(assignment["id"])
        self.store.update(self._col(pid, "units"), unit_id, {"status": "archived", "archivedAt": self._now(), "archivedBy": user.uid})
        self._audit(pid, user, "unit.archive", "unit", unit_id, {"label": unit["label"], "endedAssignmentIds": ended})
        return {**unit, "status": "archived", "endedAssignmentIds": ended}

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
        self._require_setup(pid)
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
            "status": "active",
            "replacesMeterId": None,
            "createdAt": self._now(),
        }
        replaces = payload.get("replacesMeterId") or None
        if replaces:
            old = self._get(pid, "meters", replaces, "Replaced meter")
            if old.get("status", "active") != "retired":
                raise Invalid("Retire the old meter (with its final reading) before registering its replacement.")
            if old["kind"] != kind:
                raise Invalid("A replacement meter must be the same type as the meter it replaces.")
            doc["replacesMeterId"] = old["id"]
        self.store.create(self._col(pid, "meters"), meter_id, doc)
        self._audit(pid, user, "meter.create", "meter", meter_id, {"kind": kind, "label": doc["label"]})
        return {**doc, "id": meter_id}

    def retire_meter(self, user: AuthUser, pid: str, meter_id: str, payload: dict) -> dict:
        """Meter replacement: the old meter keeps its readings; a new meter starts a fresh register."""
        self._require(pid, user, MANAGERS)
        self._require_setup(pid)
        meter = self._get(pid, "meters", meter_id, "Meter")
        if meter.get("status", "active") == "retired":
            raise Conflict("This meter is already retired.")
        retired_on = _parse_date(payload.get("retiredOn"), "Retirement date")
        if retired_on > self._today():
            raise Invalid("Retirement date cannot be in the future.")
        reason = _clean_text(payload.get("reason"), "Reason", minimum=5, maximum=300)
        later = [r for r in self._active_readings(pid, meter_id) if r["readingDate"] > retired_on.isoformat()]
        if later:
            raise Conflict("Readings exist after the retirement date. Choose the date of the final reading.")
        for assignment in self.store.query(self._col(pid, "meterAssignments"), meterId=meter_id):
            if not assignment.get("effectiveTo"):
                end = max(retired_on.isoformat(), assignment["effectiveFrom"])
                self.store.update(self._col(pid, "meterAssignments"), assignment["id"], {"effectiveTo": end})
        changes = {"status": "retired", "retiredOn": retired_on.isoformat(), "retiredReason": reason, "retiredBy": user.uid}
        self.store.update(self._col(pid, "meters"), meter_id, changes)
        self._audit(pid, user, "meter.retire", "meter", meter_id, {"retiredOn": retired_on.isoformat(), "reason": reason})
        return {**meter, **changes}

    def list_meters(self, user: AuthUser, pid: str) -> dict:
        self._require(pid, user, MANAGERS)
        return {
            "meters": sorted(self.store.query(self._col(pid, "meters")), key=lambda m: m["label"].lower()),
            "assignments": sorted(self.store.query(self._col(pid, "meterAssignments")), key=lambda a: a["effectiveFrom"]),
            "agreements": self.store.query(self._col(pid, "allocationAgreements")),
        }

    def create_assignment(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_setup(pid)
        meter = self._get(pid, "meters", payload.get("meterId"), "Meter")
        unit = self._get(pid, "units", payload.get("unitId"), "Unit")
        if meter.get("status", "active") != "active" or unit.get("status") != "active":
            raise Conflict("Retired meters and archived units cannot be assigned.")
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
        self._require_setup(pid)
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
        self._require_setup(pid)
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
                raise Invalid(
                    f"Reading is lower than the earlier reading on {other['readingDate']}. Meter values cannot go backwards. "
                    "If the meter was replaced or its register reset, retire this meter and register the new one."
                )
            if other_date > reading_date and other["valueWh"] < wh:
                raise Invalid(f"Reading is higher than the later reading on {other['readingDate']}. Check the date and value.")

    def record_reading(self, user: AuthUser, pid: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        meter = self._get(pid, "meters", payload.get("meterId"), "Meter")
        if meter.get("status", "active") == "retired":
            raise Conflict("This meter is retired. Record readings on its replacement meter.")
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
        self._notify(pid, [u for u in self._manager_uids(pid) if u != user.uid], "reading.submitted", "Meter reading submitted",
                     f"{meter['label']}: {wh / 1000:,.3f} kWh on {reading_date.isoformat()}.", page="rental-readings")
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
                {"needsReview": True, "reviewReason": "A source reading was corrected. Regenerate statements for this bill.",
                 "reviewedAt": None, "reviewedBy": None},
            )
        self._notify(pid, self._manager_uids(pid), "reading.corrected", "Meter reading corrected",
                     f"A reading from {original['readingDate']} was corrected: {reason}", page="rental-readings")
        self._audit(pid, user, "reading.correct", "meterReading", new_id, {
            "supersedesId": reading_id, "previousWh": original["valueWh"], "valueWh": wh, "reason": reason,
            "affectedStatementIds": affected,
        })
        return {**doc, "id": new_id, "affectedStatementIds": affected}

    def list_readings(self, user: AuthUser, pid: str, meter_id: str | None = None) -> list[dict]:
        """Readings with interval consumption (vs. the previous current reading) and anomaly flags.

        ``readingDate`` is the observation date entered by the user; ``createdAt`` is the server time
        the record was saved. Anomalies are flags for review only; nothing is changed automatically.
        """
        self._require(pid, user, MANAGERS)
        filters = {"meterId": meter_id} if meter_id else {}
        readings = self.store.query(self._col(pid, "meterReadings"), **filters)
        by_meter: dict[str, list[dict]] = {}
        for r in readings:
            r["intervalWh"] = None
            r["intervalDays"] = None
            r["anomalies"] = []
            if r["status"] == "active":
                by_meter.setdefault(r["meterId"], []).append(r)
        for series in by_meter.values():
            series.sort(key=lambda r: r["readingDate"])
            daily = []
            for previous, current in zip(series, series[1:]):
                days = (date.fromisoformat(current["readingDate"]) - date.fromisoformat(previous["readingDate"])).days
                current["intervalWh"] = current["valueWh"] - previous["valueWh"]
                current["intervalDays"] = days
                if days > 0:
                    daily.append((current, current["intervalWh"] / days))
            if len(daily) >= 3:
                rates = sorted(rate for _, rate in daily)
                median = rates[len(rates) // 2]
                for reading, rate in daily:
                    if median > 0 and rate > ANOMALY_FACTOR * median:
                        reading["anomalies"].append(f"Daily use is more than {ANOMALY_FACTOR}× this meter's typical interval.")
            for reading, _rate in daily:
                if reading["intervalWh"] == 0 and reading["intervalDays"] >= 14:
                    reading["anomalies"].append("No consumption for 14+ days. Check the meter or occupancy.")
                if reading["intervalDays"] > 45:
                    reading["anomalies"].append("Long gap since the previous reading.")
        return sorted(readings, key=lambda r: (r["meterId"], r["readingDate"], r["createdAt"]), reverse=True)

    def attach_reading_evidence(self, user: AuthUser, pid: str, reading_id: str, content: bytes, content_type: str) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        reading = self._get(pid, "meterReadings", reading_id, "Reading")
        path = self._store_document(f"properties/{pid}/meterReadings/{reading_id}", content, content_type)
        self.store.update(self._col(pid, "meterReadings"), reading_id, {"evidencePath": path, "evidenceContentType": content_type})
        self._audit(pid, user, "reading.attachEvidence", "meterReading", reading_id, {"bytes": len(content)})
        return {**reading, "evidencePath": path, "evidenceContentType": content_type}

    def get_reading_evidence(self, user: AuthUser, pid: str, reading_id: str) -> tuple[bytes, str]:
        self._require(pid, user, MANAGERS)
        reading = self._get(pid, "meterReadings", reading_id, "Reading")
        blob = self.blobs.get(reading["evidencePath"]) if reading.get("evidencePath") and self.blobs else None
        if blob is None:
            raise NotFound("No evidence is attached to this reading.")
        return blob

    def _store_document(self, prefix: str, content: bytes, content_type: str) -> str:
        if self.blobs is None:
            raise DomainError("Document storage is not configured on the server. The record itself is saved.")
        signature = DOCUMENT_TYPES.get(content_type)
        if signature is None or not content.startswith(signature):
            raise Invalid("Upload a PDF, PNG, or JPEG document.")
        if len(content) > MAX_DOCUMENT_BYTES:
            raise Invalid("Documents must be 10 MB or smaller.")
        path = f"{prefix}/{_new_id()}"
        self.blobs.put(path, content, content_type)
        return path

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
        bill_number = _optional_text(payload.get("billNumber"), "Bill number", 60)
        for other in self.store.query(self._col(pid, "utilityBills"), meterId=meter["id"], status="active"):
            if date.fromisoformat(other["periodStart"]) < end and date.fromisoformat(other["periodEnd"]) > start:
                raise Conflict("Another bill for this meter overlaps this period.")
        if bill_number and any(
            (b.get("billNumber") or "").lower() == bill_number.lower()
            for b in self.store.query(self._col(pid, "utilityBills"), status="active")
        ):
            raise Conflict("A bill with this bill number is already recorded for this property.")
        components = self._charge_components(payload.get("chargeComponents"), amount)
        bill_id = _new_id()
        doc = {
            "meterId": meter["id"], "periodStart": start.isoformat(), "periodEnd": end.isoformat(),
            "totalWh": total_wh, "amountCentavos": amount,
            "billNumber": bill_number,
            "chargeComponents": components,
            # Entered by the property manager from their bill. SmartWatts is not connected to utility systems.
            "verification": "owner_entered",
            "dueDate": _optional_date(payload.get("dueDate"), "Due date").isoformat() if payload.get("dueDate") else None,
            "documentPath": None, "documentContentType": None,
            "source": "photo_ocr_verified" if payload.get("source") == "photo_ocr" else "manual",
            "status": "active", "uploadedBy": user.uid, "createdAt": self._now(),
        }
        self.store.create(self._col(pid, "utilityBills"), bill_id, doc)
        self._audit(pid, user, "utilityBill.create", "utilityBill", bill_id, {"meterId": meter["id"], "amountCentavos": amount, "totalWh": total_wh})
        self._notify(pid, [u for u in self._manager_uids(pid) if u != user.uid], "bill.recorded", "Utility bill recorded",
                     f"{meter['label']}: {start.isoformat()} – {end.isoformat()}, {total_wh / 1000:,.3f} kWh.", page="rental-bills")
        try:
            from app.notifications.service import notification_service
            from app.notifications.models import BillSavedNotificationRequest
            prop = self.store.get("properties", pid) or {}
            notification_service.handle_bill_saved(
                user,
                BillSavedNotificationRequest(
                    billId=bill_id,
                    periodStart=doc["periodStart"],
                    periodEnd=doc["periodEnd"],
                    amountPesos=round(amount / 100.0, 2),
                    kwh=round(total_wh / 1000.0, 2),
                    dueDate=doc.get("dueDate"),
                    workspaceType="Rentals",
                    propertyName=prop.get("name") if isinstance(prop, dict) else None,
                    propertyId=pid,
                ),
                register_for_scheduler=False,
            )
        except Exception:
            pass
        return {**doc, "id": bill_id}

    @staticmethod
    def _charge_components(value: object, total: int) -> list[dict]:
        """Optional breakdown copied from the bill (generation, transmission, taxes, …). Display only."""
        if value in (None, ""):
            return []
        if not isinstance(value, list) or len(value) > 20:
            raise Invalid("Charge components must be a list of up to 20 items.")
        components = []
        for item in value:
            if not isinstance(item, dict):
                raise Invalid("Each charge component needs a label and an amount.")
            label = _clean_text(item.get("label"), "Charge component label", maximum=80)
            cents = item.get("amountCentavos")
            if isinstance(cents, bool) or not isinstance(cents, int) or not -10**11 <= cents <= 10**11:
                raise Invalid("Each charge component amount must be a whole number of centavos.")
            components.append({"label": label, "amountCentavos": cents})
        if components and sum(c["amountCentavos"] for c in components) != total:
            raise Invalid("Charge components must add up exactly to the bill total.")
        return components

    def attach_bill_document(self, user: AuthUser, pid: str, bill_id: str, content: bytes, content_type: str) -> dict:
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        bill = self._get(pid, "utilityBills", bill_id, "Bill")
        path = self._store_document(f"properties/{pid}/utilityBills/{bill_id}", content, content_type)
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
                "reviewedAt": None, "reviewedBy": None,
                "meterConfiguration": meter_doc["kind"], "meterLabel": meter_doc["label"],
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

    def review_statement(self, user: AuthUser, pid: str, statement_id: str) -> dict:
        """Draft → Reviewed. A manager confirms the figures before they can be published."""
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        statement = self._get(pid, "statements", statement_id, "Statement")
        if statement["status"] != "draft":
            raise Conflict("Only draft statements can be reviewed.")
        if statement["needsReview"] or not statement.get("tenantUid"):
            raise Conflict("Resolve the review notes before marking this statement reviewed.")
        if statement.get("reviewedAt"):
            raise Conflict("This statement is already reviewed.")
        now = self._now()
        if not self.store.compare_and_update(
            self._col(pid, "statements"), statement_id, {"status": "draft", "needsReview": False},
            {"reviewedAt": now, "reviewedBy": user.uid},
        ):
            raise Conflict("This statement changed. Reload and try again.")
        self._audit(pid, user, "statement.review", "statement", statement_id)
        return {**statement, "reviewedAt": now, "reviewedBy": user.uid}

    def finalize_statement(self, user: AuthUser, pid: str, statement_id: str) -> dict:
        """Reviewed → Published (stored as status "finalized"); visible to the tenant from now on."""
        self._require(pid, user, MANAGERS)
        self._require_entitlement(pid)
        statement = self._get(pid, "statements", statement_id, "Statement")
        if statement["status"] != "draft":
            raise Conflict("Only draft statements can be finalized.")
        if statement["needsReview"] or not statement.get("tenantUid"):
            raise Conflict("Resolve the review notes before finalizing this statement.")
        if not statement.get("reviewedAt"):
            raise Conflict("Mark this statement as reviewed before publishing it.")
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
        self._notify(pid, [statement["tenantUid"]], "statement.published", "New electricity statement",
                     f"Your statement for {statement['periodStart']} – {statement['periodEnd']} is ready.", page="tenant-statements")
        try:
            from app.notifications.service import notification_service
            prop = self.store.get("properties", pid) or {}
            unit = self.store.get(self._col(pid, "units"), statement.get("unitId")) if statement.get("unitId") else {}
            tenant_uid = statement.get("tenantUid")
            membership = self.store.get("memberships", f"{pid}_{tenant_uid}") if tenant_uid else None
            tenant_email = (membership or {}).get("email") or statement.get("tenantEmail")
            if tenant_email and tenant_uid:
                notification_service.handle_statement_published(
                    statement={**statement, "status": "finalized"},
                    pid=pid,
                    property_name=prop.get("name") or "Your Rental",
                    unit_name=unit.get("name") or unit.get("label") or "",
                    tenant_email=tenant_email,
                    tenant_name=(membership or {}).get("name"),
                )
        except Exception:
            pass
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
        self._notify(pid, self._manager_uids(pid), "invitation.accepted", "Invitation accepted",
                     f"{user.email or 'A new member'} joined as {invitation['role']}.", page="rental-units")
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
        self._notify(pid, [occupancy["tenantUid"]], "membership.changed", "Move-out recorded",
                     f"Your move-out date was recorded as {end.isoformat()}. Your published statements stay available.")
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
        self._notify(pid, [uid], "membership.changed", "Property access removed",
                     "Your access to this property was removed. Your published statements stay available.")
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
        # Shared-meter arrangements covering this unit: show only this unit's share and the total weight.
        shared = []
        for agreement in self.store.query(self._col(pid, "allocationAgreements")):
            mine = next((s for s in agreement["shares"] if s["unitId"] == unit["id"]), None)
            if mine and agreement["meterId"] in meters:
                shared.append({
                    "meterLabel": meters[agreement["meterId"]]["label"], "description": agreement["description"],
                    "unitWeight": mine["weight"], "totalWeight": sum(s["weight"] for s in agreement["shares"]),
                    "effectiveFrom": agreement["effectiveFrom"], "effectiveTo": agreement.get("effectiveTo"),
                })
        result = {
            "propertyName": prop.get("name"), "propertyAddress": prop.get("address"),
            "unitId": unit["id"], "unitLabel": unit["label"], "meters": assigned, "sharedArrangements": shared,
        }
        if prop.get("demoLabel"):
            result["demoLabel"] = prop["demoLabel"]
        return result

    def request_statement_review(self, user: AuthUser, pid: str, statement_id: str, payload: dict) -> dict:
        """A tenant asks the owner to re-check a published statement. No payment or dispute ruling happens here."""
        membership = self._require(pid, user, {TENANT})
        statement = self._get(pid, "statements", statement_id, "Statement")
        if statement.get("tenantUid") != user.uid or statement["status"] != "finalized":
            raise NotFound("Statement not found.")
        message = _clean_text(payload.get("message"), "Message", minimum=10, maximum=1000)
        open_requests = [
            r for r in self.store.query(self._col(pid, "reviewRequests"), statementId=statement_id)
            if r["status"] == "open" and r["tenantUid"] == user.uid
        ]
        if open_requests:
            raise Conflict("You already have an open review request for this statement.")
        request_id = _new_id()
        doc = {
            "statementId": statement_id, "unitId": membership["unitId"], "tenantUid": user.uid, "tenantEmail": user.email,
            "message": message, "status": "open", "createdAt": self._now(), "resolvedAt": None, "resolution": None,
        }
        self.store.create(self._col(pid, "reviewRequests"), request_id, doc)
        self._audit(pid, user, "statement.reviewRequest", "statement", statement_id, {"requestId": request_id})
        self._notify(pid, self._manager_uids(pid), "statement.reviewRequested", "Statement review requested",
                     f"A tenant asked you to re-check the {statement['periodStart']} – {statement['periodEnd']} statement.",
                     page="rental-statements")
        return {**doc, "id": request_id}

    def my_review_requests(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, {TENANT})
        requests = self.store.query(self._col(pid, "reviewRequests"), tenantUid=user.uid)
        return sorted(requests, key=lambda r: r["createdAt"], reverse=True)

    def list_review_requests(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, MANAGERS)
        return sorted(self.store.query(self._col(pid, "reviewRequests")), key=lambda r: r["createdAt"], reverse=True)

    def resolve_review_request(self, user: AuthUser, pid: str, request_id: str, payload: dict) -> dict:
        self._require(pid, user, MANAGERS)
        request = self._get(pid, "reviewRequests", request_id, "Review request")
        resolution = _clean_text(payload.get("resolution"), "Response", minimum=5, maximum=1000)
        if not self.store.compare_and_update(
            self._col(pid, "reviewRequests"), request_id, {"status": "open"},
            {"status": "resolved", "resolution": resolution, "resolvedAt": self._now(), "resolvedBy": user.uid},
        ):
            raise Conflict("This request was already resolved.")
        self._audit(pid, user, "statement.reviewResolve", "reviewRequest", request_id)
        self._notify(pid, [request["tenantUid"]], "statement.reviewResolved", "Your statement review was answered",
                     resolution, page="tenant-statements")
        return {**request, "status": "resolved", "resolution": resolution}

    def my_notifications(self, user: AuthUser) -> list[dict]:
        """Notifications addressed to this user. Property events are kept even after access ends."""
        items = self.store.query("rentalNotifications", recipientUid=user.uid)
        return sorted(items, key=lambda n: n["createdAt"], reverse=True)[:100]

    def mark_notification_read(self, user: AuthUser, notification_id: str) -> dict:
        item = self.store.get("rentalNotifications", notification_id) if isinstance(notification_id, str) and notification_id else None
        if item is None or item.get("recipientUid") != user.uid:
            raise NotFound("Notification not found.")
        if not item.get("readAt"):
            self.store.update("rentalNotifications", notification_id, {"readAt": self._now()})
        return {**item, "readAt": item.get("readAt") or self._now()}

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

    def historical_records(self, user: AuthUser, pid: str, *, start: str | None = None, end: str | None = None,
                           record_type: str | None = None, unit_id: str | None = None,
                           meter_id: str | None = None, cursor: str | None = None, limit: int = 50,
                           tenant_scope: bool = False) -> dict:
        """Read-only, date-bounded Rental history. Tenant records are intersected with their own occupancy windows."""
        if not 1 <= limit <= 100:
            raise Invalid("History page size must be between 1 and 100.")
        from_date = _optional_date(start, "Start date")
        to_date = _optional_date(end, "End date")
        if from_date and to_date and from_date > to_date:
            raise Invalid("Start date must be on or before end date.")
        allowed_types = {"reading", "bill", "statement", "occupancy", "allocation", "audit", "subscription"}
        if record_type and record_type not in allowed_types:
            raise Invalid("Unsupported history record type.")
        if tenant_scope:
            membership = self._membership(pid, user.uid)
            occupancies = self.store.query(self._col(pid, "occupancies"), tenantUid=user.uid)
            if membership is None and not occupancies:
                raise NotFound("Property not found.")
            unit_ids = {o["unitId"] for o in occupancies}
            if membership and membership.get("unitId"):
                unit_ids.add(membership["unitId"])
            if unit_id and unit_id not in unit_ids:
                raise NotFound("History not found.")
        else:
            self._require(pid, user, MANAGERS)
            occupancies = self.store.query(self._col(pid, "occupancies"))
            unit_ids = {unit_id} if unit_id else None

        def in_range(value: str | None) -> bool:
            if not value:
                return False
            day = date.fromisoformat(value[:10])
            return not ((from_date and day < from_date) or (to_date and day > to_date))

        records: list[dict] = []
        if not record_type or record_type == "reading":
            meters = {m["id"]: m for m in self.store.query(self._col(pid, "meters"))}
            assignments = self.store.query(self._col(pid, "meterAssignments"))
            for reading in self.store.query(self._col(pid, "meterReadings"), **({"meterId": meter_id} if meter_id else {})):
                meter = meters.get(reading.get("meterId"), {})
                if tenant_scope:
                    if not reading.get("verified") or reading.get("status") != "active" or meter.get("kind") == "utility_shared":
                        continue
                    relevant = [a for a in assignments if a.get("meterId") == meter.get("id") and a.get("unitId") in unit_ids
                                and a["effectiveFrom"] <= reading["readingDate"] and (not a.get("effectiveTo") or reading["readingDate"] <= a["effectiveTo"])]
                    if not relevant:
                        continue
                    if not any(o["unitId"] == assignment["unitId"] and o["startDate"] <= reading["readingDate"]
                               and (not o.get("endDate") or reading["readingDate"] <= o["endDate"])
                               for assignment in relevant for o in occupancies):
                        continue
                elif unit_ids is not None and not any(a.get("meterId") == reading.get("meterId") and a.get("unitId") in unit_ids for a in assignments):
                    continue
                if not in_range(reading.get("readingDate")):
                    continue
                reading_assignment = next((a for a in assignments
                                           if a.get("meterId") == reading.get("meterId")
                                           and a.get("effectiveFrom", "") <= reading["readingDate"]
                                           and (not a.get("effectiveTo") or reading["readingDate"] <= a["effectiveTo"])
                                           and (not tenant_scope or a.get("unitId") in unit_ids)), None)
                records.append({"id": reading["id"], "type": "reading", "date": reading["readingDate"], "meterId": reading.get("meterId"),
                                "meterLabel": meter.get("label"), "unitId": reading_assignment.get("unitId") if reading_assignment else None,
                                "valueWh": reading.get("valueWh"), "intervalWh": reading.get("intervalWh"), "status": reading.get("status"),
                                "source": reading.get("source"), "verified": reading.get("verified"), "corrected": bool(reading.get("supersedesId")),
                                "createdAt": reading.get("createdAt")} )
        if not tenant_scope:
            if not record_type or record_type == "bill":
                for bill in self.store.query(self._col(pid, "utilityBills"), **({"meterId": meter_id} if meter_id else {})):
                    if in_range(bill.get("periodStart")):
                        records.append({"id": bill["id"], "type": "bill", "date": bill["periodStart"], **bill})
            if not record_type or record_type == "statement":
                statements = self.store.query(self._col(pid, "statements"), **({"unitId": unit_id} if unit_id else {}))
                for statement in statements:
                    if in_range(statement.get("periodStart")):
                        records.append({"id": statement["id"], "type": "statement", "date": statement["periodStart"], **statement})
            if not record_type or record_type == "occupancy":
                for occupancy in occupancies:
                    if (unit_ids is None or occupancy["unitId"] in unit_ids) and in_range(occupancy.get("startDate")):
                        records.append({"id": occupancy["id"], "type": "occupancy", "date": occupancy["startDate"], **occupancy})
            if not record_type or record_type == "allocation":
                for agreement in self.store.query(self._col(pid, "allocationAgreements"), **({"meterId": meter_id} if meter_id else {})):
                    if in_range(agreement.get("effectiveFrom")) and (unit_id is None or any(s["unitId"] == unit_id for s in agreement.get("shares", []))):
                        records.append({"id": agreement["id"], "type": "allocation", "date": agreement["effectiveFrom"], **agreement})
            if not record_type or record_type == "audit":
                for event in self.store.query(self._col(pid, "auditLogs")):
                    if in_range(event.get("at")):
                        records.append({"id": event["id"], "type": "audit", "date": event["at"], **event})
            if not record_type or record_type == "subscription":
                for event in self._subscription_events(pid):
                    if in_range(event.get("at")):
                        records.append({"id": event["id"], "type": "subscription", "date": event["at"], **event})
        else:
            own_statements = self.my_statements(user, pid)
            if not record_type or record_type == "statement":
                for statement in own_statements:
                    # Superseded and voided records were once published; preserve their original
                    # values in the tenant's audit history while drafts remain invisible.
                    if statement.get("status") in {"finalized", "superseded", "void"} and statement.get("finalizedAt") and in_range(statement.get("periodStart")):
                        records.append({"id": statement["id"], "type": "statement", "date": statement["periodStart"], **statement})
            if not record_type or record_type == "occupancy":
                for occupancy in occupancies:
                    if (unit_id is None or occupancy["unitId"] == unit_id) and in_range(occupancy.get("startDate")):
                        records.append({"id": occupancy["id"], "type": "occupancy", "date": occupancy["startDate"],
                                        "unitId": occupancy["unitId"], "startDate": occupancy["startDate"], "endDate": occupancy.get("endDate"),
                                        "current": not bool(occupancy.get("endDate"))})
            if not record_type or record_type == "allocation":
                member_unit_ids = unit_ids
                for agreement in self.store.query(self._col(pid, "allocationAgreements")):
                    mine = next((share for share in agreement.get("shares", []) if share["unitId"] in member_unit_ids and (unit_id is None or share["unitId"] == unit_id)), None)
                    if mine and in_range(agreement.get("effectiveFrom")):
                        meter = self.store.get(self._col(pid, "meters"), agreement["meterId"]) or {}
                        records.append({"id": agreement["id"], "type": "allocation", "date": agreement["effectiveFrom"], "meterLabel": meter.get("label"),
                                        "unitWeight": mine["weight"], "totalWeight": sum(s["weight"] for s in agreement["shares"]),
                                        "effectiveFrom": agreement["effectiveFrom"], "effectiveTo": agreement.get("effectiveTo"), "description": agreement.get("description")})

        records.sort(key=lambda item: (str(item.get("date") or ""), item["type"], item["id"]), reverse=True)
        offset = int(cursor) if cursor and cursor.isdigit() else 0
        if cursor and not cursor.isdigit():
            raise Invalid("Invalid history cursor.")
        page = records[offset:offset + limit]
        next_cursor = str(offset + limit) if offset + limit < len(records) else None
        return {"records": page, "nextCursor": next_cursor, "total": len(records),
                "filters": {"from": from_date.isoformat() if from_date else None, "to": to_date.isoformat() if to_date else None,
                            "type": record_type, "unitId": unit_id, "meterId": meter_id}}

    # ------------------------------------------------------------ subscription
    def get_subscription(self, user: AuthUser, pid: str) -> dict:
        self._require(pid, user, MANAGERS)
        history = [
            {k: e.get(k) for k in ("action", "fromStatus", "toStatus", "reason", "at", "periodEnd", "activationSource")}
            for e in self._subscription_events(pid)
        ]
        return {**self.entitlement(pid), "plan": self.config.plan_info(), "history": history[:50]}

    def _subscription_events(self, pid: str) -> list[dict]:
        return sorted(self.store.query("subscriptionEvents", propertyId=pid), key=lambda e: (e["at"], e.get("version", 0)), reverse=True)

    def _transition(self, pid: str, user: AuthUser, *, actor_role: str, action: str, current: dict,
                    to_status: str, changes: dict, event: dict, expected_version: int | None = None) -> dict:
        """Version-checked compare-and-swap + append-only event. Contradictory concurrent changes get 409."""
        stored_version = current.get("version")
        version = stored_version or 0
        if expected_version is not None and expected_version != version:
            raise Conflict("This subscription changed since you loaded it. Reload and review the latest status.")
        now = self._now()
        from_status = subs.effective_status(current, self.clock())
        applied = self.store.compare_and_update(
            "subscriptions", pid, {"version": stored_version, "status": current.get("status", subs.INACTIVE)},
            {**changes, "status": to_status, "version": version + 1, "lastAction": action, "updatedAt": now, "updatedBy": user.uid},
        )
        if not applied:
            raise Conflict("This subscription changed at the same time. Reload and review the latest status.")
        self.store.create("subscriptionEvents", _new_id(), {
            "propertyId": pid, "action": action, "fromStatus": from_status, "toStatus": to_status,
            "actorUid": user.uid, "actorRole": actor_role, "at": now, "version": version + 1,
            "reason": None, "activationSource": None, "paymentReference": None, "periodStart": None, "periodEnd": None,
            **event,
        })
        self._audit(pid, user, f"subscription.{action}", "subscription", pid, {"from": from_status, "to": to_status, "reason": event.get("reason")})
        return self.entitlement(pid)

    def request_activation(self, user: AuthUser, pid: str) -> dict:
        """Owner asks for activation or renewal. The request alone grants nothing."""
        self._require(pid, user, {OWNER})
        if (self.store.get("properties", pid) or {}).get("archivedAt"):
            raise Conflict("This property is archived and read-only.")
        current = self.store.get("subscriptions", pid) or {}
        status = subs.effective_status(current, self.clock())
        if status == subs.PENDING:
            raise Conflict("An activation request is already waiting for review.")
        if status not in subs.OWNER_REQUEST_FROM:
            raise Conflict(f"Activation cannot be requested while the subscription is {status.replace('_', ' ')}.")
        now = self._now()
        result = self._transition(pid, user, actor_role="owner", action="request", current=current, to_status=subs.PENDING,
                                  changes={"activationRequestedAt": now, "activationRequestedBy": user.uid, "statusReason": None},
                                  event={})
        admins_note = "SmartWatts staff will review it. No payment was taken in the app."
        self._notify(pid, [user.uid], "subscription.requested", "Activation requested", admins_note, page="rental-subscription")
        return result

    # ------------------------------------------------- platform administration
    @staticmethod
    def _require_platform_admin(user: AuthUser) -> None:
        # The claim comes from the verified Firebase ID token (set with the Admin SDK), never from the client.
        if not user.platform_admin or user.is_anonymous:
            raise Forbidden("Only SmartWatts platform administrators can manage subscriptions.")

    def platform_me(self, user: AuthUser) -> dict:
        return {"platformAdmin": bool(user.platform_admin and not user.is_anonymous)}

    def _platform_record(self, pid: str, doc: dict) -> dict:
        prop = self.store.get("properties", pid) or {}
        owner_uid = doc.get("ownerUid") or prop.get("ownerUid")
        owner = self.store.get("memberships", f"{pid}_{owner_uid}") if owner_uid else None
        entitlement = self.entitlement(pid)
        return {
            **entitlement,
            "propertyName": prop.get("name"),
            "ownerUid": owner_uid,
            "ownerEmail": (owner or {}).get("email"),
            "plan": doc.get("plan", "rentals"),
            "activationRequestedBy": doc.get("activationRequestedBy"),
            "decidedBy": doc.get("decidedBy"),
            "paymentReference": doc.get("paymentReference"),
            "createdAt": doc.get("createdAt"),
            "allowedActions": [] if entitlement["archived"] else subs.allowed_admin_actions(entitlement["status"]),
        }

    def platform_list_subscriptions(self, user: AuthUser, status: str | None = None) -> list[dict]:
        self._require_platform_admin(user)
        if status not in (None, "", *subs.STATUSES):
            raise Invalid("Unknown subscription status filter.")
        records = [self._platform_record(doc["id"], doc) for doc in self.store.query("subscriptions")[:500]]
        if status:
            records = [r for r in records if r["status"] == status]
        # Pending requests first (oldest first), then most recently updated.
        records.sort(key=lambda r: (r["status"] != subs.PENDING, r["lastRequestedAt"] or "" if r["status"] == subs.PENDING else "",
                                    "" if r["status"] == subs.PENDING else "~" + (r["updatedAt"] or r["createdAt"] or "")))
        return records[:200]

    def platform_get_subscription(self, user: AuthUser, pid: str) -> dict:
        self._require_platform_admin(user)
        doc = self.store.get("subscriptions", pid)
        if doc is None:
            raise NotFound("Subscription not found.")
        return {**self._platform_record(pid, doc), "events": self._subscription_events(pid)[:200]}

    def platform_subscription_action(self, user: AuthUser, pid: str, action: str, payload: dict) -> dict:
        self._require_platform_admin(user)
        rule = subs.ADMIN_TRANSITIONS.get(action)
        if rule is None:
            raise NotFound("Unknown subscription action.")
        current = self.store.get("subscriptions", pid)
        if current is None or self.store.get("properties", pid) is None:
            raise NotFound("Subscription not found.")
        if (self.store.get("properties", pid) or {}).get("archivedAt"):
            raise Conflict("This property is archived; its subscription cannot be changed.")
        if payload.get("confirm") is not True:
            raise Invalid("Confirm this subscription change.")
        expected = payload.get("expectedVersion")
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise Invalid("expectedVersion is required so concurrent changes are detected.")
        status = subs.effective_status(current, self.clock())
        if status not in rule.from_statuses:
            raise Conflict(f"Cannot {action} a subscription that is {status.replace('_', ' ')}.")

        source = payload.get("activationSource")
        reference = payload.get("paymentReference")
        reason = payload.get("reason")
        if rule.needs_source:
            if source not in subs.ACTIVATION_SOURCES:
                raise Invalid("Choose an activation source: external_payment_verified or administrative_grant.")
            if source == "external_payment_verified":
                reference = _clean_text(reference, "Payment reference", minimum=4, maximum=120)
            else:
                reference = None
                if not reason:
                    raise Invalid("An administrative grant needs a written reason.")
        else:
            source, reference = None, None
        if rule.needs_reason or reason:
            reason = _clean_text(reason, "Reason", minimum=subs.MIN_REASON, maximum=500)

        changes: dict = {"statusReason": reason if action not in {"approve", "reactivate", "extend"} else None}
        event: dict = {"reason": reason, "activationSource": source, "paymentReference": reference}
        now_dt = self.clock()
        if rule.period != "none":
            period_end = subs.parse_period_end(payload.get("periodEnd"))
            existing_end = current.get("currentPeriodEnd")
            if period_end is None and rule.period == "optional" and existing_end and datetime.fromisoformat(existing_end) > now_dt:
                period_end = datetime.fromisoformat(existing_end)  # reactivating a suspension keeps the paid period
            if period_end is None:
                raise Invalid("Enter the entitlement end date (YYYY-MM-DD).")
            period_start = now_dt if action != "extend" else datetime.fromisoformat(current.get("currentPeriodStart") or now_dt.isoformat())
            if period_end <= now_dt:
                raise Invalid("The entitlement end date must be in the future.")
            if period_end > subs.max_period_end(now_dt):
                raise Invalid(f"An entitlement period cannot extend more than {subs.MAX_PERIOD_DAYS} days from today.")
            if action == "extend" and existing_end and period_end <= datetime.fromisoformat(existing_end):
                raise Invalid("An extension must end after the current period end.")
            changes.update({"currentPeriodStart": period_start.isoformat(), "currentPeriodEnd": period_end.isoformat()})
            event.update({"periodStart": period_start.isoformat(), "periodEnd": period_end.isoformat()})
        if action in {"approve", "reactivate", "extend"}:
            changes.update({"activationSource": source, "paymentReference": reference, "decidedAt": self._now(), "decidedBy": user.uid,
                            "unitLimit": current.get("unitLimit", self.config.unit_limit_per_property)})
        elif action == "reject":
            changes.update({"decidedAt": self._now(), "decidedBy": user.uid})
        elif action == "expire":
            changes.update({"expiredAt": self._now()})

        result = self._transition(pid, user, actor_role="platform_admin", action=action, current=current,
                                  to_status=rule.to_status, changes=changes, event=event, expected_version=expected)
        owners = [m["uid"] for m in self.store.query("memberships", propertyId=pid, status="active") if m["role"] == OWNER]
        messages = {
            "approve": "Your Rentals subscription is now active.",
            "reject": f"Your activation request was not approved: {reason}",
            "suspend": f"Your Rentals subscription was suspended: {reason}",
            "reactivate": "Your Rentals subscription is active again.",
            "extend": "Your Rentals subscription period was extended.",
            "expire": "Your Rentals subscription has expired. Records stay readable; request renewal to continue.",
            "disable": f"Your Rentals subscription was disabled: {reason}",
            "restore": "Your Rentals subscription was restored to draft. You can request activation again.",
        }
        self._notify(pid, owners, f"subscription.{action}", "Subscription updated", messages[action], page="rental-subscription")
        return {**self._platform_record(pid, self.store.get("subscriptions", pid)), "entitlement": result}

    def list_audit_logs(self, user: AuthUser, pid: str) -> list[dict]:
        self._require(pid, user, MANAGERS)
        return sorted(self.store.query(self._col(pid, "auditLogs")), key=lambda log: log["at"], reverse=True)[:500]


__all__ = ["RentalService", "DomainError", "BillingError", "AlreadyExistsError"]
