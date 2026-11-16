/**
 * SmartWatts on Cloudflare: one public HTTPS origin for the whole site. (Entry module: worker.js.)
 *
 *   browser ── https://<public host> ── Cloudflare Worker (cloudflare/app.js)
 *                                        ├─ static files: Workers Static Assets (the `dist/` build)
 *                                        └─ /api/*, /__t, /__v, /__c.js ──► FastAPI on Cloud Run (BACKEND_ORIGIN)
 *
 * Only the paths listed in wrangler.jsonc `assets.run_worker_first` reach this code (clean page URLs, legacy
 * redirects and the backend paths). Every other file (JS, CSS, images, sw.js, manifest) is served straight from
 * the asset store with the headers in dist/_headers (written by scripts/cloudflare-assets.mjs).
 *
 * Proxy contract with the backend (backend/app/security/middleware.py):
 *   x-smartwatts-proxy      PROXY_SHARED_SECRET. Cloud Run refuses requests without it, so nobody can skip the
 *                           edge by calling the *.run.app URL directly.
 *   x-smartwatts-client-ip  the visitor's IP (CF-Connecting-IP), used for the backend's per-IP limits and bans.
 *   x-smartwatts-host       the public hostname, checked against the backend's ALLOWED_HOSTS.
 * Visitors cannot set any of these: every incoming x-smartwatts-*, cf-* and x-forwarded-* header is dropped.
 *
 * The browser keeps talking to one origin, so Firebase ID tokens (Authorization header), the browser-check
 * cookie (sw_v, set by /__v) and CORS all behave exactly as in the single-server setup.
 */
import SECURITY_HEADERS from "./security-headers.json";

/** Clean URLs -> built files (same table as backend/app/security/site.py, firebase.json and vercel.json). */
export const PAGES = {
  "/": "/landing/index.html",
  "/login": "/landing/login.html",
  "/register": "/landing/register.html",
  "/forgot-password": "/landing/forgot-password.html",
  "/reset-password": "/landing/reset-password.html",
  "/dashboard": "/index.html",
  "/nfc": "/nfc.html",
};

/**
 * Legacy and trailing-slash URLs. /index.html and /nfc.html are deliberately NOT redirected: the service worker
 * precaches them by those names, and a redirect would store the wrong page under that name.
 */
export const REDIRECTS = {
  "/landing": "/",
  "/landing/": "/",
  "/landing/index.html": "/",
  "/landing/login.html": "/login",
  "/landing/register.html": "/register",
  "/landing/forgot-password.html": "/forgot-password",
  "/landing/reset-password.html": "/reset-password",
  "/dashboard/": "/dashboard",
  "/nfc/": "/nfc",
};

const BACKEND_PATH = /^\/(?:api(?:\/.*)?|__t|__v|__c\.js)$/;
export const PROXY_SECRET_HEADER = "x-smartwatts-proxy";
export const PROXY_CLIENT_IP_HEADER = "x-smartwatts-client-ip";
export const PROXY_HOST_HEADER = "x-smartwatts-host";

// Never forwarded to the backend: hop-by-hop headers, the Host (fetch sets the backend's own), and anything a
// visitor could use to impersonate the proxy or fake an address.
const DROP_REQUEST = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "forwarded", "x-real-ip", "true-client-ip",
]);
// Never returned to the browser: server fingerprints from Cloud Run / Google Front End.
const DROP_RESPONSE = ["server", "x-powered-by", "via", "x-cloud-trace-context", "alt-svc"];

export function isLocalOrigin(origin) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** The backend base URL, or "" when missing or unsafe (plain http is accepted only for a local backend). */
export function backendOrigin(env) {
  const value = String(env.BACKEND_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "http:" && isLocalOrigin(value))) return value;
  } catch {
    /* fall through */
  }
  return "";
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

/** Copies a response and applies the security headers (the same list the backend sends, see security-headers.json). */
export function secure(response, { cacheControl } = {}) {
  const out = new Response(response.body, response);
  for (const name of DROP_RESPONSE) out.headers.delete(name);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  if (cacheControl) out.headers.set("cache-control", cacheControl);
  return out;
}

async function overLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== "function") return false; // binding not configured
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false; // never take the site down because the limiter is unavailable
  }
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

