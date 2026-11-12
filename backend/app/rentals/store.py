"""Minimal document-store abstraction used by the Rentals service.

All SmartWatts Rentals data is written only by the backend (Firebase Admin
SDK). Firestore Security Rules deny direct client access to these
collections, so every read and write passes server-side authorization.
"""

from __future__ import annotations

import copy
import os
import threading
from typing import Any, Protocol


class AlreadyExistsError(Exception):
    pass


class DocumentStore(Protocol):
    def get(self, collection: str, doc_id: str) -> dict | None: ...
    def create(self, collection: str, doc_id: str, data: dict) -> None: ...
    def update(self, collection: str, doc_id: str, changes: dict) -> None: ...
    def compare_and_update(self, collection: str, doc_id: str, expected: dict, changes: dict) -> bool: ...
    def query(self, collection: str, **equals: Any) -> list[dict]: ...


class BlobStore(Protocol):
    def put(self, path: str, content: bytes, content_type: str) -> None: ...
    def get(self, path: str) -> tuple[bytes, str] | None: ...


def _strip_id(data: dict) -> dict:
    return {key: value for key, value in data.items() if key != "id"}


class InMemoryStore:
    """Thread-safe in-memory implementation used by tests and local demos."""

    def __init__(self) -> None:
        self._data: dict[str, dict[str, dict]] = {}
        self._lock = threading.Lock()

    def get(self, collection: str, doc_id: str) -> dict | None:
        with self._lock:
            doc = self._data.get(collection, {}).get(doc_id)
            return {**copy.deepcopy(doc), "id": doc_id} if doc is not None else None

    def create(self, collection: str, doc_id: str, data: dict) -> None:
        with self._lock:
            docs = self._data.setdefault(collection, {})
            if doc_id in docs:
                raise AlreadyExistsError(f"{collection}/{doc_id} already exists")
            docs[doc_id] = copy.deepcopy(_strip_id(data))

    def update(self, collection: str, doc_id: str, changes: dict) -> None:
        with self._lock:
            doc = self._data.get(collection, {}).get(doc_id)
            if doc is None:
                raise KeyError(f"{collection}/{doc_id} does not exist")
            doc.update(copy.deepcopy(_strip_id(changes)))

    def compare_and_update(self, collection: str, doc_id: str, expected: dict, changes: dict) -> bool:
        with self._lock:
            doc = self._data.get(collection, {}).get(doc_id)
            if doc is None or any(doc.get(key) != value for key, value in expected.items()):
                return False
            doc.update(copy.deepcopy(_strip_id(changes)))
            return True

    def query(self, collection: str, **equals: Any) -> list[dict]:
        with self._lock:
            return [
                {**copy.deepcopy(doc), "id": doc_id}
                for doc_id, doc in self._data.get(collection, {}).items()
                if all(doc.get(key) == value for key, value in equals.items())
            ]


class InMemoryBlobStore:
    def __init__(self) -> None:
        self._blobs: dict[str, tuple[bytes, str]] = {}

    def put(self, path: str, content: bytes, content_type: str) -> None:
        self._blobs[path] = (content, content_type)

    def get(self, path: str) -> tuple[bytes, str] | None:
        return self._blobs.get(path)


class FirestoreStore:
    """Firestore implementation (uses the emulator when FIRESTORE_EMULATOR_HOST is set)."""

    def __init__(self, client) -> None:
        self._db = client

    def _ref(self, collection: str, doc_id: str):
        return self._db.collection(collection).document(doc_id)

    def get(self, collection: str, doc_id: str) -> dict | None:
        snapshot = self._ref(collection, doc_id).get()
        return {**snapshot.to_dict(), "id": snapshot.id} if snapshot.exists else None

    def create(self, collection: str, doc_id: str, data: dict) -> None:
        from google.api_core.exceptions import AlreadyExists, Conflict

        try:
            self._ref(collection, doc_id).create(_strip_id(data))
        except (AlreadyExists, Conflict) as error:
            raise AlreadyExistsError(f"{collection}/{doc_id} already exists") from error

    def update(self, collection: str, doc_id: str, changes: dict) -> None:
        self._ref(collection, doc_id).update(_strip_id(changes))

    def compare_and_update(self, collection: str, doc_id: str, expected: dict, changes: dict) -> bool:
        from google.cloud import firestore

        ref = self._ref(collection, doc_id)

        @firestore.transactional
        def apply(transaction) -> bool:
            snapshot = ref.get(transaction=transaction)
            if not snapshot.exists:
                return False
            data = snapshot.to_dict()
            if any(data.get(key) != value for key, value in expected.items()):
                return False
            transaction.update(ref, _strip_id(changes))
            return True

        return apply(self._db.transaction())

    def query(self, collection: str, **equals: Any) -> list[dict]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        query = self._db.collection(collection)
        for key, value in equals.items():
            query = query.where(filter=FieldFilter(key, "==", value))
        return [{**snapshot.to_dict(), "id": snapshot.id} for snapshot in query.stream()]


class FirebaseStorageBlobStore:
    def __init__(self, bucket) -> None:
        self._bucket = bucket

    def put(self, path: str, content: bytes, content_type: str) -> None:
        self._bucket.blob(path).upload_from_string(content, content_type=content_type)

    def get(self, path: str) -> tuple[bytes, str] | None:
        blob = self._bucket.blob(path)
        if not blob.exists():
            return None
        return blob.download_as_bytes(), blob.content_type or "application/octet-stream"


def firestore_store_from_env() -> FirestoreStore | None:
    project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if not project_id:
        return None
    from google.cloud import firestore

    return FirestoreStore(firestore.Client(project=project_id))


def blob_store_from_env() -> FirebaseStorageBlobStore | None:
    bucket_name = os.getenv("FIREBASE_STORAGE_BUCKET", "").strip()
    project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if not bucket_name or not project_id:
        return None
    from google.cloud import storage

    return FirebaseStorageBlobStore(storage.Client(project=project_id).bucket(bucket_name))
