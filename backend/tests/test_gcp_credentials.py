import base64
import json
import os
import stat

import pytest

from app.gcp_credentials import CredentialsConfigError, install_credentials_from_env

SECRET = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n"
KEY = {"type": "service_account", "project_id": "demo-smartwatts", "client_email": "x@demo.iam.gserviceaccount.com",
       "private_key": SECRET}


def test_absent_changes_nothing():
    env = {}
    assert install_credentials_from_env(env) == "absent"
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in env


def test_explicit_file_wins():
    env = {"GOOGLE_APPLICATION_CREDENTIALS": "/x.json", "GOOGLE_APPLICATION_CREDENTIALS_JSON": json.dumps(KEY)}
    assert install_credentials_from_env(env) == "explicit-file"
    assert env["GOOGLE_APPLICATION_CREDENTIALS"] == "/x.json"


@pytest.mark.parametrize("encode", [json.dumps, lambda d: base64.b64encode(json.dumps(d).encode()).decode()])
def test_installs_private_file(encode):
    env = {"GOOGLE_APPLICATION_CREDENTIALS_JSON": encode(KEY), "FIREBASE_PROJECT_ID": "demo-smartwatts"}
    assert install_credentials_from_env(env) == "installed"
    path = env["GOOGLE_APPLICATION_CREDENTIALS"]
    try:
        assert json.load(open(path)) == KEY
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    finally:
        os.remove(path)


@pytest.mark.parametrize("raw,env_extra", [
    ('{"type": "service_account", "private_key": "' + "S3CR3T" + '"', {}),          # truncated JSON
    ("S3CR3T-not-base64!!", {}),
    (json.dumps({"type": "authorized_user", "refresh_token": "S3CR3T"}), {}),
    (json.dumps({**KEY, "client_email": ""}), {}),
    (json.dumps({**KEY, "private_key": "S3CR3T"}), {"FIREBASE_PROJECT_ID": "smartwatts-other"}),
])
def test_unusable_values_fail_without_echoing_them(raw, env_extra):
    env = {"GOOGLE_APPLICATION_CREDENTIALS_JSON": raw, **env_extra}
    with pytest.raises(CredentialsConfigError) as error:
        install_credentials_from_env(env)
    message = str(error.value)
    assert "S3CR3T" not in message and "PRIVATE KEY" not in message
    assert error.value.__cause__ is None and (error.value.__context__ is None or error.value.__suppress_context__)
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in env
