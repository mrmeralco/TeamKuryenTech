import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  verifyPasswordResetCode, confirmPasswordReset,
  EmailAuthProvider, linkWithCredential, updateProfile,
  GoogleAuthProvider, signInWithPopup, linkWithPopup, signInWithCredential,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { firebaseConfig, DASHBOARD_URL } from "./firebase-config.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export { DASHBOARD_URL };

export function goToDashboard() { window.location.replace(DASHBOARD_URL); }

/** Resolves with the current user once Firebase has restored the session. */
export async function currentUser() {
  await auth.authStateReady();
  return auth.currentUser;
}

/**
 * Fully signed up = permanent account whose email is verified: either by Firebase
 * (Google accounts) or by the SmartWatts email code (checked on the backend).
 */
export async function isComplete(u) {
  if (!u || u.isAnonymous) return false;
  if (u.emailVerified) return true;
  try {
    const res = await fetch("/api/auth/status", { headers: { Authorization: `Bearer ${await u.getIdToken()}` } });
    return res.ok && (await res.json()).verified === true;
  } catch {
    return false;
  }
}

/** Google sign-in / sign-up. Links to an anonymous session when possible so data is kept. */
let googlePending = null;
export function continueWithGoogle() {
  // One popup at a time: a second click while it's open used to cause auth/cancelled-popup-request.
  return (googlePending ??= (async () => {
    await auth.authStateReady();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const current = auth.currentUser;
    if (current && current.isAnonymous) {
      try { return (await linkWithPopup(current, provider)).user; }
      catch (e) {
        if (e.code !== "auth/credential-already-in-use") throw e;
        // That Google account already exists: sign in with the credential we just got (no second popup).
        const credential = GoogleAuthProvider.credentialFromError(e);
        if (credential) return (await signInWithCredential(auth, credential)).user;
      }
    }
    return (await signInWithPopup(auth, provider)).user;
  })().finally(() => { googlePending = null; }));
}

/** remember=false keeps the session only until the browser tab/window is closed. */
export async function login(email, password, remember = true) {
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return user;
}

/** Creates the account; links to an existing anonymous session so data is kept. */
export async function register({ name, email, password }) {
  await auth.authStateReady();
  const current = auth.currentUser;
  const user = current && current.isAnonymous
    ? (await linkWithCredential(current, EmailAuthProvider.credential(email, password))).user
    : (await createUserWithEmailAndPassword(auth, email, password)).user;
  if (name) await updateProfile(user, { displayName: name });
  return user;
}

// ------------------------------------------------------------------ email OTP (SmartWatts mailer, backend /api/auth)
async function api(path, body, { signedIn = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (signedIn) {
    const user = auth.currentUser;
    if (!user) throw new Error("Please log in first.");
    headers.Authorization = `Bearer ${await user.getIdToken()}`;
  }
  let res;
  try {
    res = await fetch(`/api/auth${path}`, { method: "POST", headers, body: JSON.stringify(body || {}) });
  } catch {
    throw new Error("Can't reach the SmartWatts server. Is the backend running?");
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? data.detail
      : res.status >= 500 && res.status !== 502 && res.status !== 503 ? "Can't reach the SmartWatts server. Is the backend running?"
      : Array.isArray(data.detail) ? "Some fields are missing or invalid." : `Request failed (${res.status}).`;
    throw new Error(detail);
  }
  return data;
}

/** Emails a branded 6-digit code (sent by the SmartWatts mailer) to the signed-in user. */
export const sendVerifyCode = () =>
  api("/email-code/verify/send", { name: auth.currentUser?.displayName || null }, { signedIn: true });

/** Confirms the emailed code; the backend records the account as verified. */
export async function confirmVerifyCode(code) {
  await api("/email-code/verify/confirm", { code, name: auth.currentUser?.displayName || null }, { signedIn: true });
  return auth.currentUser;
}

/** Forgot password: Firebase sends a reset link; it returns to our login page afterwards. */
export const sendResetLink = (email) =>
  sendPasswordResetEmail(auth, email, { url: `${window.location.origin}/login?reset=1` });

/**
 * Forgot password. With a service account on the server, SmartWatts emails its own designed
 * 6-digit code (returns "code"). Otherwise falls back to Firebase's reset link (returns "link").
 */
export async function requestPasswordReset(email) {
  try {
    await api("/password-reset/send", { email });
    return "code";
  } catch (err) {
    if (err && err.message === "firebase-reset-email") { await sendResetLink(email); return "link"; }
    throw err;
  }
}
export const resetPasswordWithCode = (email, code, newPassword) =>
  api("/password-reset/confirm", { email, code, new_password: newPassword });

/** /reset-password page: check the code from the email link, then set the new password. */
export const checkResetCode = (oobCode) => verifyPasswordResetCode(auth, oobCode);
export const setNewPassword = (oobCode, password) => confirmPasswordReset(auth, oobCode, password);

export function friendlyError(error) {
  const code = (error && error.code) || "";
  const map = {
    "auth/email-already-in-use": "That email already has an account. Log in instead.",
    "auth/credential-already-in-use": "That email already has an account. Log in instead.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Use a password with at least 8 characters.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/wrong-password": "The email or password is incorrect.",
    "auth/user-not-found": "The email or password is incorrect.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/operation-not-allowed": "This sign-in method is not enabled in Firebase yet.",
    "auth/expired-action-code": "This reset link has expired. Request a new one.",
    "auth/invalid-action-code": "This reset link is invalid or was already used. Request a new one.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/cancelled-popup-request": "Google sign-in is already open in another window.",
    "auth/popup-blocked": "Your browser blocked the Google popup. Allow popups and try again.",
    "auth/unauthorized-domain": "This domain is not authorized in Firebase yet (Authentication > Settings > Authorized domains).",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return map[code] || (error && error.message) || "Something went wrong. Please try again.";
}
