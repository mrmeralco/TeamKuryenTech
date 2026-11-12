"""HTTP routes for SmartWatts Rentals (Tier 2) and account workspaces."""

from functools import lru_cache
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response

from ..auth import AuthUser, require_permanent_user, require_user
from .billing import BillingError
from .config import RentalsConfig
from .service import MAX_DOCUMENT_BYTES, DomainError, RentalService
from .store import blob_store_from_env, firestore_store_from_env

router = APIRouter(prefix="/api")
Payload = Annotated[dict[str, Any], Body()]


@lru_cache(maxsize=1)
def _default_service() -> RentalService | None:
    store = firestore_store_from_env()
    if store is None:
        return None
    return RentalService(store, RentalsConfig.from_env(), blobs=blob_store_from_env())


def get_service() -> RentalService:
    service = _default_service()
    if service is None:
        raise HTTPException(status_code=503, detail="SmartWatts Rentals storage is not configured on the server.")
    return service


Service = Annotated[RentalService, Depends(get_service)]
User = Annotated[AuthUser, Depends(require_user)]
Permanent = Annotated[AuthUser, Depends(require_permanent_user)]


def _run(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except DomainError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    except BillingError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get("/plans")
def plans():
    return RentalsConfig.from_env().plan_info()


@router.get("/account/workspaces")
def workspaces(user: User, service: Service):
    return _run(service.workspaces, user)


@router.post("/rentals/properties", status_code=201)
def create_property(user: Permanent, service: Service, payload: Payload):
    return _run(service.create_property, user, payload)


@router.get("/rentals/properties/{pid}")
def get_property(pid: str, user: Permanent, service: Service):
    return _run(service.get_property, user, pid)


@router.get("/rentals/properties/{pid}/analytics")
def analytics(pid: str, user: Permanent, service: Service):
    return _run(service.analytics, user, pid)


@router.get("/rentals/properties/{pid}/units")
def list_units(pid: str, user: Permanent, service: Service):
    return _run(service.list_units, user, pid)


@router.post("/rentals/properties/{pid}/units", status_code=201)
def create_unit(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.create_unit, user, pid, payload)


@router.get("/rentals/properties/{pid}/meters")
def list_meters(pid: str, user: Permanent, service: Service):
    return _run(service.list_meters, user, pid)


@router.post("/rentals/properties/{pid}/meters", status_code=201)
def create_meter(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.create_meter, user, pid, payload)


@router.post("/rentals/properties/{pid}/meter-assignments", status_code=201)
def create_assignment(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.create_assignment, user, pid, payload)


@router.post("/rentals/properties/{pid}/meter-assignments/{assignment_id}/end")
def end_assignment(pid: str, assignment_id: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.end_assignment, user, pid, assignment_id, payload)


@router.post("/rentals/properties/{pid}/allocation-agreements", status_code=201)
def create_agreement(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.create_agreement, user, pid, payload)


@router.get("/rentals/properties/{pid}/readings")
def list_readings(pid: str, user: Permanent, service: Service, meterId: str | None = None):
    return _run(service.list_readings, user, pid, meterId)


@router.post("/rentals/properties/{pid}/readings", status_code=201)
def record_reading(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.record_reading, user, pid, payload)


@router.post("/rentals/properties/{pid}/readings/{reading_id}/corrections", status_code=201)
def correct_reading(pid: str, reading_id: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.correct_reading, user, pid, reading_id, payload)


@router.get("/rentals/properties/{pid}/utility-bills")
def list_bills(pid: str, user: Permanent, service: Service):
    return _run(service.list_bills, user, pid)


@router.post("/rentals/properties/{pid}/utility-bills", status_code=201)
def create_bill(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.create_bill, user, pid, payload)


@router.put("/rentals/properties/{pid}/utility-bills/{bill_id}/document")
async def attach_bill_document(pid: str, bill_id: str, request: Request, user: Permanent, service: Service):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Bill documents must be 10 MB or smaller.")
    content = await request.body()
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    return _run(service.attach_bill_document, user, pid, bill_id, content, content_type)


@router.get("/rentals/properties/{pid}/utility-bills/{bill_id}/document")
def get_bill_document(pid: str, bill_id: str, user: Permanent, service: Service):
    content, content_type = _run(service.get_bill_document, user, pid, bill_id)
    return Response(content, media_type=content_type, headers={"Cache-Control": "private, no-store"})


@router.post("/rentals/properties/{pid}/utility-bills/{bill_id}/statements", status_code=201)
def generate_statements(pid: str, bill_id: str, user: Permanent, service: Service):
    return _run(service.generate_statements, user, pid, bill_id)


@router.get("/rentals/properties/{pid}/utility-bills/{bill_id}/reconciliation")
def reconciliation(pid: str, bill_id: str, user: Permanent, service: Service):
    return _run(service.get_reconciliation, user, pid, bill_id)


@router.get("/rentals/properties/{pid}/statements")
def list_statements(pid: str, user: Permanent, service: Service):
    return _run(service.list_statements, user, pid)


@router.post("/rentals/properties/{pid}/statements/{statement_id}/finalize")
def finalize_statement(pid: str, statement_id: str, user: Permanent, service: Service):
    return _run(service.finalize_statement, user, pid, statement_id)


@router.post("/rentals/properties/{pid}/statements/{statement_id}/void")
def void_statement(pid: str, statement_id: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.void_statement, user, pid, statement_id, payload)


@router.get("/rentals/properties/{pid}/invitations")
def list_invitations(pid: str, user: Permanent, service: Service):
    return _run(service.list_invitations, user, pid)


@router.post("/rentals/properties/{pid}/invitations", status_code=201)
def create_invitation(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.create_invitation, user, pid, payload)


@router.post("/rentals/properties/{pid}/invitations/{invitation_id}/revoke")
def revoke_invitation(pid: str, invitation_id: str, user: Permanent, service: Service):
    return _run(service.revoke_invitation, user, pid, invitation_id)


@router.post("/rentals/invitations/preview")
def preview_invitation(user: User, service: Service, payload: Payload):
    return _run(service.preview_invitation, user, payload.get("token"))


@router.post("/rentals/invitations/accept")
def accept_invitation(user: Permanent, service: Service, payload: Payload):
    return _run(service.redeem_invitation, user, payload.get("token"))


@router.get("/rentals/properties/{pid}/members")
def list_members(pid: str, user: Permanent, service: Service):
    return _run(service.list_members, user, pid)


@router.post("/rentals/properties/{pid}/members/{uid}/revoke")
def revoke_member(pid: str, uid: str, user: Permanent, service: Service):
    return _run(service.revoke_member, user, pid, uid)


@router.post("/rentals/properties/{pid}/occupancies/{occupancy_id}/end")
def end_occupancy(pid: str, occupancy_id: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.end_occupancy, user, pid, occupancy_id, payload)


@router.get("/rentals/properties/{pid}/me/unit")
def my_unit(pid: str, user: Permanent, service: Service):
    return _run(service.my_unit, user, pid)


@router.get("/rentals/properties/{pid}/me/statements")
def my_statements(pid: str, user: Permanent, service: Service):
    return _run(service.my_statements, user, pid)


@router.get("/rentals/properties/{pid}/me/meter-history")
def my_meter_history(pid: str, user: Permanent, service: Service):
    return _run(service.my_meter_history, user, pid)


@router.get("/rentals/properties/{pid}/subscription")
def get_subscription(pid: str, user: Permanent, service: Service):
    return _run(service.get_subscription, user, pid)


@router.post("/rentals/properties/{pid}/subscription/request-activation")
def request_activation(pid: str, user: Permanent, service: Service):
    return _run(service.request_activation, user, pid)


@router.post("/rentals/admin/properties/{pid}/subscription")
def platform_set_subscription(pid: str, user: Permanent, service: Service, payload: Payload):
    return _run(service.platform_set_subscription, user, pid, payload)


@router.get("/rentals/properties/{pid}/audit-logs")
def audit_logs(pid: str, user: Permanent, service: Service):
    return _run(service.list_audit_logs, user, pid)
