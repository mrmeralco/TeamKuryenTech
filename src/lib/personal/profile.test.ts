import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { currentUser: { uid: "user-a", displayName: "A. Customer", email: "a@example.test" } as unknown },
  firestore: {},
  doc: vi.fn((...parts: unknown[]) => ({ parts })),
  setDoc: vi.fn(),
  getDoc: vi.fn(),
  serverTimestamp: vi.fn(() => "server-timestamp"),
  deleteField: vi.fn(() => "delete-field"),
}));

vi.mock("../firebase", () => ({ auth: mocks.auth, firestore: mocks.firestore }));
vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(), collection: vi.fn(), deleteDoc: vi.fn(), deleteField: mocks.deleteField, doc: mocks.doc,
  getDoc: mocks.getDoc, getDocs: vi.fn(), serverTimestamp: mocks.serverTimestamp, setDoc: mocks.setDoc,
}));

import { loadUserProfile, saveUserProfile } from "./store";

describe("authenticated user profile storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.currentUser = { uid: "user-a", displayName: "A. Customer", email: "a@example.test" };
    mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => ({ firstName: "Alice", lastName: "Example", serviceAddress: "One Road" }) });
  });

  it("writes supported fields only to the authenticated user's UID document", async () => {
    expect(await saveUserProfile({ firstName: "  Alice ", lastName: " Example ", serviceAddress: " One Road ", phoneNumber: "" })).toBe(true);
    expect(mocks.doc).toHaveBeenCalledWith(mocks.firestore, "users", "user-a");
    expect(mocks.setDoc).toHaveBeenCalledWith(expect.objectContaining({ parts: [mocks.firestore, "users", "user-a"] }), {
      updatedAt: "server-timestamp", displayName: "Alice Example", firstName: "Alice", lastName: "Example",
      serviceAddress: "One Road", phoneNumber: null,
    }, { merge: true });
  });

  it("loads only the expected authenticated UID and returns empty profile fields when absent", async () => {
    const profile = await loadUserProfile("user-a");
    expect(mocks.doc).toHaveBeenCalledWith(mocks.firestore, "users", "user-a");
    expect(profile).toMatchObject({ firstName: "Alice", serviceAddress: "One Road", lastName: "Example" });
    expect(await loadUserProfile("user-b")).toBeNull();
  });

  it("rejects invalid phone values and excessive profile fields before writing", async () => {
    await expect(saveUserProfile({ phoneNumber: "not a phone" })).rejects.toThrow("valid mobile number");
    await expect(saveUserProfile({ serviceAddress: "x".repeat(301) })).rejects.toThrow("too long");
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });

  it("removes a stale read result when Firebase switches accounts mid-request", async () => {
    let complete!: (snapshot: unknown) => void;
    mocks.getDoc.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const pending = loadUserProfile("user-a");
    mocks.auth.currentUser = { uid: "user-b", displayName: "Different customer" };
    complete({ exists: () => true, data: () => ({ firstName: "Alice" }) });
    await expect(pending).resolves.toBeNull();
  });
});
