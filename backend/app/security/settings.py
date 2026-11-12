"""Security settings read from the environment, validated once at startup.

Production (SMARTWATTS_ENV=production, a Vercel production/preview deployment, or Cloud Run) refuses to
start when a required secret is missing or too short. In development a missing BOT_SECRET is replaced by a
random per-process value and a warning is logged, so the app still runs locally.

No secret has a fallback value in code.
"""

from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from typing import Mapping

logger = logging.getLogger("smartwatts.security")

MIN_SECRET_LENGTH = 32
GENERATE_HINT = "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""

# Secrets SmartWatts creates itself: must be present and at least MIN_SECRET_LENGTH characters in production.
GENERATED_SECRETS = ("BOT_SECRET",)
# Non-secret settings production cannot run safely without.
# (No Redis is required: rate-limit counters live in memory per instance, strikes and bans are shared through
# Firestore. UPSTASH_REDIS_REST_URL/TOKEN are optional and, when both are set, are used for everything.)
REQUIRED_SETTINGS = ("ALLOWED_HOSTS",)


class MissingSecretError(RuntimeError):
    """Raised at startup when production configuration is incomplete."""


def is_production(env: Mapping[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    if env.get("SMARTWATTS_ENV", "").strip().lower() == "production":
        return True
    if env.get("SMARTWATTS_ENV", "").strip().lower() in {"development", "test"}:
        return False
    if env.get("VERCEL") and env.get("VERCEL_ENV", "production").strip().lower() != "development":
        return True
    return bool(env.get("K_SERVICE"))  # Google Cloud Run


def _csv(value: str | None) -> tuple[str, ...]:
    return tuple(part.strip().lower() for part in (value or "").split(",") if part.strip())


@dataclass(frozen=True)
class SecuritySettings:
    production: bool
    bot_secret: bytes
    allowed_hosts: tuple[str, ...]
    upstash_url: str
    upstash_token: str
    # SHA-256 (hex) of the key a scheduler / cron job sends in the x-api-key header. Empty = no key accepted.
    cron_key_sha256: str
    # Browser challenge + API cookie requirement. Always on in production; opt-in elsewhere (tests, local checks).
    shield: bool
    # Per-IP rate limits. Always on in production; opt-in elsewhere (SMARTWATTS_RATE_LIMITS=1).
    rate_limits: bool
    attack_mode_forced: bool
    # Header the hosting platform sets with the real client IP (never a raw client-supplied X-Forwarded-For).
    client_ip_header: str


def _problem(name: str, reason: str) -> str:
    return f"{name} {reason}. Generate a value with: {GENERATE_HINT}"


def load_security_settings(env: Mapping[str, str] | None = None) -> SecuritySettings:
    """Reads and validates the security settings. Raises MissingSecretError in production when incomplete."""
    env = os.environ if env is None else env
    production = is_production(env)
    problems: list[str] = []

    if production:
        for name in GENERATED_SECRETS:
            value = env.get(name, "").strip()
            if not value:
                problems.append(_problem(name, "is missing"))
            elif len(value) < MIN_SECRET_LENGTH:
                problems.append(_problem(name, f"is shorter than {MIN_SECRET_LENGTH} characters"))
        for name in REQUIRED_SETTINGS:
            if not env.get(name, "").strip():
                problems.append(f"{name} is missing (see .env.example).")
        if bool(env.get("UPSTASH_REDIS_REST_URL", "").strip()) != bool(env.get("UPSTASH_REDIS_REST_TOKEN", "").strip()):
            problems.append("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together (or both left empty).")
        if problems:
            raise MissingSecretError("Refusing to start in production:\n  - " + "\n  - ".join(problems))

    bot_secret = env.get("BOT_SECRET", "").strip()
    if not bot_secret:
        bot_secret = secrets.token_hex(32)
        logger.warning("BOT_SECRET is not set: using a random per-process value (development only). "
                       "Browser-check cookies will not survive a restart. Generate one with: %s", GENERATE_HINT)

    cron_hash = env.get("CRON_API_KEY_SHA256", "").strip().lower()
    if cron_hash and (len(cron_hash) != 64 or any(c not in "0123456789abcdef" for c in cron_hash)):
        raise MissingSecretError("CRON_API_KEY_SHA256 must be the 64-character hex SHA-256 of the cron key.")

    def flag(name: str) -> bool:
        value = env.get(name, "").strip().lower()
        return production if value == "" else value in {"1", "true", "on", "yes"}

    shield = flag("SMARTWATTS_SHIELD")
    default_ip_header = "x-vercel-forwarded-for" if env.get("VERCEL") else ""

    # The deployment's own Vercel URLs (system env vars) are always accepted, so preview deployments keep working.
    vercel_hosts = _csv(",".join(env.get(name, "") for name in
                                 ("VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL")))
    allowed_hosts = tuple(dict.fromkeys(_csv(env.get("ALLOWED_HOSTS")) + vercel_hosts))

    return SecuritySettings(
        production=production,
        bot_secret=bot_secret.encode(),
        allowed_hosts=allowed_hosts,
        upstash_url=env.get("UPSTASH_REDIS_REST_URL", "").strip().rstrip("/"),
        upstash_token=env.get("UPSTASH_REDIS_REST_TOKEN", "").strip(),
        cron_key_sha256=cron_hash,
        shield=shield,
        rate_limits=flag("SMARTWATTS_RATE_LIMITS"),
        attack_mode_forced=env.get("ATTACK_MODE", "").strip() == "1",
        client_ip_header=(env.get("TRUSTED_CLIENT_IP_HEADER", "").strip().lower() or default_ip_header),
    )
