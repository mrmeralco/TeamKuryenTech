// SmartWatts email templates (table-based HTML so they render in Gmail, Outlook and phones).
// The logo is attached inline by send.mjs and referenced as cid:smartwatts-logo.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

const FONT = "Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const HEAD = "'Inter Tight',Inter,'Segoe UI',Helvetica,Arial,sans-serif";

function layout({ preheader, title, body, appUrl }) {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#F4F2ED;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2ED">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <!-- Logo -->
    <tr><td align="center" style="padding:0 0 20px">
      <a href="${esc(appUrl)}" style="text-decoration:none"><img src="cid:smartwatts-logo" alt="SmartWatts" height="56" style="display:block;height:56px;width:auto;border:0"></a>
    </td></tr>
    <!-- Card -->
    <tr><td style="background:#FFFFFF;border:1px solid #E6E3DD;border-radius:24px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:6px;line-height:6px;font-size:0;background:#FF7B00;border-radius:24px 24px 0 0">&nbsp;</td></tr>
        <tr><td style="padding:36px 36px 8px;font-family:${FONT};color:#0E0E0E">${body}</td></tr>
      </table>
    </td></tr>
    <!-- Features strip -->
    <tr><td style="padding:20px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E0E0E;border-radius:18px">
        <tr>
          <td width="33%" align="center" style="padding:18px 8px;font-family:${FONT}"><div style="font-family:${HEAD};font-size:20px;font-weight:800;color:#FAFAF7">&#8369;0</div><div style="font-size:12px;color:#A9A6A0;margin-top:2px">hardware to install</div></td>
          <td width="34%" align="center" style="padding:18px 8px;border-left:1px solid #2A2926;border-right:1px solid #2A2926;font-family:${FONT}"><div style="font-family:${HEAD};font-size:20px;font-weight:800;color:#FF9A3D">8-item</div><div style="font-size:12px;color:#A9A6A0;margin-top:2px">official Meralco formula</div></td>
          <td width="33%" align="center" style="padding:18px 8px;font-family:${FONT}"><div style="font-family:${HEAD};font-size:20px;font-weight:800;color:#FAFAF7">11</div><div style="font-size:12px;color:#A9A6A0;margin-top:2px">languages</div></td>
        </tr>
      </table>
    </td></tr>
    <!-- Footer -->
    <tr><td align="center" style="padding:24px 16px 8px;font-family:${FONT};font-size:12px;line-height:1.7;color:#8A8A85">
      &#128737;&#65039; Data Privacy Act compliant &middot; Photos deleted after scanning<br>
      &copy; ${year} SmartWatts &middot; Privacy-first electricity savings for Meralco-served homes &amp; rentals.<br>
      SmartWatts is not affiliated with or endorsed by Meralco.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0"><tr><td style="background:#FF7B00;border-radius:12px">
<a href="${esc(href)}" style="display:inline-block;padding:15px 28px;font-family:${FONT};font-size:16px;font-weight:700;color:#0E0E0E;text-decoration:none">${esc(label)}</a></td></tr></table>`;
}

function notice(html) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 28px"><tr>
<td style="background:#FFF4E8;border:1px solid #F6DFC6;border-radius:14px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:1.6;color:#3D3D3A">${html}</td></tr></table>`;
}

/** 6-digit email verification code. */
export function verificationEmail({ code, name, minutes = 10, appUrl }) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : "Hi there,";
  const boxes = String(code).split("").map((d) =>
    `<td align="center" style="width:46px;height:58px;background:#FFFFFF;border:1.5px solid #FFB36B;border-radius:12px;font-family:${HEAD};font-size:28px;font-weight:800;color:#0E0E0E">${esc(d)}</td><td style="width:8px;font-size:0">&nbsp;</td>`,
  ).join("");
  const body = `
    <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#FFF4E8;font-size:12px;font-weight:700;letter-spacing:.08em;color:#B85400">EMAIL VERIFICATION</div>
    <h1 style="margin:16px 0 10px;font-family:${HEAD};font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.03em">Verify your email</h1>
    <p style="margin:0;font-size:16px;line-height:1.6;color:#3D3D3A">${hi}<br>Enter this code to finish setting up your SmartWatts account.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;background:#F7F6F2;border:1px solid #E6E3DD;border-radius:18px"><tr><td style="padding:18px 10px 18px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>${boxes}</tr></table>
    </td></tr></table>
    <p style="margin:0;font-size:14px;color:#5B5B57">This code expires in <b style="color:#0E0E0E">${minutes} minutes</b>.</p>
    ${notice("&#128274; <b style=\"color:#0E0E0E\">Never share this code.</b> SmartWatts will never ask for it by phone, chat or email. If you didn’t try to sign in, you can safely ignore this email.")}`;
  return {
    subject: `${code} is your SmartWatts verification code`,
    text: `${hi}\n\nYour SmartWatts verification code is: ${code}\n\nIt expires in ${minutes} minutes. Never share this code with anyone.\nIf you didn't try to sign in, ignore this email.\n\n— SmartWatts`,
    html: layout({ preheader: `Your code is ${code}. It expires in ${minutes} minutes.`, title: "Verify your email", body, appUrl }),
  };
}

