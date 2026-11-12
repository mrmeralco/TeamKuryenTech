from __future__ import annotations

import copy
import datetime
import json
import logging
import os
import re
import threading
import time
from typing import Any, Callable
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from app.auth import AuthUser
from app.email_otp import send_email as raw_send_email
from app.notifications.models import (
    BillSavedNotificationRequest,
    NotificationPreferences,
    OutboxItem,
    OutboxStatus,
    SchedulerRunResponse,
)
from app.rentals.store import DocumentStore, InMemoryStore

logger = logging.getLogger("smartwatts.notifications")

MANILA_TZ = ZoneInfo("Asia/Manila")
EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def get_manila_today() -> datetime.date:
    return datetime.datetime.now(MANILA_TZ).date()


class NotificationService:
    def __init__(
        self,
        store: DocumentStore | None = None,
        email_sender: Callable[[str, str, dict[str, Any]], None] | None = None,
    ) -> None:
        self.store = store or InMemoryStore()
        self.email_sender = email_sender or raw_send_email
        self._lock = threading.Lock()
        self._personal_bills_registry: dict[str, list[dict[str, Any]]] = {}

    # ---------------------------------------------------------------- preferences
    def get_preferences(self, uid: str) -> NotificationPreferences:
        doc = self.store.get("notification_preferences", uid)
        if not doc:
            return NotificationPreferences()
        try:
            return NotificationPreferences(**doc)
        except Exception:
            return NotificationPreferences()

    def update_preferences(self, uid: str, prefs: NotificationPreferences) -> NotificationPreferences:
        data = prefs.model_dump()
        existing = self.store.get("notification_preferences", uid)
        if existing:
            self.store.update("notification_preferences", uid, data)
        else:
            self.store.create("notification_preferences", uid, data)
        return prefs

    # ---------------------------------------------------------------- outbox
    def _generate_outbox_id(self) -> str:
        return f"msg_{int(time.time() * 1000)}_{os.urandom(4).hex()}"

    def has_active_message(self, idempotency_key: str) -> bool:
        with self._lock:
            existing = self.store.query("notifications_outbox", idempotency_key=idempotency_key)
            return any(item.get("status") in {"sent", "sending", "pending"} for item in existing)

    def queue_message(
        self,
        idempotency_key: str,
        to_email: str,
        recipient_uid: str,
        template: str,
        template_data: dict[str, Any],
        recipient_name: str | None = None,
        workspace: str = "personal",
        property_id: str | None = None,
        max_attempts: int = 5,
        now: float | None = None,
    ) -> OutboxItem | None:
        now_ts = time.time() if now is None else now

        if not to_email or not EMAIL_REGEX.match(to_email.strip()):
            logger.warning("Rejecting outbox queue for invalid email: %s", to_email)
            return None

        with self._lock:
            # Check idempotency across existing items
            existing = self.store.query("notifications_outbox", idempotency_key=idempotency_key)
            for item in existing:
                if item.get("status") in {"sent", "sending", "pending"}:
                    logger.info("Message with idempotency_key '%s' already exists (status=%s). Skipping duplicate.", idempotency_key, item.get("status"))
                    return OutboxItem(**item)

            outbox_id = self._generate_outbox_id()
            item = OutboxItem(
                id=outbox_id,
                idempotency_key=idempotency_key,
                to_email=to_email.strip(),
                recipient_name=recipient_name,
                recipient_uid=recipient_uid,
                template=template,
                template_data=template_data,
                status="pending",
                attempts=0,
                max_attempts=max_attempts,
                next_attempt_at=now_ts,
                created_at=now_ts,
                sent_at=None,
                last_error=None,
                workspace="rentals" if workspace == "rentals" else "personal",
                property_id=property_id,
            )
            self.store.create("notifications_outbox", outbox_id, item.model_dump())
            logger.info("Queued outbox item %s (%s) for %s", outbox_id, template, to_email)
            return item

    def process_outbox(self, limit: int = 20, now: float | None = None) -> tuple[int, int, int]:
        """Processes up to `limit` due outbox items. Returns (processed, sent, failed)."""
        now_ts = time.time() if now is None else now
        items = self.store.query("notifications_outbox")
        due_items = [
            OutboxItem(**item)
            for item in items
            if item.get("status") in {"pending", "retryable_failure"}
            and item.get("next_attempt_at", 0) <= now_ts
        ][:limit]

        processed = 0
        sent = 0
        failed = 0

        for item in due_items:
            processed += 1
            # Mark sending
            try:
                self.store.update("notifications_outbox", item.id, {"status": "sending"})
            except Exception:
                continue

            try:
                self.email_sender(item.template, item.to_email, item.template_data)
                self.store.update(
                    "notifications_outbox",
                    item.id,
                    {"status": "sent", "sent_at": time.time(), "last_error": None},
                )
                sent += 1
                logger.info("Outbox message %s successfully sent to %s", item.id, item.to_email)
            except Exception as exc:
                failed += 1
                attempts = item.attempts + 1
                err_msg = str(exc)
                logger.warning("Outbox message %s failed attempt %d: %s", item.id, attempts, err_msg)

                # Permanent failure conditions
                is_permanent = attempts >= item.max_attempts or not EMAIL_REGEX.match(item.to_email)
                if is_permanent:
                    self.store.update(
                        "notifications_outbox",
                        item.id,
                        {
                            "status": "permanent_failure",
                            "attempts": attempts,
                            "last_error": err_msg,
                        },
                    )
                else:
                    # Exponential backoff: 30 * 2^(attempts-1) seconds
                    delay = 30 * (2 ** (attempts - 1))
                    self.store.update(
                        "notifications_outbox",
                        item.id,
                        {
                            "status": "retryable_failure",
                            "attempts": attempts,
                            "next_attempt_at": now_ts + delay,
                            "last_error": err_msg,
                        },
                    )

        return processed, sent, failed

    # ---------------------------------------------------------------- bill saved confirmation
    def handle_bill_saved(
        self,
        user: AuthUser,
        req: BillSavedNotificationRequest,
        save_date_str: str | None = None,
        register_for_scheduler: bool = True,
    ) -> OutboxItem | None:
        """Queues a bill saved confirmation email after persistence."""
        if not user.email:
            logger.info("Cannot queue bill saved confirmation: user %s has no verified email", user.uid)
            return None

        # Check preferences
        prefs = self.get_preferences(user.uid)
        if not prefs.bill_saved_confirmations:
            logger.info("Bill saved confirmations disabled by user %s", user.uid)
            return None

        idempotency_key = f"bill_saved:{req.workspaceType.lower()}:{user.uid}:{req.billId}"

        now_manila = datetime.datetime.now(MANILA_TZ)
        formatted_save_date = save_date_str or now_manila.strftime("%B %d, %Y")

        data = {
            "name": getattr(user, "name", "") or "",
            "periodStart": req.periodStart or "",
            "periodEnd": req.periodEnd or "",
            "amountPesos": req.amountPesos,
            "kwh": req.kwh,
            "dueDate": req.dueDate,
            "saveDate": formatted_save_date,
            "workspaceType": req.workspaceType,
            "propertyName": req.propertyName or "",
        }

        # Keep in personal bills registry for due reminder evaluation
        if register_for_scheduler and req.workspaceType == "Personal":
            self.register_personal_bill(user.uid, req.model_dump())

        return self.queue_message(
            idempotency_key=idempotency_key,
            to_email=user.email,
            recipient_name=getattr(user, "name", None),
            recipient_uid=user.uid,
            template="bill-saved",
            template_data=data,
            workspace=req.workspaceType.lower(),
            property_id=req.propertyId,
        )

    # ---------------------------------------------------------------- personal bill registry (for scheduler)
    def register_personal_bill(self, uid: str, bill: dict[str, Any]) -> None:
        with self._lock:
            bills = self._personal_bills_registry.setdefault(uid, [])
            # Replace if bill with same id exists, else append
            b_id = bill.get("billId") or bill.get("id")
            self._personal_bills_registry[uid] = [
                b for b in bills if (b.get("billId") or b.get("id")) != b_id
            ] + [bill]

    def get_user_personal_bills(self, uid: str) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._personal_bills_registry.get(uid, []))

    # ---------------------------------------------------------------- tenant statement published
    def handle_statement_published(
        self,
        statement: dict[str, Any],
        pid: str,
        property_name: str,
        unit_name: str,
        tenant_email: str,
        tenant_name: str | None = None,
    ) -> OutboxItem | None:
        """Called when a draft statement is finalized and published for a tenant."""
        if statement.get("status") != "finalized":
            logger.warning("Cannot send statement published email for unfinalized statement %s", statement.get("id"))
            return None

        tenant_uid = statement.get("tenantUid")
        if not tenant_uid or not tenant_email:
            logger.info("Statement %s has no tenantUid or tenantEmail. Skipping email.", statement.get("id"))
            return None

        prefs = self.get_preferences(tenant_uid)
        if not prefs.rental_statements:
            logger.info("Rental statement notifications disabled by tenant %s", tenant_uid)
            return None

        idempotency_key = f"statement_published:{statement['id']}"

        amount_pesos = None
        if "totalCentavos" in statement and statement["totalCentavos"] is not None:
            amount_pesos = round(statement["totalCentavos"] / 100.0, 2)

        data = {
            "name": tenant_name or "",
            "periodStart": statement.get("periodStart", ""),
            "periodEnd": statement.get("periodEnd", ""),
            "amountPesos": amount_pesos,
            "dueDate": statement.get("dueDate"),
            "propertyName": property_name,
            "unitName": unit_name,
        }

        return self.queue_message(
            idempotency_key=idempotency_key,
            to_email=tenant_email,
            recipient_name=tenant_name,
            recipient_uid=tenant_uid,
            template="statement-published",
            template_data=data,
            workspace="rentals",
            property_id=pid,
        )

    # ---------------------------------------------------------------- recurring due reminder scheduler
    def evaluate_due_reminders(
        self,
        target_date: datetime.date | None = None,
        dry_run: bool = False,
    ) -> tuple[int, int]:
        """Evaluates upcoming bill due dates in Asia/Manila. Returns (evaluated_count, queued_count)."""
        today = target_date or get_manila_today()
        evaluated_count = 0
        queued_count = 0

        # 1. Evaluate Personal bills
        with self._lock:
            registry_copy = copy.deepcopy(self._personal_bills_registry)

        for uid, bills in registry_copy.items():
            prefs = self.get_preferences(uid)
            if not prefs.bill_due_reminders:
                continue

            for bill in bills:
                due_date_str = bill.get("dueDate")
                if not due_date_str:
                    continue

                # Skip if already marked paid
                if bill.get("paid") or bill.get("status") == "paid" or bill.get("paidAt"):
                    continue

                try:
                    due_date = datetime.date.fromisoformat(due_date_str.strip())
                except ValueError:
                    continue

                evaluated_count += 1
                days_until_due = (due_date - today).days

                if days_until_due in prefs.reminder_intervals and days_until_due >= 0:
                    bill_id = bill.get("billId") or bill.get("id") or "bill"
                    idempotency_key = f"due_reminder:personal:{bill_id}:{days_until_due}:{due_date_str}"
                    if self.has_active_message(idempotency_key):
                        continue

                    days_text = "today" if days_until_due == 0 else f"{days_until_due} days"

                    if not dry_run:
                        # Fetch recipient email
                        user_email = bill.get("userEmail") or bill.get("email")
                        if not user_email:
                            continue

                        data = {
                            "name": bill.get("userName") or "",
                            "periodStart": bill.get("periodStart", ""),
                            "periodEnd": bill.get("periodEnd", ""),
                            "amountPesos": bill.get("amountPesos"),
                            "kwh": bill.get("kwh"),
                            "dueDate": due_date_str,
                            "daysText": days_text,
                            "workspaceType": "Personal",
                        }

                        res = self.queue_message(
                            idempotency_key=idempotency_key,
                            to_email=user_email,
                            recipient_name=bill.get("userName"),
                            recipient_uid=uid,
                            template="bill-due-reminder",
                            template_data=data,
                            workspace="personal",
                        )
                        if res:
                            queued_count += 1
                    else:
                        queued_count += 1

        return evaluated_count, queued_count

    def run_scheduler(self, target_date_str: str | None = None, dry_run: bool = False) -> SchedulerRunResponse:
        today = get_manila_today()
        if target_date_str:
            try:
                today = datetime.date.fromisoformat(target_date_str.strip())
            except ValueError as err:
                raise HTTPException(status_code=400, detail="Invalid target_date format. Use YYYY-MM-DD.") from err

        eval_count, queued_count = self.evaluate_due_reminders(target_date=today, dry_run=dry_run)

        processed = 0
        sent = 0
        failed = 0
        if not dry_run:
            processed, sent, failed = self.process_outbox()

        return SchedulerRunResponse(
            evaluated_date=today.isoformat(),
            reminders_evaluated=eval_count,
            reminders_queued=queued_count,
            outbox_processed=processed,
            outbox_sent=sent,
            outbox_failed=failed,
        )


# Singleton instance used by the FastAPI app
notification_service = NotificationService()
