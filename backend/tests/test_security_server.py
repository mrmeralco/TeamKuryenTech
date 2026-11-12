import inspect
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import serve  # noqa: E402


def test_uvicorn_settings_are_valid_and_hardened():
    accepted = set(inspect.signature(uvicorn.Config).parameters)
    assert set(serve.UVICORN_SETTINGS) <= accepted
    assert serve.UVICORN_SETTINGS["timeout_keep_alive"] == 5
    assert serve.UVICORN_SETTINGS["server_header"] is False
    assert serve.UVICORN_SETTINGS["proxy_headers"] is False