/** 6-digit password reset code. */
export function passwordResetEmail({ code, name, minutes = 10, appUrl }) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : "Hi there,";
  const boxes = String(code).split("").map((d) =>
    `<td align="center" style="width:46px;height:58px;background:#FFFFFF;border:1.5px solid #FFB36B;border-radius:12px;font-family:${HEAD};font-size:28px;font-weight:800;color:#0E0E0E">${esc(d)}</td><td style="width:8px;font-size:0">&nbsp;</td>`,
  ).join("");
  const body = `
    <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#FFF4E8;font-size:12px;font-weight:700;letter-spacing:.08em;color:#B85400">PASSWORD RESET</div>
    <h1 style="margin:16px 0 10px;font-family:${HEAD};font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.03em">Reset your password</h1>
    <p style="margin:0;font-size:16px;line-height:1.6;color:#3D3D3A">${hi}<br>Enter this code on the SmartWatts reset page to choose a new password.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;background:#F7F6F2;border:1px solid #E6E3DD;border-radius:18px"><tr><td style="padding:18px 10px 18px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>${boxes}</tr></table>
    </td></tr></table>
    <p style="margin:0 0 18px;font-size:14px;color:#5B5B57">This code expires in <b style="color:#0E0E0E">${minutes} minutes</b>.</p>
    ${button(`${appUrl}/forgot-password`, "Go to reset page →")}
    ${notice("&#128274; <b style=\"color:#0E0E0E\">Didn’t ask for this?</b> You can safely ignore this email — your password stays the same. Never share this code.")}`;
  return {
    subject: `${code} is your SmartWatts password reset code`,
    text: `${hi}\n\nYour SmartWatts password reset code is: ${code}\n\nIt expires in ${minutes} minutes. Enter it at ${appUrl}/forgot-password\nIf you didn't ask for this, ignore this email.\n\n— SmartWatts`,
    html: layout({ preheader: `Your password reset code is ${code}.`, title: "Reset your password", body, appUrl }),
  };
}

/** Sent once the email is verified. */
export function welcomeEmail({ name, appUrl }) {
  const hi = firstName(name) ? `Welcome, ${esc(firstName(name))}!` : "Welcome to SmartWatts!";
  const step = (n, title, text) => `<tr><td style="padding:12px 0;border-top:1px solid #EEECE7">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td valign="top" style="width:34px"><div style="width:26px;height:26px;line-height:26px;border-radius:8px;background:#0E0E0E;color:#FF9A3D;text-align:center;font-family:${HEAD};font-size:13px;font-weight:800">${n}</div></td>
      <td style="font-family:${FONT}"><div style="font-size:15px;font-weight:700;color:#0E0E0E">${title}</div><div style="font-size:13px;line-height:1.5;color:#5B5B57;margin-top:2px">${text}</div></td>
    </tr></table></td></tr>`;
  const body = `
    <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#FFF4E8;font-size:12px;font-weight:700;letter-spacing:.08em;color:#B85400">ACCOUNT READY</div>
    <h1 style="margin:16px 0 10px;font-family:${HEAD};font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.03em">${hi}</h1>
    <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#3D3D3A">Your email is verified. Here’s how to start lowering your Meralco bill:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
      ${step(1, "Scan your latest bill", "Snap your paper Meralco bill — we read the kWh and charges, then delete the photo.")}
      ${step(2, "Add your appliances", "See which ones cost you the most each month.")}
      ${step(3, "Follow your savings plan", "Simple habits, with every peso computed by the official formula.")}
    </table>
    ${button(`${appUrl}/dashboard`, "Open my dashboard →")}
    ${notice("Need help? Just reply to this email.")}`;
  return {
    subject: "Welcome to SmartWatts — your account is ready",
    text: `${hi}\n\nYour email is verified. Open your dashboard: ${appUrl}/dashboard\n\n1. Scan your latest bill\n2. Add your appliances\n3. Follow your savings plan\n\n— SmartWatts`,
    html: layout({ preheader: "Your SmartWatts account is ready. Scan your first bill.", title: "Welcome to SmartWatts", body, appUrl }),
  };
}

