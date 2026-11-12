"""Counters, strikes and bans for rate limiting (step 5).

- Rate-limit counters: fixed windows in memory, per instance (bounded: MAX_TRACKED keys).
- Strikes and bans: shared across instances through Firestore (collection `security_bans`, document id = SHA-256
  of the IP, so raw addresses are not stored). Writes happen only on abuse; ban checks are cached in memory for
  BAN_CACHE_SECONDS per IP. Add a Firestore TTL policy on the `expiresAt` field to delete old documents.
- Optional Redis: with UPSTASH_REDIS_REST_URL/TOKEN set, counters, strikes and bans all live in Upstash.
Without Firestore or Redis (local development, tests) everything stays in memory.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from collections import OrderedDict
from datetime import UTC, datetime, timedelta

import httpx

logger = logging.getLogger("smartwatts.security")

MAX_TRACKED = 50_000          # cap for every in-memory table
MAX_DISTINCT = 200            # per-key cap for distinct-URL sets (only "more than 150" matters)
STRIKES_TO_BAN = 3
BAN_SECONDS = 15 * 60
STRIKE_WINDOW_SECONDS = 15 * 60
BAN_CACHE_SECONDS = 30


def ip_key(ip: str) -> str:
    return hashlib.sha256(ip.encode()).hexdigest()[:32]


class _Bounded(OrderedDict):
    """Dict that drops its oldest entry when full, so many distinct IPs can't exhaust memory."""

    def put(self, key, value):
        if key in self:
            self.move_to_end(key)
        elif len(self) >= MAX_TRACKED:
            self.popitem(last=False)
        self[key] = value


class MemoryStore:
    def __init__(self) -> None:
        self._counters: _Bounded = _Bounded()
        self._sets: _Bounded = _Bounded()
        self._strikes: _Bounded = _Bounded()
        self._bans: _Bounded = _Bounded()

    async def hit(self, key: str, window: int) -> tuple[int, int]:
        """Counts one request in a fixed window. Returns (count, seconds until the window resets)."""
        now = time.monotonic()
        count, reset = self._counters.get(key, (0, 0.0))
        if reset <= now:
            count, reset = 0, now + window
        count += 1
        self._counters.put(key, (count, reset))
        return count, max(1, int(reset - now + 0.999))

    async def distinct(self, key: str, member: str, window: int) -> int:
        now = time.monotonic()
        members, reset = self._sets.get(key, (set(), 0.0))
        if reset <= now:
            members, reset = set(), now + window
        if len(members) < MAX_DISTINCT:
            members.add(member)
        self._sets.put(key, (members, reset))
        return len(members)

    async def ban_seconds(self, ip: str) -> int:
        until = self._bans.get(ip_key(ip), 0.0)
        return max(0, int(until - time.time() + 0.999))

    async def strike(self, ip: str) -> bool:
        """Records a strike. Returns True when this strike bans the IP."""
        key, now = ip_key(ip), time.time()
        count, reset = self._strikes.get(key, (0, 0.0))
        if reset <= now:
            count, reset = 0, now + STRIKE_WINDOW_SECONDS
        count += 1
        self._strikes.put(key, (count, reset))
        if count >= STRIKES_TO_BAN:
            self._bans.put(key, now + BAN_SECONDS)
            return True
        return False


