"""get_firebase_app() must be safe when the first requests arrive concurrently."""

import threading

import firebase_admin
from google.auth.exceptions import DefaultCredentialsError

from app import auth


def test_concurrent_first_requests_initialize_firebase_once(monkeypatch):
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "demo-concurrency")

    def no_adc():
        raise DefaultCredentialsError("no ADC in tests")

    monkeypatch.setattr(auth.google.auth, "default", no_adc)
    try:
        firebase_admin.delete_app(firebase_admin.get_app())
    except ValueError:
        pass
    start = threading.Barrier(8)
    apps, errors = [], []

    def worker():
        start.wait()
        try:
            apps.append(auth.get_firebase_app())
        except Exception as error:  # noqa: BLE001 - surface any failure
            errors.append(error)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    try:
        assert errors == []
        assert len({id(app) for app in apps}) == 1
    finally:
        firebase_admin.delete_app(firebase_admin.get_app())
