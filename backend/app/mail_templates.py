"""SmartWatts email templates (Python port of mailer/templates.mjs).

Table-based HTML so the emails render in Gmail, Outlook and phones. The logo is attached inline by
app.mailer and referenced as cid:smartwatts-logo. Keep this file and mailer/templates.mjs in step.
"""

from __future__ import annotations

import datetime
import html as _html
from typing import Any, Callable

FONT = "Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
HEAD = "'Inter Tight',Inter,'Segoe UI',Helvetica,Arial,sans-serif"


def esc(value: Any) -> str:
    return _html.escape("" if value is None else str(value), quote=True)


def first_name(name: Any) -> str:
    parts = str(name or "").strip().split()
    return parts[0] if parts else ""


def _has(value: Any) -> bool:
    return value is not None and value != ""


def _pesos(value: Any) -> str:
    return f"₱{float(value):,.2f}"


def _kwh(value: Any) -> str:
    return f"{float(value):,.1f} kWh"


def layout(*, preheader: str, title: str, body: str, app_url: str) -> str:
    year = datetime.date.today().year
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>{esc(title)}</title></head>
<body style="margin:0;padding:0;background:#F4F2ED;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">{esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2ED">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td align="center" style="padding:0 0 20px">
      <a href="{esc(app_url)}" style="text-decoration:none"><img src="cid:smartwatts-logo" alt="SmartWatts" height="56" style="display:block;height:56px;width:auto;border:0"></a>
    </td></tr>
    <tr><td style="background:#FFFFFF;border:1px solid #E6E3DD;border-radius:24px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:6px;line-height:6px;font-size:0;background:#FF7B00;border-radius:24px 24px 0 0">&nbsp;</td></tr>
        <tr><td style="padding:36px 36px 8px;font-family:{FONT};color:#0E0E0E">{body}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E0E0E;border-radius:18px">
        <tr>
          <td width="33%" align="center" style="padding:18px 8px;font-family:{FONT}"><div style="font-family:{HEAD};font-size:20px;font-weight:800;color:#FAFAF7">&#8369;0</div><div style="font-size:12px;color:#A9A6A0;margin-top:2px">hardware to install</div></td>
          <td width="34%" align="center" style="padding:18px 8px;border-left:1px solid #2A2926;border-right:1px solid #2A2926;font-family:{FONT}"><div style="font-family:{HEAD};font-size:20px;font-weight:800;color:#FF9A3D">8-item</div><div style="font-size:12px;color:#A9A6A0;margin-top:2px">official Meralco formula</div></td>
          <td width="33%" align="center" style="padding:18px 8px;font-family:{FONT}"><div style="font-family:{HEAD};font-size:20px;font-weight:800;color:#FAFAF7">11</div><div style="font-size:12px;color:#A9A6A0;margin-top:2px">languages</div></td>
        </tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:24px 16px 8px;font-family:{FONT};font-size:12px;line-height:1.7;color:#8A8A85">
      &#128737;&#65039; Data Privacy Act compliant &middot; Photos deleted after scanning<br>
      &copy; {year} SmartWatts &middot; Privacy-first electricity savings for Meralco-served homes &amp; rentals.<br>
      SmartWatts is not affiliated with or endorsed by Meralco.
    </td></tr>
  </table>
</td></tr></table>
</body></html>"""


def button(href: str, label: str) -> str:
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0"><tr><td style="background:#FF7B00;border-radius:12px">\n'
            f'<a href="{esc(href)}" style="display:inline-block;padding:15px 28px;font-family:{FONT};font-size:16px;font-weight:700;color:#0E0E0E;text-decoration:none">{esc(label)}</a></td></tr></table>')


def notice(inner_html: str) -> str:
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 28px"><tr>\n'
            f'<td style="background:#FFF4E8;border:1px solid #F6DFC6;border-radius:14px;padding:14px 16px;font-family:{FONT};font-size:13px;line-height:1.6;color:#3D3D3A">{inner_html}</td></tr></table>')


def _pill(label: str) -> str:
    return f'<div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#FFF4E8;font-size:12px;font-weight:700;letter-spacing:.08em;color:#B85400">{esc(label)}</div>'


def _hi(name: Any) -> str:
    return f"Hi {esc(first_name(name))}," if first_name(name) else "Hi there,"


def _code_boxes(code: str) -> str:
    cells = "".join(
        f'<td align="center" style="width:46px;height:58px;background:#FFFFFF;border:1.5px solid #FFB36B;border-radius:12px;font-family:{HEAD};font-size:28px;font-weight:800;color:#0E0E0E">{esc(d)}</td><td style="width:8px;font-size:0">&nbsp;</td>'
        for d in str(code))
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;background:#F7F6F2;border:1px solid #E6E3DD;border-radius:18px"><tr><td style="padding:18px 10px 18px 18px">'
            f'<table role="presentation" cellpadding="0" cellspacing="0"><tr>{cells}</tr></table></td></tr></table>')


def _detail_row(label: str, value: str) -> str:
    return (f'<tr><td style="padding:10px 0;border-top:1px solid #EEECE7;font-family:{FONT};font-size:13px;color:#706E6B">{esc(label)}</td>'
            f'<td align="right" style="padding:10px 0;border-top:1px solid #EEECE7;font-family:{HEAD};font-size:14px;font-weight:700;color:#0E0E0E">{esc(value)}</td></tr>')


def _details(rows: list[str]) -> str:
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FBFBFA;border:1px solid #E6E3DD;border-radius:16px;padding:6px 18px">'
            f'{"".join(rows)}</table>')


def _h1(text: str, size: int = 30) -> str:
    return f'<h1 style="margin:16px 0 10px;font-family:{HEAD};font-size:{size}px;line-height:1.1;font-weight:800;letter-spacing:-.03em">{text}</h1>'


# --------------------------------------------------------------------------- templates
def verification_email(*, code: str, name: Any = None, minutes: int = 10, app_url: str, **_: Any) -> dict:
    hi = _hi(name)
    body = (_pill("EMAIL VERIFICATION") + _h1("Verify your email")
            + f'<p style="margin:0;font-size:16px;line-height:1.6;color:#3D3D3A">{hi}<br>Enter this code to finish setting up your SmartWatts account.</p>'
            + _code_boxes(code)
            + f'<p style="margin:0;font-size:14px;color:#5B5B57">This code expires in <b style="color:#0E0E0E">{minutes} minutes</b>.</p>'
            + notice('&#128274; <b style="color:#0E0E0E">Never share this code.</b> SmartWatts will never ask for it by phone, chat or email. If you didn’t try to sign in, you can safely ignore this email.'))
    return {
        "subject": f"{code} is your SmartWatts verification code",
        "text": f"{hi}\n\nYour SmartWatts verification code is: {code}\n\nIt expires in {minutes} minutes. Never share this code with anyone.\nIf you didn't try to sign in, ignore this email.\n\n— SmartWatts",
        "html": layout(preheader=f"Your code is {code}. It expires in {minutes} minutes.", title="Verify your email", body=body, app_url=app_url),
    }


def password_reset_email(*, code: str, name: Any = None, minutes: int = 10, app_url: str, **_: Any) -> dict:
    hi = _hi(name)
    body = (_pill("PASSWORD RESET") + _h1("Reset your password")
            + f'<p style="margin:0;font-size:16px;line-height:1.6;color:#3D3D3A">{hi}<br>Enter this code on the SmartWatts reset page to choose a new password.</p>'
            + _code_boxes(code)
            + f'<p style="margin:0 0 18px;font-size:14px;color:#5B5B57">This code expires in <b style="color:#0E0E0E">{minutes} minutes</b>.</p>'
            + button(f"{app_url}/forgot-password", "Go to reset page →")
            + notice('&#128274; <b style="color:#0E0E0E">Didn’t ask for this?</b> You can safely ignore this email — your password stays the same. Never share this code.'))
    return {
        "subject": f"{code} is your SmartWatts password reset code",
        "text": f"{hi}\n\nYour SmartWatts password reset code is: {code}\n\nIt expires in {minutes} minutes. Enter it at {app_url}/forgot-password\nIf you didn't ask for this, ignore this email.\n\n— SmartWatts",
        "html": layout(preheader=f"Your password reset code is {code}.", title="Reset your password", body=body, app_url=app_url),
    }


def welcome_email(*, name: Any = None, app_url: str, **_: Any) -> dict:
    hi = f"Welcome, {esc(first_name(name))}!" if first_name(name) else "Welcome to SmartWatts!"

    def step(n: int, title: str, text: str) -> str:
        return (f'<tr><td style="padding:12px 0;border-top:1px solid #EEECE7"><table role="presentation" cellpadding="0" cellspacing="0"><tr>'
                f'<td valign="top" style="width:34px"><div style="width:26px;height:26px;line-height:26px;border-radius:8px;background:#0E0E0E;color:#FF9A3D;text-align:center;font-family:{HEAD};font-size:13px;font-weight:800">{n}</div></td>'
                f'<td style="font-family:{FONT}"><div style="font-size:15px;font-weight:700;color:#0E0E0E">{title}</div><div style="font-size:13px;line-height:1.5;color:#5B5B57;margin-top:2px">{text}</div></td>'
                f'</tr></table></td></tr>')

    body = (_pill("ACCOUNT READY") + _h1(hi)
            + '<p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#3D3D3A">Your email is verified. Here’s how to start lowering your Meralco bill:</p>'
            + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">'
            + step(1, "Scan your latest bill", "Snap your paper Meralco bill — we read the kWh and charges, then delete the photo.")
            + step(2, "Add your appliances", "See which ones cost you the most each month.")
            + step(3, "Follow your savings plan", "Simple habits, with every peso computed by the official formula.")
            + "</table>"
            + button(f"{app_url}/dashboard", "Open my dashboard →")
            + notice("Need help? Just reply to this email."))
    plain_hi = f"Welcome, {first_name(name)}!" if first_name(name) else "Welcome to SmartWatts!"
    return {
        "subject": "Welcome to SmartWatts — your account is ready",
        "text": f"{plain_hi}\n\nYour email is verified. Open your dashboard: {app_url}/dashboard\n\n1. Scan your latest bill\n2. Add your appliances\n3. Follow your savings plan\n\n— SmartWatts",
        "html": layout(preheader="Your SmartWatts account is ready. Scan your first bill.", title="Welcome to SmartWatts", body=body, app_url=app_url),
    }


def _period(start: Any, end: Any, fallback: str) -> str:
    return f"{start} to {end}" if start and end else fallback


def _scope(property_name: Any, workspace_type: Any) -> str:
    return f"SmartWatts Rentals · {property_name}" if property_name else f"SmartWatts {workspace_type or 'Personal'}"


def bill_saved_email(*, name: Any = None, periodStart: Any = "", periodEnd: Any = "", amountPesos: Any = None, kwh: Any = None,
                     dueDate: Any = None, saveDate: Any = "", workspaceType: Any = "Personal", propertyName: Any = "",
                     app_url: str, **_: Any) -> dict:
    hi = _hi(name)
    period = _period(periodStart, periodEnd, "Recorded billing period")
    rows = [_detail_row("Billing Period", period)]
    if _has(amountPesos):
        rows.append(_detail_row("Recorded Amount Due", _pesos(amountPesos)))
    if _has(kwh):
        rows.append(_detail_row("Recorded Billed Usage", _kwh(kwh)))
    if dueDate:
        rows.append(_detail_row("Recorded Due Date", str(dueDate)))
    if saveDate:
        rows.append(_detail_row("Save Date", str(saveDate)))
    body = (_pill(_scope(propertyName, workspaceType).upper()) + _h1("Bill Saved Confirmation", 28)
            + f'<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3D3D3A">{hi}<br>Your electricity bill has been successfully saved to your SmartWatts account.</p>'
            + _details(rows)
            + button(f"{app_url}/dashboard#bills", "View in Bill History →")
            + notice('&#9432; <b style="color:#0E0E0E">Self-reported information.</b> These entries reflect the figures saved in your account. SmartWatts does not independently verify them with your utility provider.'))
    text = f"{hi}\n\nYour electricity bill for {period} has been saved to your SmartWatts account.\n\n"
    if _has(amountPesos):
        text += f"Recorded Amount: ₱{float(amountPesos):.2f}\n"
    if _has(kwh):
        text += f"Recorded Usage: {float(kwh):.1f} kWh\n"
    if dueDate:
        text += f"Due Date: {dueDate}\n"
    text += f"\nView your bill history: {app_url}/dashboard#bills\n\n— SmartWatts"
    return {
        "subject": f"Electricity Bill Saved ({period}) — SmartWatts",
        "text": text,
        "html": layout(preheader=f"Electricity bill saved for {period}.", title="Bill Saved Confirmation", body=body, app_url=app_url),
    }


def bill_due_reminder_email(*, name: Any = None, periodStart: Any = "", periodEnd: Any = "", amountPesos: Any = None, kwh: Any = None,
                            dueDate: Any = "", daysText: Any = "soon", workspaceType: Any = "Personal", propertyName: Any = "",
                            app_url: str, **_: Any) -> dict:
    hi = _hi(name)
    period = _period(periodStart, periodEnd, "Recorded billing period")
    rows = []
    if dueDate:
        rows.append(_detail_row("Due Date", str(dueDate)))
    rows.append(_detail_row("Billing Period", period))
    if _has(amountPesos):
        rows.append(_detail_row("Recorded Amount Due", _pesos(amountPesos)))
    if _has(kwh):
        rows.append(_detail_row("Recorded Billed Usage", _kwh(kwh)))
    body = (_pill(_scope(propertyName, workspaceType).upper()) + _h1("Upcoming Bill Due Date", 28)
            + f'<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3D3D3A">{hi}<br>A saved electricity bill in your SmartWatts account has a due date <b style="color:#0E0E0E">{esc(daysText)}</b>.</p>'
            + _details(rows)
            + button(f"{app_url}/dashboard#bills", "Review Saved Bill →")
            + notice('&#9432; <b style="color:#0E0E0E">Already settled?</b> SmartWatts does not process bill payments. If you have already paid this bill, you can safely ignore this reminder or update your bill notes.'))
    when = "Today" if daysText == "today" else f"in {daysText}"
    text = f"{hi}\n\nYour saved electricity bill has a due date {daysText} ({dueDate or period}).\n\n"
    if _has(amountPesos):
        text += f"Recorded Amount: ₱{float(amountPesos):.2f}\n"
    if dueDate:
        text += f"Due Date: {dueDate}\n"
    text += f"\nReview your bill: {app_url}/dashboard#bills\nIf you have already paid this bill, you may ignore this reminder.\n\n— SmartWatts"
    return {
        "subject": f"Reminder: Electricity Bill Due {when} ({dueDate or period}) — SmartWatts",
        "text": text,
        "html": layout(preheader=f"Electricity bill due {daysText} ({dueDate or period}).", title="Bill Due Reminder", body=body, app_url=app_url),
    }


def statement_published_email(*, name: Any = None, periodStart: Any = "", periodEnd: Any = "", amountPesos: Any = None,
                              dueDate: Any = None, propertyName: Any = "", unitName: Any = "", app_url: str, **_: Any) -> dict:
    hi = _hi(name)
    period = _period(periodStart, periodEnd, "Statement period")
    rows = []
    if propertyName:
        rows.append(_detail_row("Property", str(propertyName)))
    if unitName:
        rows.append(_detail_row("Unit", str(unitName)))
    rows.append(_detail_row("Billing Period", period))
    if _has(amountPesos):
        rows.append(_detail_row("Total Due", _pesos(amountPesos)))
    if dueDate:
        rows.append(_detail_row("Due Date", str(dueDate)))
    where = esc(propertyName) + (f" ({esc(unitName)})" if unitName else "")
    body = (_pill("SMARTWATTS RENTALS") + _h1("New Electricity Statement", 28)
            + f'<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3D3D3A">{hi}<br>Your property manager has published your electricity statement for <b style="color:#0E0E0E">{where}</b>.</p>'
            + _details(rows)
            + button(f"{app_url}/dashboard#tenant-statements", "View Statement →")
            + notice('&#9432; <b style="color:#0E0E0E">Official breakdown.</b> You can view the itemized submeter reading and official rate calculation in your SmartWatts tenant portal.'))
    text = f"{hi}\n\nYour electricity statement for {propertyName}{f' ({unitName})' if unitName else ''} ({period}) is ready.\n\n"
    if _has(amountPesos):
        text += f"Total Due: ₱{float(amountPesos):.2f}\n"
    if dueDate:
        text += f"Due Date: {dueDate}\n"
    text += f"\nView your statement: {app_url}/dashboard#tenant-statements\n\n— SmartWatts"
    return {
        "subject": f"New Electricity Statement for {unitName or propertyName} ({period}) — SmartWatts",
        "text": text,
        "html": layout(preheader=f"New electricity statement for {propertyName}.", title="New Electricity Statement", body=body, app_url=app_url),
    }


TEMPLATES: dict[str, Callable[..., dict]] = {
    "verification": verification_email,
    "password-reset": password_reset_email,
    "welcome": welcome_email,
    "bill-saved": bill_saved_email,
    "bill-due-reminder": bill_due_reminder_email,
    "statement-published": statement_published_email,
}


def build(template: str, data: dict, app_url: str) -> dict:
    make = TEMPLATES.get(template)
    if make is None:
        raise ValueError(f'Unknown template "{template}". Use one of: {", ".join(TEMPLATES)}')
    return make(**{**(data or {}), "app_url": app_url})
