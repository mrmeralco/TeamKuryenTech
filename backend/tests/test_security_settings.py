import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.security.settings import MissingSecretError, is_production, load_security_settings

GOOD = {
    "SMARTWATTS_ENV": "production",
    "BOT_SECRET": "a" * 64,
    "ALLOWED_HOSTS": "smartwatts.example.com",
}


def test_production_detection():
    assert is_production({"SMARTWATTS_ENV": "production"})
    assert is_production({"VERCEL": "1", "VERCEL_ENV": "preview"})
    assert not is_production({"VERCEL": "1", "VERCEL_ENV": "development"})
    assert is_production({"K_SERVICE": "smartwatts-api"})
    assert not is_production({})


def test_complete_production_config_loads():
    settings = load_security_settings(GOOD)
    assert settings.production and settings.shield
    assert settings.allowed_hosts == ("smartwatts.example.com",)


@pytest.mark.parametrize("name", ["BOT_SECRET", "ALLOWED_HOSTS"])
def test_missing_required_value_refuses_to_start(name):
    env = {k: v for k, v in GOOD.items() if k != name}
    with pytest.raises(MissingSecretError, match=name):
        load_security_settings(env)


def test_redis_is_optional_but_must_be_complete():
    assert load_security_settings(GOOD).upstash_url == ""
    with pytest.raises(MissingSecretError, match="set together"):
        load_security_settings({**GOOD, "UPSTASH_REDIS_REST_URL": "https://example.upstash.io"})


def test_short_secret_refuses_to_start_and_says_how_to_generate():
    with pytest.raises(MissingSecretError) as error:
        load_security_settings({**GOOD, "BOT_SECRET": "short"})
    assert "shorter than 32" in str(error.value)
    assert "randomBytes(32)" in str(error.value)


def test_development_uses_random_secret_with_warning(caplog):
    first = load_security_settings({"SMARTWATTS_ENV": "development"})
    second = load_security_settings({"SMARTWATTS_ENV": "development"})
    assert len(first.bot_secret) == 64 and first.bot_secret != second.bot_secret
    assert not first.shield
    assert "BOT_SECRET is not set" in caplog.text


def test_bad_cron_hash_is_rejected():
    with pytest.raises(MissingSecretError):
        load_security_settings({"SMARTWATTS_ENV": "development", "CRON_API_KEY_SHA256": "not-a-hash"})


def test_app_startup_fails_in_production_without_secrets(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    env = {k: v for k, v in os.environ.items() if k not in GOOD and not k.startswith("UPSTASH")}
    # Present-but-empty values: load_dotenv() never overrides them with a developer's local .env file.
    env.update({"SMARTWATTS_ENV": "production", "PYTHONPATH": str(backend), "BOT_SECRET": "", "ALLOWED_HOSTS": ""})
    result = subprocess.run([sys.executable, "-c", "import app.main"], cwd=tmp_path,
                            env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode != 0
    assert "MissingSecretError" in result.stderr and "BOT_SECRET is missing" in result.stderr
