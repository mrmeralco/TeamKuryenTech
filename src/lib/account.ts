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
  updateProfile,
  type User,
} from "firebase/auth";
import { auth, firebaseConfigured } from "./firebase";

export interface AccountState {
  configured: boolean;
  signedIn: boolean;
  permanent: boolean;
  uid: string | null;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
}

export interface PermanentAccountResult {
  user: User;
  displayNameUpdated: boolean;
  verificationEmailSent: boolean;
}

export function describeUser(user: User | null): AccountState {
  return {
    configured: firebaseConfigured,
    signedIn: Boolean(user),
    permanent: Boolean(user && !user.isAnonymous),
    uid: user?.uid ?? null,
    displayName: user?.displayName ?? null,
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
export async function createPermanentAccount(email: string, password: string, displayName?: string): Promise<PermanentAccountResult> {
  const firebaseAuth = requireAuth();
  const current = firebaseAuth.currentUser;
  const normalizedEmail = email.trim();
  const user = current?.isAnonymous
    ? (await linkWithCredential(current, EmailAuthProvider.credential(normalizedEmail, password))).user
    : (await createUserWithEmailAndPassword(firebaseAuth, normalizedEmail, password)).user;
  let displayNameUpdated = !displayName?.trim();
  if (displayName && displayName.trim()) {
    try {
      await updateProfile(user, { displayName: displayName.trim() });
      displayNameUpdated = true;
    } catch {
      // The caller persists the name in Firestore and reports this partial result.
      displayNameUpdated = false;
    }
  }
  let verificationEmailSent = true;
  try {
    await sendEmailVerification(user);
  } catch {
    // Return an explicit status so the UI can explain the retry path.
    verificationEmailSent = false;
  }
  await user.getIdToken(true);
  return { user, displayNameUpdated, verificationEmailSent };
}

export async function signInPermanent(email: string, password: string): Promise<User> {
  return (await signInWithEmailAndPassword(requireAuth(), email.trim(), password)).user;
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
      // Do not silently switch to a different UID and strand this guest's data.
      throw error;
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
    "auth/email-already-in-use": "That email already has an account. Your guest data remains in this session; signing in switches to that account.",
    "auth/credential-already-in-use": "That sign-in is already linked to another account. Your guest data is still on this device.",
    "auth/account-exists-with-different-credential": "An account already exists with this email using another sign-in method. Sign in with that method; your guest data is still on this device.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Use a password with at least 8 characters.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/wrong-password": "The email or password is incorrect.",
    "auth/user-not-found": "The email or password is incorrect.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.",
    "auth/cancelled-popup-request": "Another sign-in window is already open. Finish it or try again.",
    "auth/network-request-failed": "SmartWatts could not reach Firebase. Check your connection and try again.",
    "auth/unauthorized-domain": "This site is not authorized for Firebase sign-in. Use an approved domain or contact support.",
    "auth/operation-not-allowed": "This sign-in method is not enabled for this Firebase project.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/requires-recent-login": "Please sign in again before making this account change.",
  };
  if (messages[code]) return messages[code];
  return "We couldn't complete authentication. Please try again.";
}
