"""SmartWatts API.

Endpoints
  GET  /api/health          -> service + capability status (never returns secrets)
  POST /api/ocr/bill        -> multipart image -> suggested bill fields (user must confirm)
  POST /api/ocr/label       -> multipart image -> suggested wattage (user must confirm)
  POST /api/advisor/chat    -> grounded Energy Advisor answer, 503 when AI is unavailable
  POST /api/calc/compare    -> deterministic calculator (same spec as the frontend)

Error responses use {"detail": {"code": str, "message": str}}.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import advisor, energy, ocr
from .config import Settings, get_settings

log = logging.getLogger("smartwatts")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


def error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


class RateLimiter:
    """Small in-memory sliding-window limiter, per client IP and bucket."""

    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: tuple[str, str], limit: int, window: float = 60.0) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True


class UsageIn(BaseModel):
    wattage: float
    hoursPerDay: float
    days: float
    quantity: float


class CompareIn(BaseModel):
    baseline: UsageIn
    scenario: UsageIn
    rate: float | None = Field(default=None)


def create_app(settings: Settings | None = None, genai_client_factory: Callable[[str], object] | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="SmartWatts API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
    limiter = RateLimiter()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        fields = [".".join(str(p) for p in e["loc"][1:]) for e in exc.errors()][:10]
        return JSONResponse(
            status_code=422,
            content={"detail": {"code": "invalid_request", "message": "Some values are missing or invalid.", "fields": fields}},
        )

    def limit(bucket: str, per_minute: int):
        def dep(request: Request) -> None:
            ip = request.client.host if request.client else "unknown"
            if not limiter.check((bucket, ip), per_minute):
                raise error(429, "rate_limited", "Too many requests. Please wait a minute and try again.")

        return dep

    def make_client():
        if not settings.gemini_api_key:
            return None
        if genai_client_factory:
            return genai_client_factory(settings.gemini_api_key)
        from google import genai

        return genai.Client(api_key=settings.gemini_api_key)

    async def read_upload(file: UploadFile) -> bytes:
        if file.content_type not in {"image/jpeg", "image/png", "image/webp"}:
            raise error(415, "unsupported_type", "Please upload a JPEG, PNG or WebP photo.")
        data = await file.read(settings.max_upload_bytes + 1)
        await file.close()
        return data

    @app.get("/api/health")
    def health():
        return {
            "status": "ok",
            "ocrAvailable": shutil.which("tesseract") is not None,
            "aiAvailable": bool(settings.gemini_api_key),
        }

    @app.post("/api/ocr/bill", dependencies=[Depends(limit("ocr", settings.ocr_rate_per_minute))])
    async def ocr_bill(file: UploadFile = File(...)):
        data = await read_upload(file)
        try:
            img = ocr.load_image(data, settings.max_upload_bytes)
            read = ocr.read_text(img)
        except ocr.ImageRejected as exc:
            raise error(422, "bad_image", str(exc))
        except ocr.OcrUnavailable as exc:
            raise error(503, "ocr_unavailable", str(exc))
        finally:
            del data  # drop the photo bytes as soon as possible
        fields = ocr.parse_bill_text(read.text)
        low = read.confidence is None or read.confidence < ocr.LOW_CONFIDENCE
        if low:
            fields.warnings.append("The photo was hard to read. Check every value carefully.")
        log.info("ocr_bill parsed fields=%s", [k for k in ("periodStart", "kwh", "totalAmountPhp") if getattr(fields, k) is not None])
        return {
            "fields": {k: getattr(fields, k) for k in ("periodStart", "periodEnd", "kwh", "totalAmountPhp", "charges")},
            "fieldStatus": ocr.field_status(fields),
            "confidence": read.confidence,
            "lowConfidence": low,
            "warnings": fields.warnings,
        }

    @app.post("/api/ocr/label", dependencies=[Depends(limit("ocr", settings.ocr_rate_per_minute))])
    async def ocr_label(file: UploadFile = File(...)):
        data = await read_upload(file)
        try:
            img = ocr.load_image(data, settings.max_upload_bytes)
            read = ocr.read_text(img)
        except ocr.ImageRejected as exc:
            raise error(422, "bad_image", str(exc))
        except ocr.OcrUnavailable as exc:
            raise error(503, "ocr_unavailable", str(exc))
        finally:
            del data
        result = ocr.parse_label_text(read.text)
        low = read.confidence is None or read.confidence < ocr.LOW_CONFIDENCE
        return {**result, "confidence": read.confidence, "lowConfidence": low}

    @app.post("/api/advisor/chat", dependencies=[Depends(limit("advisor", settings.advisor_rate_per_minute))])
    def advisor_chat(req: advisor.AdvisorRequest):
        client = make_client()
        if client is None:
            raise error(503, "ai_unavailable", "The Energy Advisor is not configured on this server (no AI provider key).")
        try:
            return advisor.ask(req, client, settings.gemini_model, settings.ai_timeout_seconds)
        except advisor.AdvisorUnavailable as exc:
            log.warning("advisor provider failure: %s", exc)
            raise error(503, "ai_unavailable", "The Energy Advisor could not reach the AI service. Please try again later.")

    @app.post("/api/calc/compare")
    def calc_compare(body: CompareIn):
        def u(x: UsageIn) -> energy.Usage:
            q = int(x.quantity) if x.quantity == int(x.quantity) else x.quantity
            return energy.Usage(x.wattage, x.hoursPerDay, x.days, q)  # type: ignore[arg-type]

        try:
            return energy.compare(u(body.baseline), u(body.scenario), body.rate)
        except energy.CalcError as exc:
            raise error(422, "invalid_calculation_input", str(exc))

    return app


app = create_app()
