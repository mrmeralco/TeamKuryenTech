/**
 * Connects the dashboard to the landing login/register pages.
 *
 *  - Not logged in, guest (anonymous) or email not verified -> send to the landing page.
 *  - Logging out (topbar button or Account Settings "Sign out") -> back to the landing page.
 *  - Shows the signed-in user's initials on the avatar.
 *
 * When Firebase isn't configured the dashboard keeps running in local demo mode.
 */
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { auth } from "./firebase";

const LANDING_URL = "/";

/** Verified by Firebase (Google) or by the SmartWatts email code (checked on the backend). */
async function isSignedIn(user: User | null): Promise<boolean> {
  if (!user || user.isAnonymous) return false;
  if (user.emailVerified) return true;
  try {
    const res = await fetch("/api/auth/status", { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
    return res.ok && (await res.json()).verified === true;
  } catch {
    return false;
  }
}

function initials(user: User): string {
  const source = user.displayName?.trim() || user.email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2);
  return letters.toUpperCase() || "ME";
}

function leave(): void {
  window.location.replace(LANDING_URL);
}

export async function logout(): Promise<void> {
  if (auth) await signOut(auth);
  leave();
}

function showUser(user: User): void {
  const avatar = document.querySelector<HTMLElement>(".topbar .avatar");
  if (avatar) {
    avatar.title = user.displayName || user.email || "";
    if (user.photoURL) {
      const img = document.createElement("img");
      img.src = user.photoURL;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover";
      img.onerror = () => { avatar.textContent = initials(user); };
      avatar.replaceChildren(img);
    } else {
      avatar.textContent = initials(user);
    }
  }
}

async function start(): Promise<void> {
  const firebaseAuth = auth;
  document.getElementById("logoutButton")?.addEventListener("click", () => {
    logout().catch(() => leave());
  });
  if (!firebaseAuth) {
    document.documentElement.classList.remove("auth-pending");
    return;
  }
  await firebaseAuth.authStateReady();
  const current = firebaseAuth.currentUser;
  if (!current || !(await isSignedIn(current))) return leave();
  showUser(current);
  document.documentElement.classList.remove("auth-pending");

  // Signing out anywhere in the app (or in another tab) returns to the landing page.
  onAuthStateChanged(firebaseAuth, (user) => {
    if (!user || user.isAnonymous || user.uid !== current.uid) leave();
    else showUser(user);
  });
}

start().catch(() => leave());
