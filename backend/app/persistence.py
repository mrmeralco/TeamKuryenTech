"""Where server-side state that must survive restarts and be shared by every instance is kept.

Serverless / autoscaled hosts (Cloud Run behind Cloudflare, Vercel functions) run several short-lived instances
with no writable shared disk, so in-memory dictionaries and local JSON files lose data or disagree between
instances. In production that state lives in Firestore (the same Admin-SDK client and project the Rentals service
uses). Locally and in tests it stays in memory, so development never writes to the production project by accident.

    SMARTWATTS_PERSISTENCE=firestore   force Firestore (e.g. local runs against the Firestore emulator)
    SMARTWATTS_PERSISTENCE=memory      force memory (tests, demos)
    unset                              Firestore in production (security.settings.is_production), else memory

Firestore needs FIREBASE_PROJECT_ID; without it memory is used and a warning is logged in production.
"""

from __future__ import annotations

import logging
import os
import threading

from .rentals.store import DocumentStore, firestore_store_from_env
from .security.settings import is_production

logger = logging.getLogger("smartwatts.persistence")

_lock = threading.Lock()
_cached: tuple[bool, DocumentStore | None] = (False, None)


def wants_firestore(env=None) -> bool:
    env = os.environ if env is None else env
    mode = env.get("SMARTWATTS_PERSISTENCE", "").strip().lower()
    if mode in {"firestore", "memory"}:
        return mode == "firestore"
    return is_production(env)


def shared_document_store() -> DocumentStore | None:
    """The Firestore document store when durable state is wanted and configured, else None (use memory)."""
    global _cached
    if _cached[0]:
        return _cached[1]
    with _lock:
        if _cached[0]:
            return _cached[1]
        store = None
        if wants_firestore():
            store = firestore_store_from_env()
            if store is None:
                logger.warning("Durable state requested but FIREBASE_PROJECT_ID is not set: using memory "
                               "(notification outbox, email codes and verified accounts will not persist).")
        _cached = (True, store)
        return store
