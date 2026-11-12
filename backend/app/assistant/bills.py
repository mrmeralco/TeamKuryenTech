"""Canonical read model for saved Personal electricity bills (users/{uid}/bills).

This is an adapter over the EXISTING Firestore schema (see firestore.rules `validBill` and
src/lib/personal/store.ts) — no migration and no second bill collection:

    periodStart, periodEnd   YYYY-MM-DD billing period
    kwh                      billed consumption
    amountCentavos           "Total current charges" the user confirmed (this period's charges,
                             excluding any previous unpaid balance) — NOT a payment record
    source                   "ocr" (scanned on the device, then reviewed) | "manual" (typed)
    components, previousReading, presentReading   optional
    createdAt                server timestamp when the record was saved

Bill photos/PDFs are read on the user's device and are never uploaded, so there is no image
reference. A record only exists after the user reviews the figures, ticks the confirmation box,
and presses "Save bill"; an OCR preview alone is never persisted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

# Retrieval outcomes. Only RECORDS_FOUND may be described as "your saved bills".
RECORDS_FOUND = "records_found"
NO_RECORDS = "no_records"
UNREADABLE_ONLY = "unreadable_records"
RETRIEVAL_ERROR = "retrieval_error"


@dataclass
class SavedBill:
    id: str
    period_start: date
    period_end: date
    kwh: Decimal | None
    amount_centavos: int | None
    source: str
    saved_at: datetime | None

    @property
    def source_label(self) -> str:
        return ("scanned from your bill photo on your device and confirmed by you" if self.source == "ocr"
                else "typed in and confirmed by you")

    @property
    def period_label(self) -> str:
        return f"{self.period_start.isoformat()} to {self.period_end.isoformat()}"


@dataclass
class BillRetrieval:
    outcome: str
    bills: list[SavedBill] = field(default_factory=list)  # oldest period first
    unreadable: dict[str, int] = field(default_factory=dict)  # missing-field category -> count
    record_count: int = 0

    def latest_by_period(self) -> SavedBill | None:
        return self.bills[-1] if self.bills else None

    def previous_by_period(self) -> SavedBill | None:
        return self.bills[-2] if len(self.bills) >= 2 else None

    def latest_saved(self) -> SavedBill | None:
        dated = [b for b in self.bills if b.saved_at is not None]
        return max(dated, key=lambda b: b.saved_at) if dated else self.latest_by_period()


def _saved_at(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def normalize(doc: dict) -> tuple[SavedBill | None, str | None]:
    """Returns (bill, None) or (None, missing-field category). Never guesses a missing value."""
    try:
        start = date.fromisoformat(str(doc.get("periodStart")))
        end = date.fromisoformat(str(doc.get("periodEnd")))
    except ValueError:
        return None, "billing_period"
    amount = doc.get("amountCentavos")
    if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
        amount = None
    try:
        used = Decimal(str(doc.get("kwh"))) if doc.get("kwh") is not None else None
        if used is not None and used <= 0:
            used = None
    except (InvalidOperation, ValueError):
        used = None
    if amount is None and used is None:
        return None, "amount_and_kwh"
    source = doc.get("source") if doc.get("source") in {"ocr", "manual"} else "manual"
    return SavedBill(str(doc.get("id") or ""), start, end, used, amount, source, _saved_at(doc.get("createdAt"))), (
        None if amount is not None else "amount")


def retrieve_personal_bills(store, uid: str, limit: int = 48) -> BillRetrieval:
    """Reads ONLY users/{uid}/bills for the verified uid. Errors are reported, never turned into 'no bills'."""
    try:
        docs = store.query(f"users/{uid}/bills")[: limit * 2]
    except Exception:  # noqa: BLE001 - any storage failure is a retrieval error, not an empty history
        return BillRetrieval(RETRIEVAL_ERROR)
    bills, unreadable = [], {}
    for doc in docs:
        bill, problem = normalize(doc)
        if problem:
            unreadable[problem] = unreadable.get(problem, 0) + 1
        if bill is not None:
            bills.append(bill)
    bills.sort(key=lambda b: (b.period_end, b.saved_at.timestamp() if b.saved_at else 0.0))
    bills = bills[-limit:]
    if bills:
        outcome = RECORDS_FOUND
    elif docs:
        outcome = UNREADABLE_ONLY
    else:
        outcome = NO_RECORDS
    return BillRetrieval(outcome, bills, unreadable, len(docs))
