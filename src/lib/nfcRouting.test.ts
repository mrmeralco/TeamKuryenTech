import { describe, expect, it } from "vitest";
import {
  LOGIN_PATH,
  NFC_PATH,
  parsePropertyHint,
  resolveNfcDestination,
  safeReturnPath,
  workspacePreference,
  type RentalMembership,
} from "./nfcRouting";

const owner: RentalMembership = { propertyId: "prop_A1", propertyName: "Sunrise", role: "owner", unitId: null, unitLabel: null, lifecycle: "pending_activation" };
const tenant: RentalMembership = { propertyId: "prop_B2", propertyName: "Moonrise", role: "tenant", unitId: "unit_7", unitLabel: "Unit 7", lifecycle: null };

describe("NFC return target allowlist", () => {
  it("maps only known keys to fixed same-origin paths", () => {
    expect(safeReturnPath("nfc")).toBe("/nfc");
  });

  it.each([
    "https://evil.example/phish", "//evil.example", "/\\evil.example", "javascript:alert(1)",
    "/dashboard", "NFC", "", "__proto__", "constructor", "toString", null, undefined, 42,
  ])("rejects open-redirect attempt %s", (value) => {
    expect(safeReturnPath(value)).toBeNull();
  });

  it("login and NFC paths are relative, same-origin and carry no credentials", () => {
    for (const path of [LOGIN_PATH, NFC_PATH]) {
      expect(path.startsWith("/")).toBe(true);
      expect(path.startsWith("//")).toBe(false);
      expect(path).not.toMatch(/token|password|uid|email|role|admin|claim/i);
    }
  });
});

describe("property hint", () => {
  it("accepts an opaque id and ignores invalid or injected values", () => {
    expect(parsePropertyHint("?p=prop_A1")).toBe("prop_A1");
    expect(parsePropertyHint("?p=../../admin")).toBeNull();
    expect(parsePropertyHint("?p=%3Cscript%3E")).toBeNull();
    expect(parsePropertyHint("?role=owner&admin=true")).toBeNull();
    expect(parsePropertyHint("")).toBeNull();
  });
});

describe("resolveNfcDestination (server memberships only)", () => {
  it("opens the single owner membership, even when the subscription is pending", () => {
    expect(resolveNfcDestination([owner])).toEqual({ kind: "open", membership: owner });
  });

  it("opens the single tenant membership with its assigned unit", () => {
    expect(resolveNfcDestination([tenant])).toEqual({ kind: "open", membership: tenant });
  });

  it("does not open a tenant membership that has no assigned unit", () => {
    expect(resolveNfcDestination([{ ...tenant, unitId: null }])).toEqual({ kind: "none" });
  });

  it("asks the user to choose when several properties are authorized", () => {
    expect(resolveNfcDestination([owner, tenant])).toEqual({ kind: "choose", memberships: [owner, tenant] });
  });

  it("uses the hint only to pick among authorized memberships", () => {
    expect(resolveNfcDestination([owner, tenant], "prop_B2")).toEqual({ kind: "open", membership: tenant });
    // A hint for a property the user does not belong to grants nothing.
    expect(resolveNfcDestination([owner, tenant], "prop_ZZ")).toEqual({ kind: "choose", memberships: [owner, tenant] });
    expect(resolveNfcDestination([], "prop_A1")).toEqual({ kind: "none" });
  });

  it.each([undefined, null, {}, "owner", [null], [{ role: "owner" }], [{ propertyId: "x", propertyName: "y", role: "superuser" }]])(
    "treats malformed or unknown data %j as no membership",
    (value) => expect(resolveNfcDestination(value)).toEqual({ kind: "none" }),
  );
});

describe("workspacePreference", () => {
  it("matches the dashboard workspace.js storage shape", () => {
    expect(JSON.parse(workspacePreference("prop_A1"))).toEqual({ type: "rental", propertyId: "prop_A1" });
    expect(JSON.parse(workspacePreference(null))).toEqual({ type: "personal" });
  });
});
