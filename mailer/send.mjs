#!/usr/bin/env node
// SmartWatts mailer (nodemailer + Gmail app password).
//
// Usage: echo '{"template":"verification","to":"user@example.com","data":{"code":"123456","name":"Juan"}}' | node mailer/send.mjs
//        node mailer/send.mjs --preview verification > preview.html   (writes the HTML, sends nothing)
//
// Reads SMTP_USER / SMTP_PASSWORD / SMTP_FROM_NAME (and optional SMTP_HOST, SMTP_PORT, APP_URL)
// from the environment or the project's .env file. Prints one JSON line: {"ok":true,"messageId":...}
// or {"ok":false,"error":...} and exits non-zero on failure.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { templates } from "./templates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const LOGO = join(here, "assets", "logo-day.png");

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotEnv(join(here, "..", ".env"));

const appUrl = (process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "");

function build(template, data) {
  const make = templates[template];
  if (!make) throw new Error(`Unknown template "${template}". Use one of: ${Object.keys(templates).join(", ")}`);
  return make({ ...data, appUrl });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const previewIdx = process.argv.indexOf("--preview");
  if (previewIdx !== -1) {
    const template = process.argv[previewIdx + 1] || "verification";
    const mail = build(template, { code: "482913", name: "Juan Dela Cruz" });
    const logo = existsSync(LOGO) ? `data:image/png;base64,${readFileSync(LOGO).toString("base64")}` : "";
    process.stdout.write(mail.html.replaceAll("cid:smartwatts-logo", logo));
    return;
  }

  const { template, to, data = {} } = JSON.parse(await readStdin());
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("A valid recipient address is required.");
  const user = (process.env.SMTP_USER || "").trim();
  // Gmail shows app passwords in groups of 4 ("abcd efgh ..."); the spaces are not part of it.
  const pass = (process.env.SMTP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) throw new Error("SMTP_USER / SMTP_PASSWORD are not set.");

  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const mail = build(template, data);
  const info = await transporter.sendMail({
    from: { name: process.env.SMTP_FROM_NAME || "SmartWatts", address: user },
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: existsSync(LOGO) ? [{ filename: "smartwatts.png", path: LOGO, cid: "smartwatts-logo" }] : [],
  });
  process.stdout.write(JSON.stringify({ ok: true, messageId: info.messageId }) + "\n");
}

main().catch((error) => {
  const auth = error && (error.code === "EAUTH" || error.responseCode === 535);
  process.stdout.write(JSON.stringify({ ok: false, auth, error: String(error && error.message || error) }) + "\n");
  process.exit(1);
});
