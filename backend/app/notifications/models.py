from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


class NotificationPreferences(BaseModel):
    bill_saved_confirmations: bool = Field(default=True, description="Send email confirmation when a bill is saved")
    bill_due_reminders: bool = Field(default=True, description="Send email reminders when bill due date approaches")
    reminder_intervals: list[int] = Field(default_factory=lambda: [7, 3, 0], description="Days before due date to remind (e.g. 7, 3, 0)")
    rental_statements: bool = Field(default=True, description="Send email notification when new tenant statement is published")


class BillSavedNotificationRequest(BaseModel):
    billId: str
    periodStart: str | None = None
    periodEnd: str | None = None
    amountPesos: float | None = None
    kwh: float | None = None
    dueDate: str | None = None
    billDate: str | None = None
    workspaceType: Literal["Personal", "Rentals"] = "Personal"
    propertyName: str | None = None
    propertyId: str | None = None


OutboxStatus = Literal["pending", "sending", "sent", "retryable_failure", "permanent_failure"]


class OutboxItem(BaseModel):
    id: str
    idempotency_key: str
    to_email: str
    recipient_name: str | None = None
    recipient_uid: str
    template: str
    template_data: dict[str, Any]
    status: OutboxStatus = "pending"
    attempts: int = 0
    max_attempts: int = 5
    next_attempt_at: float
    created_at: float
    sent_at: float | None = None
    last_error: str | None = None
    workspace: Literal["personal", "rentals"] = "personal"
    property_id: str | None = None


class SchedulerRunRequest(BaseModel):
    target_date: str | None = Field(default=None, description="Optional target date in YYYY-MM-DD (Asia/Manila). Defaults to current Manila date.")
    dry_run: bool = Field(default=False, description="If true, evaluates reminders without queuing outbox messages")


class SchedulerRunResponse(BaseModel):
    evaluated_date: str
    reminders_evaluated: int
    reminders_queued: int
    outbox_processed: int
    outbox_sent: int
    outbox_failed: int
