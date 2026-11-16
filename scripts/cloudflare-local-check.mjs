#!/usr/bin/env node
// Local full-stack check of the Cloudflare deployment shape, with NO cloud resources:
//
//   Firebase emulators (Auth + Firestore, project demo-smartwatts)
//     <- FastAPI in production mode, exactly as on Cloud Run (proxy secret, ALLOWED_HOSTS, shield, Firestore state)
//       <- `wrangler dev` (workerd, the real Workers runtime) with dist/ as Static Assets
//         <- this script, acting as the browser
//
// Run after `npm run build:cloudflare`:   node scripts/cloudflare-local-check.mjs
//
// Safety: emulator-only "demo-" project; the backend gets an empty gcloud config dir (no Application Default
// Credentials), every key from .env is blanked, and EMAIL_DELIVERY=disabled. Secrets are random per run.
// Ports (override with env): CF_CHECK_AUTH_PORT 9529, CF_CHECK_FIRESTORE_PORT 8539, CF_CHECK_API_PORT 8549,
// CF_CHECK_WORKER_PORT 8559.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "demo-smartwatts";
const port = (name, fallback) => Number(process.env[name] || fallback);
const AUTH = port("CF_CHECK_AUTH_PORT", 9529);
const FIRESTORE = port("CF_CHECK_FIRESTORE_PORT", 8539);
const API = port("CF_CHECK_API_PORT", 8549);
const WORKER = port("CF_CHECK_WORKER_PORT", 8559);
const SITE = `http://127.0.0.1:${WORKER}`;
const BACKEND = `http://127.0.0.1:${API}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

if (!existsSync(join(root, "dist", "_headers"))) {
  console.error("Run `npm run build:cloudflare` first (dist/_headers is missing).");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "smartwatts-cf-check-"));
const children = [];
const secret = randomBytes(32).toString("hex");
const cronKey = randomBytes(24).toString("hex");

function start(name, cmd, args, options) {
  const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout.on("data", (d) => { log = (log + d).slice(-6000); });
  child.stderr.on("data", (d) => { log = (log + d).slice(-6000); });
  children.push({ name, child, log: () => log });
  return child;
}

function stopAll() {
  for (const { child } of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

async function waitFor(name, url, ok = (r) => r.status < 500, seconds = 90) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      if (ok(await fetch(url, { headers: { "user-agent": UA } }))) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const proc = children.find((c) => c.name === name);
  throw new Error(`${name} did not start at ${url}\n${proc ? proc.log() : ""}`);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
}

const get = (path, init = {}) => fetch(SITE + path, { redirect: "manual", ...init, headers: { "user-agent": UA, ...(init.headers || {}) } });

async function main() {
  // ---- 1. emulators ------------------------------------------------------------------------------------------
  const firebaseConfig = join(work, "firebase.json");
  writeFileSync(firebaseConfig, JSON.stringify({
    firestore: { rules: join(root, "firestore.rules") },
    emulators: { auth: { host: "127.0.0.1", port: AUTH }, firestore: { host: "127.0.0.1", port: FIRESTORE }, ui: { enabled: false }, singleProjectMode: true },
  }));
  start("emulators", join(root, "node_modules", ".bin", "firebase"),
    ["emulators:start", "--only", "auth,firestore", "--project", PROJECT, "--config", firebaseConfig], { cwd: work });
  await waitFor("emulators", `http://127.0.0.1:${AUTH}/`, (r) => r.ok, 120);
  await waitFor("emulators", `http://127.0.0.1:${FIRESTORE}/`, (r) => r.ok, 120);

  const emulatorEnv = {
    ...process.env,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE}`,
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${AUTH}`,
    CLOUDSDK_CONFIG: join(work, "gcloud"), // empty: no Application Default Credentials can be found
    GOOGLE_APPLICATION_CREDENTIALS: "",
    GOOGLE_APPLICATION_CREDENTIALS_JSON: "",
    GOOGLE_CLOUD_PROJECT: PROJECT,
  };

  // ---- 2. demo Owner / Tenant data (emulator only, existing seeder) ------------------------------------------
  const python = join(root, "backend", ".venv", "bin", "python");
  const seed = spawnSync(python, [join(root, "scripts", "seed_demo_data.py"), "--project", PROJECT,
    "--create-emulator-accounts", "--apply", "--json"], { env: { ...emulatorEnv, DEMO_EMULATOR_PASSWORD: "cf-check-password" }, encoding: "utf8" });
  if (seed.status !== 0) throw new Error(`Seeding failed:\n${seed.stderr}`);
  const seeded = JSON.parse(seed.stdout.trim().split("\n").pop());

  // ---- 3. backend, configured like Cloud Run -----------------------------------------------------------------
  const blank = Object.fromEntries(readFileSync(join(root, ".env.example"), "utf8").split("\n")
    .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean).map((k) => [k, ""]));
  start("backend", python, ["-m", "uvicorn", "app.main:app", "--app-dir", join(root, "backend"), "--host", "127.0.0.1",
    "--port", String(API), "--no-access-log"], {
    cwd: work,
    env: {
      ...emulatorEnv, ...blank,
      SMARTWATTS_ENV: "production", K_SERVICE: "smartwatts-api-local-check",
      BOT_SECRET: randomBytes(32).toString("hex"), PROXY_SHARED_SECRET: secret,
      ALLOWED_HOSTS: "127.0.0.1", FIREBASE_PROJECT_ID: PROJECT, EMAIL_DELIVERY: "disabled",
      CRON_API_KEY_SHA256: createHash("sha256").update(cronKey).digest("hex"),
      VERIFIED_USERS_FILE: join(work, "verified.json"),
    },
  });
  await waitFor("backend", `${BACKEND}/api/health`, (r) => r.status === 403); // up, and refusing non-proxy calls

  // ---- 4. the Worker in workerd ------------------------------------------------------------------------------
  start("wrangler", join(root, "node_modules", ".bin", "wrangler"), ["dev", "--ip", "127.0.0.1", "--port", String(WORKER),
    "--persist-to", join(work, "wrangler"), "--show-interactive-dev-session=false", "--log-level", "warn",
    "--var", `BACKEND_ORIGIN:${BACKEND}`, "--var", `PROXY_SHARED_SECRET:${secret}`, "--var", "PUBLIC_HOSTNAME:127.0.0.1",
    "--var", `CRON_API_KEY:${cronKey}`], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
  await waitFor("wrangler", `${SITE}/api/health`, (r) => r.ok, 120);

  // ---- pages -------------------------------------------------------------------------------------------------
  const pages = { "/": "landing/index.html", "/login": "landing/login.html", "/register": "landing/register.html",
    "/forgot-password": "landing/forgot-password.html", "/reset-password": "landing/reset-password.html",
    "/dashboard": "index.html", "/nfc": "nfc.html" };
  for (const [path, file] of Object.entries(pages)) {
    const r = await get(path);
    const body = await r.text();
    check(`page ${path}`, r.status === 200 && r.headers.get("content-type")?.includes("text/html")
      && body === readFileSync(join(root, "dist", file), "utf8") && r.headers.get("content-security-policy")
      && r.headers.get("cache-control") === "no-cache", `${r.status} ${r.headers.get("content-type")} -> dist/${file}`);
  }
  for (const path of ["/nfc", "/dashboard", "/login"]) {
    const again = await get(path, { headers: { "if-none-match": (await get(path)).headers.get("etag") || "" } });
    check(`refresh ${path} (conditional)`, [200, 304].includes(again.status), String(again.status));
  }
  for (const [from, to] of [["/landing/login.html", "/login"], ["/nfc/", "/nfc"], ["/dashboard/", "/dashboard"], ["/landing/", "/"]]) {
    const r = await get(`${from}?p=x`);
    check(`redirect ${from}`, r.status === 301 && r.headers.get("location") === `${to}?p=x`, `${r.status} ${r.headers.get("location")}`);
  }
  for (const path of ["/index.html", "/nfc.html"]) {
    const r = await get(path);
    check(`precache name ${path} (no redirect)`, r.status === 200, String(r.status));
  }

  // ---- static assets -----------------------------------------------------------------------------------------
  const mainJs = readdirSync(join(root, "dist", "assets")).find((f) => /^main-.*\.js$/.test(f));
  const mainCss = readdirSync(join(root, "dist", "assets")).find((f) => /^main-.*\.css$/.test(f));
  const assets = [
    [`/assets/${mainJs}`, "javascript", "immutable"], [`/assets/${mainCss}`, "text/css", "immutable"],
    ["/sw.js", "javascript", "no-cache"], ["/manifest.webmanifest", "manifest+json", "no-cache"],
    ["/smartwatts-icon-192.png", "image/png", ""], ["/landing/auth.js", "javascript", ""], ["/shield-client.js", "javascript", ""],
    ["/robots.txt", "text/plain", ""],
  ];
  for (const [path, type, cache] of assets) {
    const r = await get(path);
    await r.arrayBuffer();
    check(`asset ${path}`, r.status === 200 && r.headers.get("content-type")?.includes(type)
      && (!cache || r.headers.get("cache-control")?.includes(cache)) && r.headers.get("x-content-type-options") === "nosniff",
      `${r.status} ${r.headers.get("content-type")} | ${r.headers.get("cache-control")}`);
  }
  for (const path of ["/does-not-exist", "/.env", "/backend/app/main.py", "/_headers", "/.cloudflare-build.json", "/landing/secret.html"]) {
    const r = await get(path);
    check(`not served ${path}`, r.status === 404, String(r.status));
  }

  // ---- API through the Worker --------------------------------------------------------------------------------
  let r = await get("/api/health", { headers: { "user-agent": "curl/8.7.1" } });
  const health = await r.json();
  check("GET /api/health (public, curl)", r.status === 200 && JSON.stringify(health) === '{"status":"ok"}', `${r.status} ${JSON.stringify(health)}`);
  r = await get("/api/account/workspaces");
  check("API without browser-check cookie", r.status === 403 && (await r.json()).detail === "Verification required", String(r.status));

  const puzzle = await (await get("/__t")).json();
  let n = 0;
  while (!createHash("sha256").update(`${puzzle.t}:${n}`).digest("hex").startsWith("0".repeat(puzzle.d))) n++;
  r = await get(`/__v?t=${encodeURIComponent(puzzle.t)}&n=${n}`);
  const setCookie = r.headers.get("set-cookie") || "";
  check("browser check /__t + /__v sets cookie", r.status === 204 && /sw_v=.*HttpOnly.*Secure/i.test(setCookie), `${r.status} ${setCookie.split(";")[0].slice(0, 12)}…`);
  const cookie = setCookie.split(";")[0];
  const api = (path, token, init = {}) => get(path, { ...init, headers: { cookie, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });

  r = await api("/api/account/workspaces");
  check("protected route without sign-in", r.status === 401, String(r.status));
  r = await api("/api/nope");
  check("unknown API path (with cookie)", r.status === 404 && r.headers.get("content-type")?.includes("json"), String(r.status));
  r = await api("/api/account/workspaces", "not-a-token");
  check("protected route with forged token", r.status === 401, String(r.status));

  const signIn = async (email) => {
    const res = await fetch(`http://127.0.0.1:${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "cf-check-password", returnSecureToken: true }),
    });
    return (await res.json()).idToken;
  };
  const ownerToken = await signIn(seeded.accounts.owner.email);
  const tenantToken = await signIn(seeded.accounts.tenant.email);

  r = await api("/api/account/workspaces", ownerToken);
  const ownerWs = await r.json();
  const owned = (ownerWs.rentalMemberships || []).find((m) => m.role === "owner");
  check("owner workspaces (Firestore via proxy)", r.status === 200 && owned, `${r.status} roles=${(ownerWs.rentalMemberships || []).map((m) => m.role)}`);
  const pid = owned?.propertyId;
  r = await api(`/api/rentals/properties/${pid}/units`, ownerToken);
  check("owner reads units", r.status === 200, String(r.status));

  r = await api("/api/account/workspaces", tenantToken);
  const tenantWs = await r.json();
  const tenancy = (tenantWs.rentalMemberships || []).find((m) => m.role === "tenant");
  check("tenant workspaces -> assigned unit", r.status === 200 && tenancy?.unitId && tenancy.propertyId === pid, `${r.status} unit=${tenancy?.unitId ? "yes" : "no"}`);
  r = await api(`/api/rentals/properties/${pid}/me/statements`, tenantToken);
  check("tenant reads own statements", r.status === 200, String(r.status));
  r = await api(`/api/rentals/properties/${pid}/units`, tenantToken);
  check("tenant denied owner data (isolation)", r.status === 403, String(r.status));
  r = await api("/api/platform/subscriptions", ownerToken);
  check("owner denied platform admin", r.status === 403, String(r.status));

  r = await api("/api/notifications/preferences", ownerToken, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bill_saved_confirmations: true, bill_due_reminders: true, reminder_intervals: [3, 1, 0], rental_statements: true }) });
  check("save notification preferences", r.status === 200, String(r.status));
  const uid = seeded.accounts.owner.uid;
  const doc = await fetch(`http://127.0.0.1:${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/notification_preferences/${uid}`,
    { headers: { authorization: "Bearer owner" } });
  check("preferences persisted in Firestore (not memory)", doc.status === 200, String(doc.status));

  // ---- the edge cannot be skipped ----------------------------------------------------------------------------
  r = await fetch(`${BACKEND}/api/account/workspaces`, { headers: { "user-agent": UA, cookie, authorization: `Bearer ${ownerToken}` } });
  check("direct backend call without proxy secret", r.status === 403, String(r.status));
  r = await get("/api/health", { headers: { "x-smartwatts-proxy": "forged", "x-smartwatts-host": "evil.example" } });
  check("forged proxy headers are stripped by the Worker", r.status === 200, String(r.status));

  // ---- scheduler, as the Cron Trigger calls it ---------------------------------------------------------------
  const cron = (key) => fetch(`${BACKEND}/api/notifications/scheduler/run`, { method: "POST", headers: {
    "content-type": "application/json", "user-agent": "SmartWatts-Scheduler/1.0", "x-api-key": key,
    "x-smartwatts-proxy": secret, "x-smartwatts-client-ip": "cloudflare-cron", "x-smartwatts-host": "127.0.0.1" }, body: "{}" });
  r = await cron(cronKey);
  const run = await r.json();
  check("scheduler with cron key (email disabled: outbox untouched)", r.status === 200 && run.outbox_processed === 0, `${r.status} ${JSON.stringify(run)}`);
  r = await cron("wrong-key");
  check("scheduler with wrong key", r.status === 401, String(r.status));

  if (process.argv.includes("--browser")) await browserChecks();
}

/**
 * Signed-out browser behaviour through the Worker (Chromium). The production build talks to the production Firebase
 * Auth endpoints only to initialise the SDK (no sign-in, no writes). Signed-in Owner/Tenant routing is covered at
 * the API level above and by `npm run test:e2e:nfc` (emulator build).
 */
async function browserChecks() {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error" && /Content Security Policy|Refused to/i.test(msg.text())) {
        const where = msg.location();
        problems.push(`csp on ${new URL(page.url()).pathname} at ${(where.url || "").replace(SITE, "")}:${where.lineNumber}: ${msg.text().slice(0, 90)}`);
      }
    });

    await page.goto(`${SITE}/`, { waitUntil: "load" });
    check("browser: landing renders", (await page.title()).length > 0 && (await page.locator("body").innerText()).length > 50, await page.title());
    // The landing template markup carries placeholders such as onClick="{{toggleTheme}}" that support.js turns into
    // real listeners; the browser reports the raw attribute as a blocked inline handler (pre-existing, harmless).
    // Prove the buttons still work under the CSP:
    const before = await page.evaluate(() => localStorage.getItem("sw-theme"));
    await page.locator(".theme-toggle").first().click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => localStorage.getItem("sw-theme"));
    const faq = page.locator(".faq-q").first();
    const open0 = await faq.getAttribute("aria-expanded");
    await faq.click();
    await page.waitForTimeout(300);
    const open1 = await faq.getAttribute("aria-expanded");
    check("browser: landing buttons work under the CSP", after && after !== before && open0 !== open1,
      `theme ${before} -> ${after}, faq ${open0} -> ${open1}`);

    await page.goto(`${SITE}/nfc`, { waitUntil: "load" });
    // /nfc sends a signed-out visitor to /login#next=nfc; landing/auth.js stores the allowlisted key and removes the hash.
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 20000 }).catch(() => {});
    check("browser: signed-out NFC tap -> /login", new URL(page.url()).pathname === "/login", page.url().replace(SITE, ""));
    const stored = await page.evaluate(() => sessionStorage.getItem("smartwatts-return-to"));
    check("browser: NFC return key kept for after sign-in", /nfc/.test(stored || ""), String(stored).slice(0, 80));

    await page.goto(`${SITE}/dashboard`, { waitUntil: "load" });
    await page.waitForURL((url) => url.pathname !== "/dashboard", { timeout: 20000 }).catch(() => {});
    check("browser: signed-out /dashboard is guarded", new URL(page.url()).pathname !== "/dashboard", page.url().replace(SITE, ""));

    await page.goto(`${SITE}/login`, { waitUntil: "load" });
    await page.reload({ waitUntil: "load" });
    check("browser: /login survives refresh", new URL(page.url()).pathname === "/login" && (await page.locator("form, button").count()) > 0, page.url().replace(SITE, ""));

    // The app registers /sw.js from its Vite-built pages, which send signed-out visitors on before that happens, so
    // install it from a page that stays put: proves the script, its content type and scope work from this origin.
    const sw = await page.evaluate(async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 15000))]);
        return reg.active ? `active ${reg.scope}` : "not active";
      } catch (error) {
        return `error ${error.message}`;
      }
    });
    check("browser: PWA service worker installs and activates", sw.startsWith("active"), sw.replace(SITE, ""));

    // Landing templates (landing/support.js) carry placeholders such as onClick="{{toggleTheme}}"; the browser reports
    // each raw attribute as a blocked inline handler before support.js binds real listeners. No page has a real
    // inline handler, and the buttons work (checked above). Anything else is a failure.
    const template = problems.filter((p) => /^csp on \/(login|register)? at \/(l\.[0-9a-f]+\.js|landing\/support\.js):/.test(p) && p.includes("inline event handler"));
    const other = problems.filter((p) => !template.includes(p));
    check("browser: no CSP violations or page errors (besides landing template placeholders)", other.length === 0, other.slice(0, 3).join(" | ") || "none");
    if (template.length) console.warn(`WARN  ${template.length} landing template placeholder(s) reported as blocked inline handlers (pre-existing, harmless).`);
  } finally {
    await browser.close();
  }
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(String(error && error.stack || error));
} finally {
  stopAll();
  await new Promise((r) => setTimeout(r, 1500));
  rmSync(work, { recursive: true, force: true });
}
const width = Math.max(...results.map((x) => x.name.length), 10);
for (const { name, pass, detail } of results) console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(width)}  ${detail}`);
const bad = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed${failed ? " (aborted early, see error above)" : ""}.`);
process.exit(bad || failed ? 1 : 0);
