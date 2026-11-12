/**
 * NFC Tap-to-Dashboard flow. Dependencies are injected so the whole flow is unit-testable
 * without Firebase or a browser.
 *
 *  tap → restore Firebase session → (sign in if needed) → server memberships → open dashboard
 */
import {
  DASHBOARD_PATH,
  LOGIN_PATH,
  WORKSPACE_KEY,
  resolveNfcDestination,
  workspacePreference,
  type RentalMembership,
} from "../lib/nfcRouting";

export interface NfcUser {
  uid: string;
  isAnonymous: boolean;
  emailVerified: boolean;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

export type NfcState =
  | { name: "opening" }
  | { name: "checking-auth" }
  | { name: "checking-access" }
  | { name: "redirecting"; membership: RentalMembership | null }
  | { name: "signin-required"; reason: "signed-out" | "expired" | "unverified" }
  | { name: "no-membership" }
  | { name: "choose"; memberships: RentalMembership[] }
  | { name: "denied" }
  | { name: "network-error"; message: string }
  | { name: "unavailable" };

export interface NfcDeps {
  configured: boolean;
  /** Resolves once Firebase has restored any persisted session. */
  restoreUser(): Promise<NfcUser | null>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  storage: Pick<Storage, "setItem"> | null;
  hasPendingInvite(): boolean;
  hint: string | null;
  redirect(url: string): void;
  render(state: NfcState): void;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status}).`);
  }
}

async function getJson(deps: NfcDeps, path: string, token: string): Promise<unknown> {
  const response = await deps.fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

/** Same rule as the dashboard session guard: Google-verified, or verified by the SmartWatts email code. */
async function isVerified(deps: NfcDeps, user: NfcUser, token: string): Promise<boolean> {
  if (user.emailVerified) return true;
  const status = (await getJson(deps, "/api/auth/status", token)) as { verified?: unknown };
  return status?.verified === true;
}

function saveWorkspace(deps: NfcDeps, propertyId: string | null): void {
  try {
    deps.storage?.setItem(WORKSPACE_KEY, workspacePreference(propertyId));
  } catch {
    // The dashboard falls back to its own saved choice; the server still enforces access.
  }
}

export function openMembership(deps: NfcDeps, membership: RentalMembership): void {
  saveWorkspace(deps, membership.propertyId);
  deps.render({ name: "redirecting", membership });
  deps.redirect(DASHBOARD_PATH);
}

export function openPersonal(deps: NfcDeps): void {
  saveWorkspace(deps, null);
  deps.render({ name: "redirecting", membership: null });
  deps.redirect(DASHBOARD_PATH);
}

export function goToLogin(deps: NfcDeps): void {
  deps.redirect(LOGIN_PATH);
}

/**
 * Runs the flow once and returns the final state. `choose` / error states wait for the user;
 * memberships offered in `choose` came from the server, so selecting one cannot widen access.
 */
export async function runNfcEntry(deps: NfcDeps): Promise<NfcState> {
  const show = (state: NfcState) => {
    deps.render(state);
    return state;
  };
  show({ name: "opening" });
  if (!deps.configured) return show({ name: "unavailable" });

  show({ name: "checking-auth" });
  let user: NfcUser | null;
  try {
    user = await deps.restoreUser();
  } catch {
    return show({ name: "network-error", message: "SmartWatts could not restore your sign-in." });
  }
  if (!user || user.isAnonymous) {
    show({ name: "signin-required", reason: "signed-out" });
    goToLogin(deps);
    return { name: "signin-required", reason: "signed-out" };
  }

  let token: string;
  try {
    token = await user.getIdToken();
  } catch {
    // Revoked or expired refresh token: the session cannot be renewed on this device.
    return show({ name: "signin-required", reason: "expired" });
  }

  show({ name: "checking-access" });
  try {
    if (!(await isVerified(deps, user, token))) {
      show({ name: "signin-required", reason: "unverified" });
      goToLogin(deps);
      return { name: "signin-required", reason: "unverified" };
    }
    const workspaces = (await getJson(deps, "/api/account/workspaces", token)) as { rentalMemberships?: unknown };
    const destination = resolveNfcDestination(workspaces?.rentalMemberships, deps.hint);
    if (destination.kind === "open") {
      openMembership(deps, destination.membership);
      return { name: "redirecting", membership: destination.membership };
    }
    if (destination.kind === "choose") return show({ name: "choose", memberships: destination.memberships });
    if (deps.hasPendingInvite()) {
      // The dashboard's existing invitation flow takes over (accept → tenant membership).
      deps.render({ name: "redirecting", membership: null });
      deps.redirect(DASHBOARD_PATH);
      return { name: "redirecting", membership: null };
    }
    return show({ name: "no-membership" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return show({ name: "signin-required", reason: "expired" });
    if (error instanceof HttpError && error.status === 403) return show({ name: "denied" });
    return show({ name: "network-error", message: "SmartWatts could not reach the server to check your property access." });
  }
}
