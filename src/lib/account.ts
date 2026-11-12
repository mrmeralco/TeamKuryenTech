import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { auth, firebaseConfigured } from "./firebase";

export interface AccountState {
  configured: boolean;
  signedIn: boolean;
  permanent: boolean;
  uid: string | null;
  email: string | null;
  emailVerified: boolean;
}

export function describeUser(user: User | null): AccountState {
  return {
    configured: firebaseConfigured,
    signedIn: Boolean(user),
    permanent: Boolean(user && !user.isAnonymous),
    uid: user?.uid ?? null,
    email: user?.email ?? null,
    emailVerified: Boolean(user?.emailVerified),
  };
}

export function currentAccount(): AccountState {
  return describeUser(auth?.currentUser ?? null);
}

export function onAccountChange(callback: (state: AccountState) => void): () => void {
  if (!auth) {
    callback(describeUser(null));
    return () => undefined;
  }
  return onAuthStateChanged(auth, (user) => callback(describeUser(user)));
}

function requireAuth() {
  if (!auth) throw new Error("Firebase is not configured, so permanent accounts are unavailable.");
  return auth;
}

/**
 * Create a permanent email account. When the visitor is using an anonymous
 * personal session, the credential is LINKED to it so the uid — and every
 * personal appliance, bill, and savings plan — is preserved.
 */
export async function createPermanentAccount(email: string, password: string): Promise<User> {
  const firebaseAuth = requireAuth();
  const current = firebaseAuth.currentUser;
  const user = current?.isAnonymous
    ? (await linkWithCredential(current, EmailAuthProvider.credential(email, password))).user
    : (await createUserWithEmailAndPassword(firebaseAuth, email, password)).user;
  try {
    await sendEmailVerification(user);
  } catch {
    // Verification email failures must not block account creation.
  }
  await user.getIdToken(true);
  return user;
}

export async function signInPermanent(email: string, password: string): Promise<User> {
  return (await signInWithEmailAndPassword(requireAuth(), email, password)).user;
}

export async function continueWithGoogle(): Promise<User> {
  const firebaseAuth = requireAuth();
  const provider = new GoogleAuthProvider();
  const current = firebaseAuth.currentUser;
  if (current?.isAnonymous) {
    try {
      const { user } = await linkWithPopup(current, provider);
      await user.getIdToken(true);
      return user;
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/credential-already-in-use") throw error;
    }
  }
  return (await signInWithPopup(firebaseAuth, provider)).user;
}

export async function resendVerification(): Promise<void> {
  const user = requireAuth().currentUser;
  if (user && !user.isAnonymous) await sendEmailVerification(user);
}

export async function signOutAccount(): Promise<void> {
  await signOut(requireAuth());
}

export function friendlyAuthError(error: unknown): string {
  const code = (error as { code?: string })?.code ?? "";
  const messages: Record<string, string> = {
    "auth/email-already-in-use": "That email already has an account. Sign in instead.",
    "auth/credential-already-in-use": "That sign-in is already linked to another account. Sign in instead.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Use a password with at least 8 characters.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/wrong-password": "The email or password is incorrect.",
    "auth/user-not-found": "The email or password is incorrect.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/operation-not-allowed": "This sign-in method is not enabled for this Firebase project.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  };
  if (messages[code]) return messages[code];
  return error instanceof Error ? error.message : "Sign-in failed. Please try again.";
}
