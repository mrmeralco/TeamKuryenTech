// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error -- plain JavaScript module (bundled by Wrangler), no type declarations
import worker from "./worker.js";
// @ts-expect-error -- plain JavaScript module (bundled by Wrangler), no type declarations
import { PAGES, backendOrigin } from "./app.js";
import SECURITY_HEADERS from "./security-headers.json";

const SECRET = "s".repeat(48);
const ORIGIN = "https://smartwatts-api-abc.a.run.app";

function makeEnv(overrides: Record<string, unknown> = {}) {
  const assetCalls: Request[] = [];
  const env = {
    BACKEND_ORIGIN: ORIGIN,
    PROXY_SHARED_SECRET: SECRET,
    PUBLIC_HOSTNAME: "smartwatts.example.com",
    ASSETS: {
      fetch: async (request: Request) => {
        assetCalls.push(request);
        const path = new URL(request.url).pathname;
        return new Response(`asset ${path}`, { status: 200, headers: { "content-type": "text/html", etag: '"1"' } });
      },
    },
    PAGE_LIMITER: { limit: async () => ({ success: true }) },
    API_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
  return { env, assetCalls };
}

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return new Request(`https://smartwatts.example.com${path}`, init);
}

function mockBackend(response: () => Response = () => Response.json({ status: "ok" })) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("pages", () => {
  it.each(Object.entries(PAGES))("serves %s from %s with security headers", async (path, asset) => {
    const { env, assetCalls } = makeEnv();
    const response = await worker.fetch(req(path), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`asset ${asset}`);
    expect(new URL(assetCalls[0].url).pathname).toBe(asset);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value);
  });

  it("keeps conditional headers so unchanged pages can answer 304", async () => {
    const { env, assetCalls } = makeEnv();
    await worker.fetch(req("/dashboard", { headers: { "if-none-match": '"1"' } }), env);
    expect(assetCalls[0].headers.get("if-none-match")).toBe('"1"');
  });

  it.each([
    ["/landing/login.html", "/login"],
    ["/landing/index.html", "/"],
    ["/landing/", "/"],
    ["/nfc/", "/nfc"],
    ["/dashboard/", "/dashboard"],
  ])("redirects %s to %s (query kept)", async (from, to) => {
    const { env } = makeEnv();
    const response = await worker.fetch(req(`${from}?p=abc`), env);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${to}?p=abc`);
  });

  it("never redirects /index.html or /nfc.html (service-worker precache names)", async () => {
    const { env } = makeEnv();
    for (const path of ["/index.html", "/nfc.html"]) {
      expect((await worker.fetch(req(path), env)).status).toBe(200);
    }
  });

  it("refuses unknown landing html and non-GET page requests", async () => {
    const { env } = makeEnv();
    expect((await worker.fetch(req("/landing/secret.html"), env)).status).toBe(404);
    expect((await worker.fetch(req("/login", { method: "POST", body: "x" }), env)).status).toBe(405);
  });

  it("rate limits page loads per visitor IP", async () => {
    const keys: string[] = [];
    const { env } = makeEnv({ PAGE_LIMITER: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } });
    const response = await worker.fetch(req("/login", { headers: { "cf-connecting-ip": "203.0.113.9" } }), env);
    expect(response.status).toBe(429);
    expect(keys).toEqual(["page:203.0.113.9"]);
  });
});

describe("API proxy", () => {
  it("forwards /api to the backend with the proxy headers and strips spoofed ones", async () => {
    const calls = mockBackend();
    const { env } = makeEnv();
    const response = await worker.fetch(req("/api/health?x=1", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        authorization: "Bearer token",
        cookie: "sw_v=abc",
        "x-smartwatts-proxy": "forged",
        "x-smartwatts-client-ip": "1.1.1.1",
        "x-forwarded-for": "1.1.1.1",
      },
    }), env);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ORIGIN}/api/health?x=1`);
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get("x-smartwatts-proxy")).toBe(SECRET);
    expect(sent.get("x-smartwatts-client-ip")).toBe("203.0.113.7");
    expect(sent.get("x-smartwatts-host")).toBe("smartwatts.example.com");
    expect(sent.get("authorization")).toBe("Bearer token");
    expect(sent.get("cookie")).toBe("sw_v=abc");
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(sent.get("cf-connecting-ip")).toBeNull();
    expect(calls[0].init.redirect).toBe("manual");
    expect(response.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
  });

  it.each(["/__t", "/__v", "/__c.js", "/api"])("proxies the backend path %s", async (path) => {
    const calls = mockBackend();
    const { env } = makeEnv();
    await worker.fetch(req(path), env);
    expect(calls[0].url).toBe(`${ORIGIN}${path}`);
  });

  it("streams request bodies for writes and passes Set-Cookie back", async () => {
    const calls = mockBackend(() => new Response(null, { status: 204, headers: { "set-cookie": "sw_v=1; Path=/; HttpOnly; Secure" } }));
    const { env } = makeEnv();
    const response = await worker.fetch(req("/api/rentals/x", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } }), env);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("sw_v=1");
  });

  it("answers 503 without calling anything when the backend is not configured or unsafe", async () => {
    const calls = mockBackend();
    for (const overrides of [{ BACKEND_ORIGIN: "" }, { BACKEND_ORIGIN: "http://api.example.com" }, { PROXY_SHARED_SECRET: "short" }]) {
      const { env } = makeEnv(overrides);
      const response = await worker.fetch(req("/api/health"), env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ detail: "Service unavailable" });
    }
    expect(calls).toHaveLength(0);
  });

  it("hides backend error pages and network failures behind JSON errors", async () => {
    const { env } = makeEnv();
    mockBackend(() => new Response("<html>Google Front End</html>", { status: 503, headers: { "content-type": "text/html", server: "Google Frontend" } }));
    let response = await worker.fetch(req("/api/health"), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("server")).toBeNull();
    expect(await response.json()).toEqual({ detail: "Service unavailable. Please try again." });
    vi.stubGlobal("fetch", async () => { throw new TypeError("network"); });
    response = await worker.fetch(req("/api/health"), env);
    expect(response.status).toBe(502);
  });

  it("rate limits API calls at the edge", async () => {
    const calls = mockBackend();
    const { env } = makeEnv({ API_LIMITER: { limit: async () => ({ success: false }) } });
    expect((await worker.fetch(req("/api/health"), env)).status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("accepts plain http only for a local backend", () => {
    expect(backendOrigin({ BACKEND_ORIGIN: "http://127.0.0.1:8000/" })).toBe("http://127.0.0.1:8000");
    expect(backendOrigin({ BACKEND_ORIGIN: "http://evil.example" })).toBe("");
    expect(backendOrigin({ BACKEND_ORIGIN: `${ORIGIN}/` })).toBe(ORIGIN);
  });
});

describe("scheduled notifications", () => {
  it("is skipped until the cron key is configured", async () => {
    const calls = mockBackend();
    const { env } = makeEnv();
    await worker.scheduled({ cron: "5 16 * * *" }, env);
    expect(calls).toHaveLength(0);
  });

  it("calls the scheduler with the cron key and proxy headers", async () => {
    const calls = mockBackend(() => Response.json({ reminders_queued: 0 }));
    const { env } = makeEnv({ CRON_API_KEY: "cron-key" });
    await worker.scheduled({ cron: "5 16 * * *" }, env);
    expect(calls[0].url).toBe(`${ORIGIN}/api/notifications/scheduler/run`);
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get("x-api-key")).toBe("cron-key");
    expect(sent.get("x-smartwatts-proxy")).toBe(SECRET);
    expect(sent.get("x-smartwatts-host")).toBe("smartwatts.example.com");
  });

  it("fails loudly when the backend refuses", async () => {
    mockBackend(() => new Response("{}", { status: 401 }));
    const { env } = makeEnv({ CRON_API_KEY: "cron-key" });
    await expect(worker.scheduled({ cron: "x" }, env)).rejects.toThrow("401");
  });
});