export async function proxyToBackend(request, env, url) {
  const origin = backendOrigin(env);
  const secret = String(env.PROXY_SHARED_SECRET || "");
  if (!origin || secret.length < 32) {
    console.error("smartwatts: BACKEND_ORIGIN or PROXY_SHARED_SECRET is not configured");
    return secure(json(503, { detail: "Service unavailable" }));
  }
  if (url.pathname.startsWith("/api/") && (await overLimit(env.API_LIMITER, `api:${clientIp(request)}`))) {
    return secure(json(429, { detail: "Too many requests" }, { "retry-after": "60" }));
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    if (DROP_REQUEST.has(key) || key.startsWith("cf-") || key.startsWith("x-smartwatts-") || key.startsWith("x-forwarded-")) {
      continue;
    }
    headers.append(name, value);
  }
  headers.set(PROXY_SECRET_HEADER, secret);
  headers.set(PROXY_CLIENT_IP_HEADER, clientIp(request));
  headers.set(PROXY_HOST_HEADER, url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const method = request.method.toUpperCase();
  const init = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") init.body = request.body;

  let upstream;
  try {
    upstream = await fetch(origin + url.pathname + url.search, init);
  } catch (error) {
    console.error("smartwatts: backend unreachable", error && error.name);
    return secure(json(502, { detail: "The SmartWatts service is unreachable. Please try again." }));
  }
  const type = upstream.headers.get("content-type") || "";
  if (upstream.status >= 500 && !type.includes("json")) {
    // e.g. a Google Front End error page during a cold start: answer in the API's own JSON shape instead.
    return secure(json(upstream.status === 504 ? 504 : 503, { detail: "Service unavailable. Please try again." }));
  }
  return secure(upstream);
}

async function servePage(request, env, url, asset) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return secure(new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }));
  }
  if (await overLimit(env.PAGE_LIMITER, `page:${clientIp(request)}`)) {
    return secure(new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } }));
  }
  // Keep the conditional headers (If-None-Match) so unchanged pages answer 304.
  const response = await env.ASSETS.fetch(new Request(new URL(asset, url), { method: request.method, headers: request.headers }));
  // Pages always revalidate, so a new deployment is picked up on the next visit.
  return secure(response, { cacheControl: "no-cache" });
}

export const handlers = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (BACKEND_PATH.test(path)) return proxyToBackend(request, env, url);

    if (Object.hasOwn(REDIRECTS, path)) {
      return secure(new Response(null, { status: 301, headers: { location: REDIRECTS[path] + url.search } }));
    }
    if (Object.hasOwn(PAGES, path)) return servePage(request, env, url, PAGES[path]);
    if (path.startsWith("/landing/") && path.endsWith(".html")) {
      return secure(new Response("Not found", { status: 404 })); // landing pages only by their clean URL
    }
    // Anything else routed here by run_worker_first: a plain static file.
    return secure(await env.ASSETS.fetch(request));
  },

  /**
   * Cron Trigger (production only, see wrangler.jsonc): runs the notification scheduler on the backend
   * (due-date reminders + outbox flush). Authenticated with the cron key (CRON_API_KEY, whose SHA-256 the backend
   * has as CRON_API_KEY_SHA256) and the proxy secret. Skipped, with a log line, until all of it is configured.
   */
  async scheduled(event, env) {
    const origin = backendOrigin(env);
    const host = String(env.PUBLIC_HOSTNAME || "").trim();
    if (!origin || !env.PROXY_SHARED_SECRET || !env.CRON_API_KEY || !host) {
      console.log("smartwatts scheduler: skipped (BACKEND_ORIGIN, PROXY_SHARED_SECRET, CRON_API_KEY or PUBLIC_HOSTNAME not set)");
      return;
    }
    const response = await fetch(`${origin}/api/notifications/scheduler/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "SmartWatts-Scheduler/1.0 (Cloudflare Cron Trigger)",
        "x-api-key": env.CRON_API_KEY,
        [PROXY_SECRET_HEADER]: env.PROXY_SHARED_SECRET,
        [PROXY_CLIENT_IP_HEADER]: "cloudflare-cron",
        [PROXY_HOST_HEADER]: host,
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`smartwatts scheduler: backend answered ${response.status}`);
    const result = await response.json().catch(() => ({}));
    // Counts only: no addresses or message contents are logged.
    console.log("smartwatts scheduler:", JSON.stringify({ cron: event && event.cron, ...result }));
  },
};
