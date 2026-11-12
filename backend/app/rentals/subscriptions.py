"""SmartWatts Rentals subscription state machine (platform-controlled entitlements).

No payment is processed by SmartWatts. A platform administrator (verified ``platformAdmin``
Firebase custom claim) records an approval only after either:

* ``external_payment_verified`` — staff checked a payment made outside the app and record its
  reference (the app does NOT verify payments itself), or
* ``administrative_grant`` — an explicitly authorized free grant, with a written reason.

Every change is a version-checked compare-and-swap on ``subscriptions/{propertyId}`` (a Firestore
transaction in production) plus an append-only ``subscriptionEvents`` record.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

# Stored statuses. Legacy values: "trial" behaves like active; "canceled" behaves like disabled.
INACTIVE = "inactive"
PENDING = "pending_activation"
ACTIVE = "active"
SUSPENDED = "suspended"
EXPIRED = "expired"
DISABLED = "disabled"
STATUSES = {INACTIVE, PENDING, ACTIVE, SUSPENDED, EXPIRED, DISABLED}

ACTIVATION_SOURCES = {"external_payment_verified", "administrative_grant"}
MAX_PERIOD_DAYS = 400
# Date-only entitlement ends mean the END of that day in the Philippines (Asia/Manila, UTC+8, no DST).
MANILA = timezone(timedelta(hours=8), "Asia/Manila")
MIN_REASON = 10


@dataclass(frozen=True)
class Transition:
    from_statuses: frozenset[str]
    to_status: str
    needs_reason: bool
    needs_source: bool
    period: str  # "required", "optional", "none"


# Owner action: request. Everything else is platform-administrator only.
ADMIN_TRANSITIONS: dict[str, Transition] = {
    "approve": Transition(frozenset({PENDING}), ACTIVE, needs_reason=False, needs_source=True, period="required"),
    "reject": Transition(frozenset({PENDING}), INACTIVE, needs_reason=True, needs_source=False, period="none"),
    "suspend": Transition(frozenset({ACTIVE}), SUSPENDED, needs_reason=True, needs_source=False, period="none"),
    "reactivate": Transition(frozenset({SUSPENDED, EXPIRED}), ACTIVE, needs_reason=True, needs_source=True, period="optional"),
    "extend": Transition(frozenset({ACTIVE}), ACTIVE, needs_reason=True, needs_source=True, period="required"),
    "expire": Transition(frozenset({ACTIVE, SUSPENDED}), EXPIRED, needs_reason=True, needs_source=False, period="none"),
    "disable": Transition(frozenset({INACTIVE, PENDING, ACTIVE, SUSPENDED, EXPIRED}), DISABLED, needs_reason=True, needs_source=False, period="none"),
    "restore": Transition(frozenset({DISABLED}), INACTIVE, needs_reason=True, needs_source=False, period="none"),
}
OWNER_REQUEST_FROM = frozenset({INACTIVE, EXPIRED})


def stored_status(doc: dict) -> str:
    status = doc.get("status", INACTIVE)
    if status == "trial":
        return ACTIVE
    if status == "canceled":
        return DISABLED
    if status == INACTIVE and doc.get("activationRequestedAt") and not doc.get("decidedAt") and doc.get("version") is None:
        return PENDING  # legacy request recorded before explicit pending status existed
    return status if status in STATUSES else INACTIVE


def effective_status(doc: dict, now: datetime) -> str:
    """An active subscription whose period has ended is effectively expired, even before staff record it."""
    status = stored_status(doc)
    period_end = doc.get("currentPeriodEnd")
    if status == ACTIVE and period_end and datetime.fromisoformat(period_end) <= now:
        return EXPIRED
    return status


def parse_period_end(value: object) -> datetime | None:
    """Accepts YYYY-MM-DD (end of that day, Philippine time) or an ISO timestamp with a timezone."""
    if not isinstance(value, str) or not value:
        return None
    try:
        if len(value) == 10:
            return datetime.combine(date.fromisoformat(value), time(23, 59, 59), tzinfo=MANILA)
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def allowed_admin_actions(status: str) -> list[str]:
    return [name for name, rule in ADMIN_TRANSITIONS.items() if status in rule.from_statuses]


def owner_next_action(status: str) -> dict:
    return {
        INACTIVE: {"action": "request", "label": "Request activation"},
        EXPIRED: {"action": "request", "label": "Request renewal"},
        PENDING: {"action": None, "label": "Waiting for SmartWatts staff to review your request"},
        ACTIVE: {"action": None, "label": "Subscription active"},
        SUSPENDED: {"action": None, "label": "Contact SmartWatts support about the suspension"},
        DISABLED: {"action": None, "label": "Contact SmartWatts support"},
    }[status]


def max_period_end(start: datetime) -> datetime:
    return start + timedelta(days=MAX_PERIOD_DAYS)
