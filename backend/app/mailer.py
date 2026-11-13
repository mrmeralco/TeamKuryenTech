"""Sends SmartWatts emails over SMTP (Gmail app password) from Python.

This used to shell out to `node mailer/send.mjs`, but on Vercel the FastAPI function only bundles
`backend/` and has no Node binary, so every email failed. Python's smtplib needs neither.

Environment: SMTP_USER, SMTP_PASSWORD (spaces ignored), optional SMTP_FROM_NAME, SMTP_HOST
(default smtp.gmail.com), SMTP_PORT (default 465 = implicit TLS; 587 = STARTTLS) and APP_URL
(links in the emails; on Vercel it defaults to the production URL).
"""

from __future__ import annotations

import os
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path

from .mail_templates import build

LOGO = Path(__file__).resolve().parent / "assets" / "logo-day.png"
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
SMTP_TIMEOUT_SECONDS = 20


class MailerError(Exception):
    def __init__(self, message: str, *, auth: bool = False, config: bool = False) -> None:
        super().__init__(message)
        self.auth = auth
        self.config = config


def app_url() -> str:
    configured = os.getenv("APP_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    production = os.getenv("VERCEL_PROJECT_PRODUCTION_URL", "").strip()
    if production:
        return f"https://{production}"
    return "http://localhost:5173"


def compose(template: str, to: str, data: dict) -> EmailMessage:
    user = os.getenv("SMTP_USER", "").strip()
    mail = build(template, data, app_url())
    message = EmailMessage()
    message["Subject"] = mail["subject"]
    message["From"] = formataddr((os.getenv("SMTP_FROM_NAME", "").strip() or "SmartWatts", user))
    message["To"] = to
    message["Message-ID"] = make_msgid(domain=user.split("@")[-1] if "@" in user else None)
    message.set_content(mail["text"])
    message.add_alternative(mail["html"], subtype="html")
    if LOGO.exists():
        html_part = message.get_payload()[-1]
        html_part.add_related(LOGO.read_bytes(), maintype="image", subtype="png", cid="<smartwatts-logo>",
                              filename="smartwatts.png")
    return message


def send(template: str, to: str, data: dict) -> None:
    """Sends one email. Raises MailerError on any failure."""
    if not to or not EMAIL_RE.match(to):
        raise MailerError("A valid recipient address is required.")
    user = os.getenv("SMTP_USER", "").strip()
    # Gmail shows app passwords in groups of 4 ("abcd efgh ..."); the spaces are not part of it.
    password = re.sub(r"\s+", "", os.getenv("SMTP_PASSWORD", ""))
    if not user or not password:
        raise MailerError("SMTP_USER / SMTP_PASSWORD are not set.", config=True)
    host = os.getenv("SMTP_HOST", "").strip() or "smtp.gmail.com"
    port = int(os.getenv("SMTP_PORT", "").strip() or 465)
    message = compose(template, to, data)
    context = ssl.create_default_context()
    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_SECONDS, context=context)
        else:
            server = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_SECONDS)
        with server:
            if port != 465:
                server.starttls(context=context)
            server.login(user, password)
            server.send_message(message)
    except smtplib.SMTPAuthenticationError as error:
        raise MailerError("The email server rejected the login.", auth=True) from error
    except (smtplib.SMTPException, OSError) as error:
        raise MailerError(f"SMTP error: {error}") from error
