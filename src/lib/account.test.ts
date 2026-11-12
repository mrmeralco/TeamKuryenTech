import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as unknown },
  linkWithCredential: vi.fn(),
  linkWithPopup: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  updateProfile: vi.fn(),
  signInWithPopup: vi.fn(),
}));

vi.mock("./firebase", () => ({ auth: mocks.auth, firebaseConfigured: true }));
vi.mock("firebase/auth", () => ({
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  GoogleAuthProvider: class {},
  linkWithCredential: mocks.linkWithCredential,
  createUserWithEmailAndPassword: mocks.createUserWithEmailAndPassword,
  sendEmailVerification: mocks.sendEmailVerification,
  updateProfile: mocks.updateProfile,
  linkWithPopup: mocks.linkWithPopup,
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: mocks.signInWithPopup,
  signOut: vi.fn(),
}));

import { createPermanentAccount, describeUser } from "./account";

describe("anonymous-to-permanent account upgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links the email credential to the anonymous user so the uid and personal data are kept", async () => {
    const anonymous = { uid: "guest-123", isAnonymous: true };
    const upgraded = { uid: "guest-123", isAnonymous: false, email: "a@b.co", emailVerified: false, getIdToken: vi.fn() };
    mocks.auth.currentUser = anonymous;
    mocks.linkWithCredential.mockResolvedValue({ user: upgraded });

    const result = await createPermanentAccount(" a@b.co ", "correct horse");

    expect(mocks.linkWithCredential).toHaveBeenCalledWith(anonymous, { email: "a@b.co", password: "correct horse" });
    expect(mocks.createUserWithEmailAndPassword).not.toHaveBeenCalled();
    expect(result.user.uid).toBe("guest-123");
    expect(result).toMatchObject({ displayNameUpdated: true, verificationEmailSent: true });
    expect(upgraded.getIdToken).toHaveBeenCalledWith(true);
    expect(describeUser(result.user as never)).toMatchObject({ permanent: true, uid: "guest-123" });
  });

  it("creates a new account when nobody is signed in", async () => {
    const created = { uid: "new", isAnonymous: false, getIdToken: vi.fn() };
    mocks.auth.currentUser = null;
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user: created });
    const result = await createPermanentAccount("n@b.co", "long password");
    expect(mocks.linkWithCredential).not.toHaveBeenCalled();
    expect(result.user.uid).toBe("new");
  });

  it("updates displayName when provided during permanent account creation", async () => {
    const created = { uid: "user-456", isAnonymous: false, getIdToken: vi.fn() };
    mocks.auth.currentUser = null;
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user: created });

    const result = await createPermanentAccount("n@b.co", "long password", "Juan Dela Cruz");

    expect(mocks.updateProfile).toHaveBeenCalledWith(created, { displayName: "Juan Dela Cruz" });
    expect(result.displayNameUpdated).toBe(true);
  });

  it("returns explicit failure status when verification delivery fails after linking", async () => {
    const anonymous = { uid: "guest", isAnonymous: true };
    const upgraded = { uid: "guest", isAnonymous: false, getIdToken: vi.fn() };
    mocks.auth.currentUser = anonymous;
    mocks.linkWithCredential.mockResolvedValue({ user: upgraded });
    mocks.sendEmailVerification.mockRejectedValue(Object.assign(new Error("private detail"), { code: "auth/network-request-failed" }));

    const result = await createPermanentAccount("n@b.co", "long password");

    expect(result).toMatchObject({ user: upgraded, verificationEmailSent: false });
  });

  it("does not silently switch away from anonymous data when Google credentials already belong to another UID", async () => {
    const anonymous = { uid: "guest-google", isAnonymous: true };
    mocks.auth.currentUser = anonymous;
    const collision = Object.assign(new Error("credential collision"), { code: "auth/credential-already-in-use" });
    mocks.linkWithPopup.mockRejectedValue(collision);

    await expect((await import("./account")).continueWithGoogle()).rejects.toMatchObject({ code: "auth/credential-already-in-use" });

    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.auth.currentUser).toBe(anonymous);
  });

  it("links Google to the anonymous UID when the credential is available", async () => {
    const anonymous = { uid: "guest-google-ok", isAnonymous: true };
    const linked = { uid: "guest-google-ok", isAnonymous: false, getIdToken: vi.fn() };
    mocks.auth.currentUser = anonymous;
    mocks.linkWithPopup.mockResolvedValue({ user: linked });

    const { continueWithGoogle } = await import("./account");
    const result = await continueWithGoogle();

    expect(mocks.linkWithPopup).toHaveBeenCalledWith(anonymous, expect.anything());
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(result.uid).toBe(anonymous.uid);
    expect(linked.getIdToken).toHaveBeenCalledWith(true);
  });

  it("maps Firebase errors to safe, specific messages and does not expose unknown raw details", async () => {
    const { friendlyAuthError } = await import("./account");
    expect(friendlyAuthError({ code: "auth/unauthorized-domain", message: "secret payload" })).toContain("not authorized");
    expect(friendlyAuthError({ code: "auth/network-request-failed", message: "secret payload" })).toContain("connection");
    expect(friendlyAuthError(Object.assign(new Error("raw server response"), { code: "auth/new-internal-code" }))).not.toContain("raw server response");
  });

  it("treats anonymous sessions as the free personal tier only", () => {
    expect(describeUser({ uid: "x", isAnonymous: true } as never)).toMatchObject({ signedIn: true, permanent: false });
  });
});
