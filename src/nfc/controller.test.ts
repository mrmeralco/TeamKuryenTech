import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_KEY, type RentalMembership } from "../lib/nfcRouting";
import { openMembership, runNfcEntry, type NfcDeps, type NfcState, type NfcUser } from "./controller";

const owner: RentalMembership = { propertyId: "prop_owner", propertyName: "Rolex Esto", role: "owner", unitId: null, unitLabel: null, lifecycle: "pending_activation" };
const tenant: RentalMembership = { propertyId: "prop_owner", propertyName: "Rolex Esto", role: "tenant", unitId: "unit_1", unitLabel: "Unit 1", lifecycle: null };

function user(overrides: Partial<NfcUser> = {}): NfcUser {
  return { uid: "uid-1", isAnonymous: false, emailVerified: true, getIdToken: async () => "id-token-1", ...overrides };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setup(options: {
  user?: NfcUser | null;
  memberships?: unknown;
  workspacesStatus?: number;
  verified?: boolean;
  configured?: boolean;
  pendingInvite?: boolean;
  hint?: string | null;
  fetchError?: boolean;
} = {}) {
  const storage = new Map<string, string>();
  const states: NfcState[] = [];
  const redirects: string[] = [];
  const requests: { url: string; auth: string | null }[] = [];
  const deps: NfcDeps = {
    configured: options.configured ?? true,
    restoreUser: async () => (options.user === undefined ? user() : options.user),
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      if (options.fetchError) throw new TypeError("Failed to fetch");
      if (url === "/api/auth/status") return json(200, { verified: options.verified ?? false });
      if (url === "/api/account/workspaces") {
        const status = options.workspacesStatus ?? 200;
        return status === 200 ? json(200, { rentalMemberships: options.memberships ?? [] }) : json(status, { detail: "x" });
      }
      return json(404, {});
    }),
    storage: { setItem: (key: string, value: string) => void storage.set(key, value) },
    hasPendingInvite: () => options.pendingInvite ?? false,
    hint: options.hint ?? null,
    redirect: (url) => void redirects.push(url),
    render: (state) => void states.push(state),
  };
  return { deps, storage, states, redirects, requests };
}

