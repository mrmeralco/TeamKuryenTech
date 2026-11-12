import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./firebase", () => ({
  auth: {
    currentUser: {
      getIdToken: vi.fn().mockResolvedValue("test-token"),
      isAnonymous: false,
    },
    authStateReady: vi.fn().mockResolvedValue(undefined),
  },
  firebaseConfigured: true,
}));

import { apiGet } from "./apiAuth";

describe("apiAuth request error handling", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parses detail string from json error response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ detail: "Forbidden action." }),
    });

    await expect(apiGet("/api/test")).rejects.toThrow("Forbidden action.");
  });

  it("handles 503 service unavailable with clear message when non-json response is returned", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
    });

    await expect(apiGet("/api/test")).rejects.toMatchObject({
      name: "Error",
      message: "SmartWatts API service is temporarily unavailable. Please verify the backend server is running.",
      status: 503,
    });
  });

  it("handles 502 bad gateway with clear message when non-json response is returned", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
    });

    await expect(apiGet("/api/test")).rejects.toMatchObject({
      name: "Error",
      message: "SmartWatts API service is temporarily unavailable. Please verify the backend server is running.",
      status: 502,
    });
  });
});
