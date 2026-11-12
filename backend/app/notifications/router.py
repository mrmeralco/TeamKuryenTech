from __future__ import annotations

import logging
from typing import Any
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.auth import AuthUser, require_operator, require_user
from app.notifications.models import (
    BillSavedNotificationRequest,
    NotificationPreferences,
    OutboxItem,
    SchedulerRunRequest,
    SchedulerRunResponse,
)
from app.notifications.service import notification_service

logger = logging.getLogger("smartwatts.notifications.router")

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("/preferences", response_model=NotificationPreferences)
def get_preferences(user: AuthUser = Depends(require_user)) -> NotificationPreferences:
    return notification_service.get_preferences(user.uid)


@router.put("/preferences", response_model=NotificationPreferences)
def update_preferences(
    prefs: NotificationPreferences,
    user: AuthUser = Depends(require_user),
) -> NotificationPreferences:
    return notification_service.update_preferences(user.uid, prefs)


@router.post("/bill-saved", status_code=status.HTTP_202_ACCEPTED)
def notify_bill_saved(
    req: BillSavedNotificationRequest,
    user: AuthUser = Depends(require_user),
) -> dict[str, Any]:
    if not user.email:
        return {"status": "skipped", "reason": "User has no verified email"}

    # Include email and user name in bill payload for due reminder registration
    bill_dict = req.model_dump()
    bill_dict["userEmail"] = user.email
    bill_dict["userName"] = getattr(user, "name", None) or ""

    notification_service.register_personal_bill(user.uid, bill_dict)

    item = notification_service.handle_bill_saved(user, req)
    if not item:
        return {"status": "skipped", "reason": "Preferences disabled or invalid recipient"}

    # Best-effort immediate outbox processing in background
    try:
        notification_service.process_outbox(limit=5)
    except Exception as exc:
        logger.warning("Background outbox processing encountered an issue: %s", exc)

    return {"status": "queued", "outboxId": item.id, "idempotencyKey": item.idempotency_key}


@router.post("/scheduler/run", response_model=SchedulerRunResponse)
def trigger_scheduler(
    req: SchedulerRunRequest = SchedulerRunRequest(),
    _operator: AuthUser | None = Depends(require_operator),
) -> SchedulerRunResponse:
    """Evaluates upcoming due reminders in Asia/Manila (UTC+8) and flushes due outbox items."""
    return notification_service.run_scheduler(target_date_str=req.target_date, dry_run=req.dry_run)


@router.get("/outbox", response_model=list[OutboxItem])
def list_outbox(
    workspace: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    user: AuthUser = Depends(require_user),
) -> list[OutboxItem]:
    all_items = notification_service.store.query("notifications_outbox")
    results: list[OutboxItem] = []
    for raw in all_items:
        # Normal users only see their own outbox items; admin or owner can see workspace
        if not user.platform_admin and raw.get("recipient_uid") != user.uid:
            continue
        if workspace and raw.get("workspace") != workspace:
            continue
        if status_filter and raw.get("status") != status_filter:
            continue
        try:
            results.append(OutboxItem(**raw))
        except Exception:
            continue
    return results


@router.post("/outbox/process")
def process_outbox_queue(_operator: AuthUser | None = Depends(require_operator)) -> dict[str, int]:
    processed, sent, failed = notification_service.process_outbox()
    return {"processed": processed, "sent": sent, "failed": failed}