/** Electricity Bill Saved Confirmation */
export function billSavedEmail({
  name,
  periodStart = "",
  periodEnd = "",
  amountPesos = null,
  kwh = null,
  dueDate = null,
  saveDate = "",
  appUrl,
  workspaceType = "Personal",
  propertyName = "",
}) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : "Hi there,";
  const periodText = periodStart && periodEnd ? `${esc(periodStart)} to ${esc(periodEnd)}` : "Recorded billing period";
  const scopeText = propertyName ? `SmartWatts Rentals · ${esc(propertyName)}` : `SmartWatts ${esc(workspaceType)}`;

  const detailRow = (label, val) => `<tr>
    <td style="padding:10px 0;border-top:1px solid #EEECE7;font-family:${FONT};font-size:13px;color:#706E6B">${esc(label)}</td>
    <td align="right" style="padding:10px 0;border-top:1px solid #EEECE7;font-family:${HEAD};font-size:14px;font-weight:700;color:#0E0E0E">${esc(val)}</td>
  </tr>`;

  const body = `
    <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#FFF4E8;font-size:12px;font-weight:700;letter-spacing:.08em;color:#B85400">${scopeText.toUpperCase()}</div>
    <h1 style="margin:16px 0 10px;font-family:${HEAD};font-size:28px;line-height:1.15;font-weight:800;letter-spacing:-.03em">Bill Saved Confirmation</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3D3D3A">${hi}<br>Your electricity bill has been successfully saved to your SmartWatts account.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FBFBFA;border:1px solid #E6E3DD;border-radius:16px;padding:6px 18px">
      ${detailRow("Billing Period", periodText)}
      ${amountPesos !== null && amountPesos !== undefined ? detailRow("Recorded Amount Due", `₱${Number(amountPesos).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`) : ""}
      ${kwh !== null && kwh !== undefined ? detailRow("Recorded Billed Usage", `${Number(kwh).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`) : ""}
      ${dueDate ? detailRow("Recorded Due Date", dueDate) : ""}
      ${saveDate ? detailRow("Save Date", saveDate) : ""}
    </table>

    ${button(`${appUrl}/dashboard#bills`, "View in Bill History →")}
    ${notice("&#9432; <b style=\"color:#0E0E0E\">Self-reported information.</b> These entries reflect the figures saved in your account. SmartWatts does not independently verify them with your utility provider.")}`;

  return {
    subject: `Electricity Bill Saved (${periodText}) — SmartWatts`,
    text: `${hi}\n\nYour electricity bill for ${periodText} has been saved to your SmartWatts account.\n\n` +
      (amountPesos !== null && amountPesos !== undefined ? `Recorded Amount: ₱${Number(amountPesos).toFixed(2)}\n` : "") +
      (kwh !== null && kwh !== undefined ? `Recorded Usage: ${Number(kwh).toFixed(1)} kWh\n` : "") +
      (dueDate ? `Due Date: ${dueDate}\n` : "") +
      `\nView your bill history: ${appUrl}/dashboard#bills\n\n— SmartWatts`,
    html: layout({ preheader: `Electricity bill saved for ${periodText}.`, title: "Bill Saved Confirmation", body, appUrl }),
  };
}

/** Electricity Bill Due Reminder */
export function billDueReminderEmail({
  name,
  periodStart = "",
  periodEnd = "",
  amountPesos = null,
  kwh = null,
  dueDate = "",
  daysText = "soon",
  appUrl,
  workspaceType = "Personal",
  propertyName = "",
}) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : "Hi there,";
  const periodText = periodStart && periodEnd ? `${esc(periodStart)} to ${esc(periodEnd)}` : "Recorded billing period";
  const scopeText = propertyName ? `SmartWatts Rentals · ${esc(propertyName)}` : `SmartWatts ${esc(workspaceType)}`;

  const detailRow = (label, val) => `<tr>
    <td style="padding:10px 0;border-top:1px solid #EEECE7;font-family:${FONT};font-size:13px;color:#706E6B">${esc(label)}</td>
    <td align="right" style="padding:10px 0;border-top:1px solid #EEECE7;font-family:${HEAD};font-size:14px;font-weight:700;color:#0E0E0E">${esc(val)}</td>
  </tr>`;

  const body = `
    <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#FFF4E8;font-size:12px;font-weight:700;letter-spacing:.08em;color:#B85400">${scopeText.toUpperCase()}</div>
    <h1 style="margin:16px 0 10px;font-family:${HEAD};font-size:28px;line-height:1.15;font-weight:800;letter-spacing:-.03em">Upcoming Bill Due Date</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3D3D3A">${hi}<br>A saved electricity bill in your SmartWatts account has a due date <b style="color:#0E0E0E">${esc(daysText)}</b>.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FBFBFA;border:1px solid #E6E3DD;border-radius:16px;padding:6px 18px">
      ${dueDate ? detailRow("Due Date", dueDate) : ""}
      ${detailRow("Billing Period", periodText)}
      ${amountPesos !== null && amountPesos !== undefined ? detailRow("Recorded Amount Due", `₱${Number(amountPesos).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`) : ""}
      ${kwh !== null && kwh !== undefined ? detailRow("Recorded Billed Usage", `${Number(kwh).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`) : ""}
    </table>

    ${button(`${appUrl}/dashboard#bills`, "Review Saved Bill →")}
    ${notice("&#9432; <b style=\"color:#0E0E0E\">Already settled?</b> SmartWatts does not process bill payments. If you have already paid this bill, you can safely ignore this reminder or update your bill notes.")}`;

  return {
    subject: `Reminder: Electricity Bill Due ${daysText === "today" ? "Today" : `in ${daysText}`} (${dueDate || periodText}) — SmartWatts`,
    text: `${hi}\n\nYour saved electricity bill has a due date ${daysText} (${dueDate || periodText}).\n\n` +
      (amountPesos !== null && amountPesos !== undefined ? `Recorded Amount: ₱${Number(amountPesos).toFixed(2)}\n` : "") +
      (dueDate ? `Due Date: ${dueDate}\n` : "") +
      `\nReview your bill: ${appUrl}/dashboard#bills\nIf you have already paid this bill, you may ignore this reminder.\n\n— SmartWatts`,
    html: layout({ preheader: `Electricity bill due ${daysText} (${dueDate || periodText}).`, title: "Bill Due Reminder", body, appUrl }),
  };
}

