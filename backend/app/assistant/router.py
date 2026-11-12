"""POST /api/assistant/chat — the workspace-aware, data-grounded SmartWatts assistant."""

from __future__ import annotations

import os
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..auth import AuthUser, require_user
from ..rentals.router import _default_service
from ..rentals.service import DomainError
from . import harness
from .tools import AssistantTools

router = APIRouter(prefix="/api/assistant")
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MAX_MESSAGES = 12


class Message(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=2000)


class WorkspaceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["personal", "rental"] = "personal"
    # A UI selection only; the server verifies membership before using it.
    propertyId: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class BrowserState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    coinBalanceCents: int | None = Field(default=None, ge=0, le=10_000_000)
    monthlyTargetKwh: float | None = Field(default=None, ge=50, le=2000)


class AssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    language: str = Field(default="en", pattern=r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$")
    workspace: WorkspaceRef = Field(default_factory=WorkspaceRef)
    messages: list[Message] = Field(min_length=1, max_length=MAX_MESSAGES)
    browserState: BrowserState | None = None

    @model_validator(mode="after")
    def latest_from_user(self):
        if self.messages[-1].role != "user":
            raise ValueError("The latest chat message must be from the user.")
        return self


class FactOut(BaseModel):
    id: str
    text: str
    kind: str
    kindLabel: str
    source: str


class AssistantReply(BaseModel):
    reply: str
    mode: Literal["ai", "deterministic", "refusal"]
    contextLabel: str
    validated: bool
    facts: list[FactOut]
    assumptions: list[str]
    missing: list[str]
    sources: list[str]
    followUps: list[str]
    withheldFigures: list[str]
    # True only when the answer is backed by persisted records (facts), not just knowledge text.
    recordsUsed: bool
    retrieval: Literal["ok", "partial_error"]
    scopeHint: dict | None = None
    # Present only when SMARTWATTS_ASSISTANT_DEBUG=1 (development). Content-free.
    diagnostics: dict | None = None


def get_tools() -> AssistantTools:
    service = _default_service()
    return AssistantTools(service.store if service else None, service)


def get_llm():
    """Returns an async (system, messages) -> text function, or None to answer deterministically."""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None
    model = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

    async def generate(system: str, messages: list[dict]) -> str:
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["text"]}]} for m in messages],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 600},
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            response = await client.post(GEMINI_API_URL.format(model=model), headers={"x-goog-api-key": api_key}, json=payload)
        response.raise_for_status()
        parts = response.json()["candidates"][0]["content"]["parts"]
        text = next(p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str))
        if not text.strip():
            raise ValueError("empty reply")
        return text

    return generate


@router.post("/chat", response_model=AssistantReply)
async def assistant_chat(
    request: AssistantRequest,
    user: Annotated[AuthUser, Depends(require_user)],
    tools: Annotated[AssistantTools, Depends(get_tools)],
    llm=Depends(get_llm),
):
    try:
        harness.check_rate(user.uid)
    except harness.RateLimited as error:
        raise HTTPException(status_code=429, detail="Too many questions in a minute. Please wait a moment.") from error
    if request.workspace.type == "personal" and tools.store is None:
        raise HTTPException(status_code=503, detail="SmartWatts data storage is not configured on the server.")
    try:
        result = await harness.answer(
            tools, user, workspace=request.workspace.model_dump(), language=request.language,
            messages=[m.model_dump() for m in request.messages],
            browser_state=request.browserState.model_dump() if request.browserState else None, llm=llm,
        )
    except DomainError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    return AssistantReply(
        reply=result.reply, mode=result.mode, contextLabel=result.context_label, validated=result.validated,
        facts=[FactOut(**f.as_dict()) for f in result.facts], assumptions=result.assumptions, missing=result.missing,
        sources=sorted({f.source for f in result.facts} | {f"SmartWatts guide: {s.title}" for s in result.knowledge}),
        followUps=result.followups, withheldFigures=result.withheld,
        recordsUsed=bool(result.facts), retrieval=result.retrieval, scopeHint=result.scope_hint, diagnostics=result.diagnostics,
    )