class FirestoreBanStore(MemoryStore):
    """Memory counters; strikes and bans shared through Firestore."""

    def __init__(self, project_id: str) -> None:
        super().__init__()
        self._project_id = project_id
        self._db = None
        self._ban_cache: _Bounded = _Bounded()

    def _client(self):
        if self._db is None:
            from google.cloud import firestore
            self._db = firestore.Client(project=self._project_id)
        return self._db

    def _read_ban(self, key: str) -> float:
        doc = self._client().collection("security_bans").document(key).get()
        data = doc.to_dict() if doc.exists else None
        until = (data or {}).get("bannedUntil")
        return until.timestamp() if until else 0.0

    async def ban_seconds(self, ip: str) -> int:
        local = await super().ban_seconds(ip)
        if local:
            return local
        key, now = ip_key(ip), time.time()
        cached = self._ban_cache.get(key)
        if cached is None or cached[1] <= now:
            try:
                until = await asyncio.to_thread(self._read_ban, key)
            except Exception:  # Firestore unavailable: fail open, the per-instance limits still apply
                logger.warning("security: ban lookup failed", exc_info=True)
                until = 0.0
            cached = (until, now + BAN_CACHE_SECONDS)
            self._ban_cache.put(key, cached)
        return max(0, int(cached[0] - now + 0.999))

    def _write_strike(self, key: str) -> bool:
        from google.cloud import firestore
        now = datetime.now(UTC)
        bucket = int(now.timestamp()) // STRIKE_WINDOW_SECONDS
        ref = self._client().collection("security_bans").document(key)
        ref.set({"strikes": {str(bucket): firestore.Increment(1)},
                 "expiresAt": now + timedelta(seconds=BAN_SECONDS + STRIKE_WINDOW_SECONDS)}, merge=True)
        strikes = (ref.get().to_dict() or {}).get("strikes", {}).get(str(bucket), 0)
        if strikes >= STRIKES_TO_BAN:
            ref.set({"bannedUntil": now + timedelta(seconds=BAN_SECONDS)}, merge=True)
            return True
        return False

    async def strike(self, ip: str) -> bool:
        banned_here = await super().strike(ip)
        try:
            banned = await asyncio.to_thread(self._write_strike, ip_key(ip))
        except Exception:
            logger.warning("security: strike write failed", exc_info=True)
            banned = False
        if banned or banned_here:
            self._ban_cache.pop(ip_key(ip), None)
        return banned or banned_here


class UpstashStore:
    """Everything in Redis via the Upstash REST API (one pipeline round trip per call)."""

    def __init__(self, url: str, token: str) -> None:
        self._url, self._token = url, token
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(2.0))
        self._fallback = MemoryStore()

    async def _pipeline(self, *commands: list) -> list:
        response = await self._http.post(f"{self._url}/pipeline", json=list(commands),
                                          headers={"Authorization": f"Bearer {self._token}"})
        response.raise_for_status()
        return [item.get("result") for item in response.json()]

    async def hit(self, key: str, window: int) -> tuple[int, int]:
        try:
            count, _, ttl = await self._pipeline(["INCR", f"rl:{key}"], ["EXPIRE", f"rl:{key}", window, "NX"],
                                                 ["TTL", f"rl:{key}"])
            return int(count), max(1, int(ttl))
        except Exception:
            logger.warning("security: Upstash unavailable, using memory", exc_info=True)
            return await self._fallback.hit(key, window)

    async def distinct(self, key: str, member: str, window: int) -> int:
        try:
            _, _, size = await self._pipeline(["SADD", f"ds:{key}", member[:300]],
                                              ["EXPIRE", f"ds:{key}", window, "NX"], ["SCARD", f"ds:{key}"])
            return int(size)
        except Exception:
            return await self._fallback.distinct(key, member, window)

    async def ban_seconds(self, ip: str) -> int:
        try:
            (ttl,) = await self._pipeline(["TTL", f"ban:{ip_key(ip)}"])
            return max(0, int(ttl))
        except Exception:
            return await self._fallback.ban_seconds(ip)

    async def strike(self, ip: str) -> bool:
        key = ip_key(ip)
        try:
            count, _ = await self._pipeline(["INCR", f"strike:{key}"],
                                            ["EXPIRE", f"strike:{key}", STRIKE_WINDOW_SECONDS, "NX"])
            if int(count) >= STRIKES_TO_BAN:
                await self._pipeline(["SET", f"ban:{key}", "1", "EX", BAN_SECONDS])
                return True
            return False
        except Exception:
            return await self._fallback.strike(ip)


def store_from_settings(settings) -> MemoryStore | FirestoreBanStore | UpstashStore:
    if settings.upstash_url and settings.upstash_token:
        return UpstashStore(settings.upstash_url, settings.upstash_token)
    project = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if settings.production and project:
        return FirestoreBanStore(project)
    return MemoryStore()