/** New Tenant Electricity Statement Ready */
export function statementPublishedEmail({
  name,
  periodStart = "",
  periodEnd = "",
  amountPesos = null,
  dueDate = null,
  propertyName = "",
  unitName = "",
  appUrl,
}) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : "Hi there,";
  const periodText = periodStart && periodEnd ? `${esc(periodStart)} to ${esc(periodEnd)}` : "Statement period";

  const detailRow = (label, val) => `<tr>
    <td style="padding:10px 0;border-top:1px solid #EEECE7;font-family:${FONT};font-size:13px;color:#706E6B">${esc(label)}</td>
    <td align="right" style="padding:10px 0;border-top:1px solid #EEECE7;font-family:${HEAD};font-size:14px;font-weight:700;color:#0E0E0E">${esc(val)}</td>
  </tr>`;

  const body = `
    <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#FFF4E8;font-size:12px;font-weight:700;letter-spacing:.08em;color:#B85400">SMARTWATTS RENTALS</div>
    <h1 style="margin:16px 0 10px;font-family:${HEAD};font-size:28px;line-height:1.15;font-weight:800;letter-spacing:-.03em">New Electricity Statement</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3D3D3A">${hi}<br>Your property manager has published your electricity statement for <b style="color:#0E0E0E">${esc(propertyName)}${unitName ? ` (${esc(unitName)})` : ""}</b>.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FBFBFA;border:1px solid #E6E3DD;border-radius:16px;padding:6px 18px">
      ${propertyName ? detailRow("Property", propertyName) : ""}
      ${unitName ? detailRow("Unit", unitName) : ""}
      ${detailRow("Billing Period", periodText)}
      ${amountPesos !== null && amountPesos !== undefined ? detailRow("Total Due", `₱${Number(amountPesos).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`) : ""}
      ${dueDate ? detailRow("Due Date", dueDate) : ""}
    </table>

    ${button(`${appUrl}/dashboard#tenant-statements`, "View Statement →")}
    ${notice("&#9432; <b style=\"color:#0E0E0E\">Official breakdown.</b> You can view the itemized submeter reading and official rate calculation in your SmartWatts tenant portal.")}`;

  return {
    subject: `New Electricity Statement for ${unitName || propertyName} (${periodText}) — SmartWatts`,
    text: `${hi}\n\nYour electricity statement for ${propertyName}${unitName ? ` (${unitName})` : ""} (${periodText}) is ready.\n\n` +
      (amountPesos !== null && amountPesos !== undefined ? `Total Due: ₱${Number(amountPesos).toFixed(2)}\n` : "") +
      (dueDate ? `Due Date: ${dueDate}\n` : "") +
      `\nView your statement: ${appUrl}/dashboard#tenant-statements\n\n— SmartWatts`,
    html: layout({ preheader: `New electricity statement for ${propertyName}.`, title: "New Electricity Statement", body, appUrl }),
  };
}

export const templates = {
  verification: verificationEmail,
  "password-reset": passwordResetEmail,
  welcome: welcomeEmail,
  "bill-saved": billSavedEmail,
  "bill-due-reminder": billDueReminderEmail,
  "statement-published": statementPublishedEmail,
};
