import logging
from pathlib import Path

import pytest

from app import config
from app.config import ConfigError, Settings, load_root_env, report

KEYS = ["GEMINI_API_KEY", "GEMINI_MODEL", "CORS_ORIGINS", "MAX_UPLOAD_BYTES", "OCR_RATE_PER_MINUTE", "ADVISOR_RATE_PER_MINUTE", "AI_TIMEOUT_SECONDS"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)


def write_env(tmp_path: Path, text: str) -> Path:
    p = tmp_path / ".env"
    p.write_text(text)
    return p


def test_root_env_path_is_repository_root():
    assert config.ROOT_ENV_FILE == Path(__file__).resolve().parents[2] / ".env"
    assert (config.ROOT_DIR / "frontend").is_dir() and (config.ROOT_DIR / "backend").is_dir()


def test_loads_values_from_env_file_independent_of_cwd(tmp_path, monkeypatch):
    env = write_env(tmp_path, "GEMINI_API_KEY=test-key-123456\nGEMINI_MODEL=gemini-test\nCORS_ORIGINS=https://smartwatts.example\n")
    monkeypatch.chdir("/")
    assert load_root_env(env) is True
    s = Settings()
    assert s.gemini_api_key == "test-key-123456" and s.gemini_model == "gemini-test"
    assert s.cors_origins == ["https://smartwatts.example"]


def test_process_environment_wins_over_file(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")  # e.g. e2e deliberately disables AI
    load_root_env(write_env(tmp_path, "GEMINI_API_KEY=from-file-123456\n"))
    assert Settings().gemini_api_key is None


def test_placeholders_and_missing_file_mean_unset(tmp_path):
    assert load_root_env(tmp_path / "nope.env") is False
    load_root_env(write_env(tmp_path, "GEMINI_API_KEY=replace_with_server_side_gemini_api_key\n"))
    s = Settings()
    assert s.gemini_api_key is None and s.gemini_model == "gemini-2.5-flash"
    assert "http://localhost:5173" in s.cors_origins


@pytest.mark.parametrize(
    "line,needle",
    [
        ("MAX_UPLOAD_BYTES=lots", "MAX_UPLOAD_BYTES must be a whole number"),
        ("OCR_RATE_PER_MINUTE=0", "OCR_RATE_PER_MINUTE must be between"),
        ("CORS_ORIGINS=*", "'*' is not allowed"),
        ("CORS_ORIGINS=http://localhost:5173/app", "no paths"),
        ("AI_TIMEOUT_SECONDS=abc", "AI_TIMEOUT_SECONDS must be a number"),
    ],
)
def test_invalid_values_fail_with_actionable_message_without_echoing_value(tmp_path, line, needle):
    load_root_env(write_env(tmp_path, line + "\n"))
    with pytest.raises(ConfigError) as e:
        Settings()
    assert needle in str(e.value)
    value = line.split("=", 1)[1]
    if len(value) >= 3:  # single characters like "0" or "*" naturally occur in the guidance text
        assert value not in str(e.value)


def test_report_never_contains_secret_and_explains_disabled_ai(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "super-secret-value-xyz")
    on = report(Settings())
    assert not any("super-secret-value-xyz" in n for n in on)
    assert any("enabled" in n and "value hidden" in n for n in on)
    monkeypatch.delenv("GEMINI_API_KEY")
    off = report(Settings())
    assert any("DISABLED" in n and "503" in n for n in off)


def test_report_warns_about_vite_prefixed_secret(monkeypatch):
    monkeypatch.setenv("VITE_GEMINI_API_KEY", "x")
    assert any("VITE_GEMINI_API_KEY" in n for n in report(Settings()))


def test_get_settings_logs_without_secret(monkeypatch, caplog):
    monkeypatch.setenv("GEMINI_API_KEY", "another-secret-987654")
    monkeypatch.setattr(config, "load_root_env", lambda *a, **k: False)
    with caplog.at_level(logging.INFO, logger="smartwatts.config"):
        s = config.get_settings()
    assert s.gemini_api_key == "another-secret-987654"
    assert "another-secret-987654" not in caplog.text
    assert "value hidden" in caplog.text
