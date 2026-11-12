/**
 * SmartWatts NFC / QR entry routing.
 *
 * The NFC card (or its QR fallback) only holds a plain HTTPS navigation URL such as
 * `https://<domain>/nfc`. It is a shortcut, never an authentication factor: identity comes
 * from the Firebase session on the device, and the property/unit come from the memberships
 * the FastAPI backend returns for that verified user.
 *
 * Nothing here trusts a URL parameter, email address or locally stored role. The optional
 * `?p=<propertyId>` hint only chooses between properties the server already authorized.
 */

/** Rental membership as returned by GET /api/account/workspaces (active memberships only). */
export interface RentalMembership {
  propertyId: string;
  propertyName: string;
  role: string;
  unitId?: string | null;
  unitLabel?: string | null;
  lifecycle?: string | null;
}

export type NfcDestination =
  | { kind: "open"; membership: RentalMembership }
  | { kind: "choose"; memberships: RentalMembership[] }
  | { kind: "none" };

/** Same storage key and shape the dashboard's workspace.js reads. */
export const WORKSPACE_KEY = "smartwatts-workspace";
/** Tab-scoped key the landing login reads to return to an allowlisted page after sign-in. */
export const RETURN_KEY = "smartwatts-return-to";
/** The only post-login destinations ever honoured. Keys, not URLs, so open redirects are impossible. */
export const RETURN_TARGETS: Readonly<Record<string, string>> = Object.freeze({ nfc: "/nfc" });

export const NFC_PATH = "/nfc";
export const DASHBOARD_PATH = "/dashboard";
export const LOGIN_PATH = "/login#next=nfc";

const MANAGER_ROLES = new Set(["owner", "admin"]);
const PROPERTY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function safeReturnPath(key: unknown): string | null {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(RETURN_TARGETS, key)) return null;
  return RETURN_TARGETS[key];
}

/** Optional opaque property hint from `?p=`. Invalid values are ignored, never echoed. */
export function parsePropertyHint(search: string): string | null {
  const value = new URLSearchParams(search).get("p");
  return value && PROPERTY_ID.test(value) ? value : null;
}

/** A membership is usable from the card when it is a manager role, or a tenant with an assigned unit. */
export function isUsableMembership(m: unknown): m is RentalMembership {
  if (!m || typeof m !== "object") return false;
  const item = m as Partial<RentalMembership>;
  if (typeof item.propertyId !== "string" || !PROPERTY_ID.test(item.propertyId)) return false;
  if (typeof item.propertyName !== "string") return false;
  if (MANAGER_ROLES.has(item.role ?? "")) return true;
  return item.role === "tenant" && typeof item.unitId === "string" && item.unitId.length > 0;
}

export function resolveNfcDestination(memberships: unknown, hint: string | null = null): NfcDestination {
  const usable = Array.isArray(memberships) ? memberships.filter(isUsableMembership) : [];
  if (usable.length === 0) return { kind: "none" };
  const hinted = hint ? usable.filter((m) => m.propertyId === hint) : [];
  if (hinted.length === 1) return { kind: "open", membership: hinted[0] };
  if (usable.length === 1) return { kind: "open", membership: usable[0] };
  return { kind: "choose", memberships: usable };
}

/** Workspace preference for the dashboard. It is only a hint: workspace.js re-validates it against server memberships. */
export function workspacePreference(propertyId: string | null): string {
  return JSON.stringify(propertyId ? { type: "rental", propertyId } : { type: "personal" });
}

export function roleLabel(m: RentalMembership): string {
  if (m.role === "tenant") return m.unitLabel ? `Tenant · ${m.unitLabel}` : "Tenant";
  return m.role === "owner" ? "Owner" : "Administrator";
}

/** Dashboard page each role opens on, mirroring workspaceHome in app.js. */
export function homePageFor(m: RentalMembership): "rental-overview" | "tenant-statements" {
  return m.role === "tenant" ? "tenant-statements" : "rental-overview";
}