describe("NFC entry flow", () => {
  it("shows a branded loading sequence before any decision", async () => {
    const t = setup({ memberships: [owner] });
    await runNfcEntry(t.deps);
    expect(t.states.slice(0, 3).map((s) => s.name)).toEqual(["opening", "checking-auth", "checking-access"]);
  });

  it("sends a signed-out device to the existing login with a fixed return key", async () => {
    const t = setup({ user: null });
    const final = await runNfcEntry(t.deps);
    expect(final).toEqual({ name: "signin-required", reason: "signed-out" });
    expect(t.redirects).toEqual(["/login#next=nfc"]);
    expect(t.requests).toEqual([]);
  });

  it("treats an anonymous guest session as signed out", async () => {
    const t = setup({ user: user({ isAnonymous: true }) });
    await runNfcEntry(t.deps);
    expect(t.redirects).toEqual(["/login#next=nfc"]);
  });

  it("an authenticated owner opens the Owner Overview for the server-authorized property", async () => {
    const t = setup({ memberships: [owner] });
    const final = await runNfcEntry(t.deps);
    expect(final).toEqual({ name: "redirecting", membership: owner });
    expect(t.redirects).toEqual(["/dashboard"]);
    expect(JSON.parse(t.storage.get(WORKSPACE_KEY)!)).toEqual({ type: "rental", propertyId: "prop_owner" });
    // The ID token is sent only as an Authorization header to same-origin API paths.
    expect(t.requests).toEqual([{ url: "/api/account/workspaces", auth: "Bearer id-token-1" }]);
  });

  it("an authenticated tenant opens their own unit's tenant workspace", async () => {
    const t = setup({ memberships: [tenant] });
    const final = await runNfcEntry(t.deps);
    expect(final).toEqual({ name: "redirecting", membership: tenant });
    expect(JSON.parse(t.storage.get(WORKSPACE_KEY)!)).toEqual({ type: "rental", propertyId: "prop_owner" });
  });

  it("an owner with a pending subscription is routed normally — restrictions stay with the dashboard and API", async () => {
    const t = setup({ memberships: [owner] });
    await runNfcEntry(t.deps);
    expect(t.redirects).toEqual(["/dashboard"]);
    expect(t.storage.get(WORKSPACE_KEY)).not.toMatch(/active|entitle|plan/);
  });

  it("an account with no memberships (or a removed tenant) is not given Rentals access", async () => {
    const t = setup({ memberships: [] });
    expect(await runNfcEntry(t.deps)).toEqual({ name: "no-membership" });
    expect(t.redirects).toEqual([]);
    expect(t.storage.has(WORKSPACE_KEY)).toBe(false);
  });

  it("a pending invitation continues into the dashboard's existing invitation flow", async () => {
    const t = setup({ memberships: [], pendingInvite: true });
    await runNfcEntry(t.deps);
    expect(t.redirects).toEqual(["/dashboard"]);
    expect(t.storage.has(WORKSPACE_KEY)).toBe(false);
  });

  it("multiple memberships show a chooser of server-authorized workspaces only", async () => {
    const other = { ...owner, propertyId: "prop_two", propertyName: "Second" };
    const t = setup({ memberships: [owner, other] });
    const final = await runNfcEntry(t.deps);
    expect(final).toEqual({ name: "choose", memberships: [owner, other] });
    expect(t.redirects).toEqual([]);
    openMembership(t.deps, other);
    expect(JSON.parse(t.storage.get(WORKSPACE_KEY)!)).toEqual({ type: "rental", propertyId: "prop_two" });
    expect(t.redirects).toEqual(["/dashboard"]);
  });

  it("a property hint picks among authorized memberships but never adds one", async () => {
    const other = { ...owner, propertyId: "prop_two", propertyName: "Second" };
    const hinted = setup({ memberships: [owner, other], hint: "prop_two" });
    expect(await runNfcEntry(hinted.deps)).toEqual({ name: "redirecting", membership: other });
    const foreign = setup({ memberships: [], hint: "prop_not_mine" });
    expect(await runNfcEntry(foreign.deps)).toEqual({ name: "no-membership" });
  });

  it("an expired session (token refresh fails) requires signing in again", async () => {
    const t = setup({ user: user({ getIdToken: async () => { throw new Error("auth/user-token-expired"); } }) });
    expect(await runNfcEntry(t.deps)).toEqual({ name: "signin-required", reason: "expired" });
    expect(t.requests).toEqual([]);
  });

  it("a 401 from the API is treated as an expired session", async () => {
    const t = setup({ workspacesStatus: 401 });
    expect(await runNfcEntry(t.deps)).toEqual({ name: "signin-required", reason: "expired" });
  });

  it("a 403 from the API shows access denied", async () => {
    const t = setup({ workspacesStatus: 403 });
    expect(await runNfcEntry(t.deps)).toEqual({ name: "denied" });
  });

  it("network and server failures show a retryable error", async () => {
    const offline = setup({ fetchError: true });
    expect((await runNfcEntry(offline.deps)).name).toBe("network-error");
    const down = setup({ workspacesStatus: 503 });
    expect((await runNfcEntry(down.deps)).name).toBe("network-error");
  });

  it("an email/password account must be verified (backend status) before routing", async () => {
    const unverified = setup({ user: user({ emailVerified: false }), verified: false, memberships: [owner] });
    expect(await runNfcEntry(unverified.deps)).toEqual({ name: "signin-required", reason: "unverified" });
    expect(unverified.redirects).toEqual(["/login#next=nfc"]);
    const verified = setup({ user: user({ emailVerified: false }), verified: true, memberships: [owner] });
    expect((await runNfcEntry(verified.deps)).name).toBe("redirecting");
  });

  it("switching accounts overwrites the previous account's workspace with the new server result", async () => {
    const first = setup({ memberships: [owner] });
    await runNfcEntry(first.deps);
    const sharedStorage = first.storage;
    const second = setup({ user: user({ uid: "uid-2" }), memberships: [{ ...tenant, propertyId: "prop_tenant" }] });
    second.deps.storage = { setItem: (k, v) => void sharedStorage.set(k, v) };
    await runNfcEntry(second.deps);
    expect(JSON.parse(sharedStorage.get(WORKSPACE_KEY)!)).toEqual({ type: "rental", propertyId: "prop_tenant" });
  });

  it("an unconfigured build shows an unavailable state without redirecting", async () => {
    const t = setup({ configured: false });
    expect(await runNfcEntry(t.deps)).toEqual({ name: "unavailable" });
    expect(t.redirects).toEqual([]);
  });

  it("re-running (refresh / retry) is idempotent", async () => {
    const t = setup({ memberships: [owner] });
    await runNfcEntry(t.deps);
    await runNfcEntry(t.deps);
    expect(t.redirects).toEqual(["/dashboard", "/dashboard"]);
  });
});
