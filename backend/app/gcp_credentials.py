"""Google Cloud credentials for serverless hosts (Vercel) that have no credentials file or metadata server.

Firestore, Cloud Storage and the Firebase Admin SDK use Application Default Credentials (ADC). Locally ADC comes
from `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS (a file path). A Vercel function
has neither, so the credential JSON can be supplied as an environment variable instead:

    GOOGLE_APPLICATION_CREDENTIALS_JSON   the JSON itself, or the same JSON base64-encoded

At startup it is validated and written to a private (0600) temporary file, and GOOGLE_APPLICATION_CREDENTIALS
points at it, so every Google client library picks it up unchanged. Both a service-account key and a Workload
Identity Federation config ("external_account") are accepted. An explicit GOOGLE_APPLICATION_CREDENTIALS wins.

Errors never include the value. Without the variable nothing changes (Firestore-backed routes answer 503).
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import tempfile
from typing import MutableMapping

logger = logging.getLogger("smartwatts.credentials")

ENV_JSON = "GOOGLE_APPLICATION_CREDENTIALS_JSON"
ACCEPTED_TYPES = {"service_account", "external_account"}


class CredentialsConfigError(RuntimeError):
    """The credential variable is present but unusable. The message never contains the value."""


def _decode(raw: str) -> dict:
    text = raw
    if not raw.lstrip().startswith("{"):
        try:
            text = base64.b64decode(raw, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            raise CredentialsConfigError(f"{ENV_JSON} is neither JSON nor base64-encoded JSON.") from None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise CredentialsConfigError(f"{ENV_JSON} is not valid JSON.") from None
    if not isinstance(data, dict) or data.get("type") not in ACCEPTED_TYPES:
        raise CredentialsConfigError(f"{ENV_JSON} must be a service-account key or an external_account config.")
    if data["type"] == "service_account" and not all(data.get(k) for k in ("client_email", "private_key")):
        raise CredentialsConfigError(f"{ENV_JSON} is missing client_email or private_key.")
    return data


def install_credentials_from_env(env: MutableMapping[str, str] | None = None) -> str:
    """Returns "explicit-file", "absent" or "installed". Raises CredentialsConfigError when unusable."""
    env = os.environ if env is None else env
    raw = env.get(ENV_JSON, "").strip()
    if env.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip():
        if raw:
            logger.warning("%s ignored: GOOGLE_APPLICATION_CREDENTIALS is already set.", ENV_JSON)
        return "explicit-file"
    if not raw:
        return "absent"

    data = _decode(raw)
    project = env.get("FIREBASE_PROJECT_ID", "").strip()
    if project and data.get("project_id") and data["project_id"] != project:
        raise CredentialsConfigError(f"{ENV_JSON} belongs to a different project than FIREBASE_PROJECT_ID.")

    fd, path = tempfile.mkstemp(prefix="smartwatts-gcp-", suffix=".json")  # created 0600 by mkstemp
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    env["GOOGLE_APPLICATION_CREDENTIALS"] = path
    logger.info("Google credentials loaded from %s (type=%s).", ENV_JSON, data["type"])
    return "installed"
