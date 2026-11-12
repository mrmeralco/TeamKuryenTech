import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as unknown },
  linkWithCredential: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
}));

vi.mock("./firebase", () => ({ auth: mocks.auth, firebaseConfigured: true }));
vi.mock("firebase/auth", () => ({
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  GoogleAuthProvider: class {},
  linkWithCredential: mocks.linkWithCredential,
  createUserWithEmailAndPassword: mocks.createUserWithEmailAndPassword,
  sendEmailVerification: mocks.sendEmailVerification,
  linkWithPopup: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
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

    const user = await createPermanentAccount("a@b.co", "correct horse");

    expect(mocks.linkWithCredential).toHaveBeenCalledWith(anonymous, { email: "a@b.co", password: "correct horse" });
    expect(mocks.createUserWithEmailAndPassword).not.toHaveBeenCalled();
    expect(user.uid).toBe("guest-123");
    expect(upgraded.getIdToken).toHaveBeenCalledWith(true);
    expect(describeUser(user)).toMatchObject({ permanent: true, uid: "guest-123" });
  });

  it("creates a new account when nobody is signed in", async () => {
    const created = { uid: "new", isAnonymous: false, getIdToken: vi.fn() };
    mocks.auth.currentUser = null;
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user: created });
    await createPermanentAccount("n@b.co", "long password");
    expect(mocks.linkWithCredential).not.toHaveBeenCalled();
  });

  it("treats anonymous sessions as the free personal tier only", () => {
    expect(describeUser({ uid: "x", isAnonymous: true } as never)).toMatchObject({ signedIn: true, permanent: false });
  });
});
