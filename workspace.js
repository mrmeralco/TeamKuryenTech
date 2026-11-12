// Workspaces: every account has the free Personal workspace (Tier 1) and may
// also belong to rental properties (Tier 2) as owner, administrator, or tenant.
// Tiers are never global to the account; Rentals entitlements belong to a property.
import { apiGet } from "./src/lib/apiAuth.ts";
import { currentAccount } from "./src/lib/account.ts";
import { firebaseConfigured } from "./src/lib/firebase.ts";

const WORKSPACE_KEY = "smartwatts-workspace";
let memberships = [];
let rentalsStatus = firebaseConfigured ? "loading" : "unconfigured";
let rentalsError = "";
let platformAdmin = false;
let workspaceLoadSequence = 0;
let workspaceUserUid = null;

/** UI hint only: whether the API reported the verified platformAdmin claim. The server enforces it. */
export function isPlatformAdmin() {
  return platformAdmin;
}

function announce() {
  // Lets the React chat widget follow workspace/property switches without sharing state.
  const detail = getWorkspace();
  window.__smartwattsWorkspace = detail; // for listeners that mount after the first event
  window.dispatchEvent(new CustomEvent("smartwatts-workspace-changed", { detail }));
}

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? "null");
  } catch {
    return null;
  }
}

let current = readSaved() ?? { type: "personal" };

export function getMemberships() {
  return memberships;
}

export function getRentalsStatus() {
  return { status: rentalsStatus, error: rentalsError };
}

export function getWorkspace() {
  if (current.type === "personal") return current;
  const membership = memberships.find((m) => m.propertyId === current.propertyId);
  if (!membership) return { type: "personal" };
  return {
    type: membership.role === "tenant" ? "tenant" : "owner",
    role: membership.role,
    propertyId: membership.propertyId,
    propertyName: membership.propertyName,
    unitLabel: membership.unitLabel,
  };
}

export function setWorkspace(value) {
  current = value?.propertyId ? { type: "rental", propertyId: value.propertyId } : { type: "personal" };
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(current));
  } catch {
    // Workspace choice is a convenience; ignore storage failures.
  }
  announce();
}

export async function loadWorkspaces() {
  const sequence = ++workspaceLoadSequence;
  const account = currentAccount();
  const uid = account.permanent ? account.uid : null;
  platformAdmin = false;
  if (workspaceUserUid !== uid) {
    memberships = [];
    workspaceUserUid = uid;
  }
  if (!firebaseConfigured) {
    memberships = [];
    rentalsStatus = "unconfigured";
    announce();
    return memberships;
  }
  if (!account.permanent) {
    memberships = [];
    rentalsStatus = "needs-account";
    announce();
    return memberships;
  }
  try {
    const [result, platform] = await Promise.all([
      apiGet("/api/account/workspaces"),
      apiGet("/api/platform/me").catch(() => ({ platformAdmin: false })),
    ]);
    if (sequence !== workspaceLoadSequence || currentAccount().uid !== uid) return memberships;
    memberships = Array.isArray(result.rentalMemberships) ? result.rentalMemberships : [];
    platformAdmin = platform?.platformAdmin === true;
    rentalsStatus = "ready";
    rentalsError = "";
  } catch (error) {
    if (sequence !== workspaceLoadSequence || currentAccount().uid !== uid) return memberships;
    memberships = [];
    rentalsStatus = "unavailable";
    rentalsError = error instanceof Error ? error.message : "Rentals service unavailable.";
  }
  announce();
  return memberships;
}

export function workspaceOptions() {
  return [
    { value: "personal", label: "Personal · Free" },
    ...memberships.map((m) => ({
      value: m.propertyId,
      label: `${m.propertyName} · ${m.role === "tenant" ? `Tenant${m.unitLabel ? ` (${m.unitLabel})` : ""}` : m.role === "owner" ? "Owner" : "Admin"}`,
    })),
  ];
}
