"""Runtime configuration.

Source of truth: the repository-root `.env` (SmartWatts/.env), resolved from this file's location so
it works regardless of the current working directory. Variables already set in the process
environment (shell, CI, hosting provider) take precedence over the file.

Secrets (GEMINI_API_KEY) live only on the server: they are never logged, never returned by any
endpoint, and must never use the VITE_ prefix.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("smartwatts.config")

ROOT_DIR = Path(__file__).resolve().parents[2]
ROOT_ENV_FILE = ROOT_DIR / ".env"

_PLACEHOLDER = re.compile(r"^(replace[_-]?with|your[_-])", re.IGNORECASE)


class ConfigError(ValueError):
    """Invalid configuration. Messages name the variable, never its value."""


def load_root_env(path: Path = ROOT_ENV_FILE) -> bool:
    """Load the root .env into os.environ without overriding existing process variables."""
    if not path.is_file():
        return False
    from dotenv import load_dotenv

    load_dotenv(path, override=False)
    return True


def _get(name: str) -> str | None:
    v = (os.getenv(name) or "").strip()
    return None if not v or _PLACEHOLDER.match(v) or v == "changeme" else v


def _int(name: str, default: int, lo: int, hi: int) -> int:
    raw = _get(name)
    if raw is None:
        return default
    try:
        v = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a whole number.") from None
    if not lo <= v <= hi:
        raise ConfigError(f"{name} must be between {lo} and {hi}.")
    return v


def _float(name: str, default: float, lo: float, hi: float) -> float:
    raw = _get(name)
    if raw is None:
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number.") from None
    if not lo <= v <= hi:
        raise ConfigError(f"{name} must be between {lo} and {hi}.")
    return v


DEFAULT_CORS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"


def _origins(name: str) -> list[str]:
    raw = _get(name) or DEFAULT_CORS
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    for o in origins:
        if o == "*":
            raise ConfigError(f"{name} must list explicit origins; '*' is not allowed.")
        if not re.fullmatch(r"https?://[A-Za-z0-9.\-]+(:\d+)?", o):
            raise ConfigError(f"{name} entries must look like https://example.com or http://localhost:5173 (no paths).")
    return origins


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str | None = field(default_factory=lambda: _get("GEMINI_API_KEY"))
    gemini_model: str = field(default_factory=lambda: _get("GEMINI_MODEL") or "gemini-2.5-flash")
    cors_origins: list[str] = field(default_factory=lambda: _origins("CORS_ORIGINS"))
    max_upload_bytes: int = field(default_factory=lambda: _int("MAX_UPLOAD_BYTES", 8 * 1024 * 1024, 100_000, 20 * 1024 * 1024))
    ocr_rate_per_minute: int = field(default_factory=lambda: _int("OCR_RATE_PER_MINUTE", 20, 1, 1000))
    advisor_rate_per_minute: int = field(default_factory=lambda: _int("ADVISOR_RATE_PER_MINUTE", 15, 1, 1000))
    ai_timeout_seconds: float = field(default_factory=lambda: _float("AI_TIMEOUT_SECONDS", 25.0, 1.0, 120.0))


def report(settings: Settings) -> list[str]:
    """Human-readable startup notes. Never includes secret values."""
    notes = [f"CORS origins: {', '.join(settings.cors_origins)}"]
    if settings.gemini_api_key:
        notes.append(f"Energy Advisor: enabled (model {settings.gemini_model}; key loaded, value hidden)")
    else:
        notes.append(
            f"Energy Advisor: DISABLED — GEMINI_API_KEY is not set in {ROOT_ENV_FILE} or the process environment. "
            "/api/advisor/chat will return 503 ai_unavailable; bill entry, calculator, simulator and plans still work."
        )
    leaked = [k for k in os.environ if k.startswith("VITE_") and re.search(r"GEMINI|SECRET|PRIVATE|PASSWORD|TOKEN", k)]
    if leaked:
        notes.append(f"WARNING: {', '.join(leaked)} use the VITE_ prefix and would be exposed to the browser. Rename them.")
    return notes


def get_settings() -> Settings:
    loaded = load_root_env()
    settings = Settings()
    log.info("config: root .env %s", "loaded" if loaded else f"not found at {ROOT_ENV_FILE} (using process environment/defaults)")
    for line in report(settings):
        log.info("config: %s", line)
    return settings
