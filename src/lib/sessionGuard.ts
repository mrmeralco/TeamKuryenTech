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
import { captureInviteFromHash, PENDING_INVITE_KEY } from "./pendingInvite";

const LANDING_URL = "/";

type SignedIn = "yes" | "no" | "unknown";

/**
 * Verified by Firebase (Google) or by the SmartWatts email code (checked on the backend).
 * "unknown" = the check itself failed (offline, rate limited, server error, browser check). That must NOT
 * send the user away: the landing page would see the Firebase session and send them straight back here,
 * looping between the two pages.
 */
async function checkSignedIn(user: User | null): Promise<SignedIn> {
  if (!user || user.isAnonymous) return "no";
  if (user.emailVerified) return "yes";
  try {
    const res = await fetch("/api/auth/status", { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
    if (res.status === 401) return "no";
    if (!res.ok) return "unknown";
    return (await res.json()).verified === true ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

async function isSignedIn(user: User | null): Promise<SignedIn> {
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const result = await checkSignedIn(user);
    if (result !== "unknown") return result;
  }
  return "unknown";
}

// Loop breaker: if this tab gets bounced off the dashboard again within a short time, something disagrees
// with the landing page's check. Sign out before leaving so the landing page cannot send the user back.
const BOUNCE_KEY = "smartwatts-dashboard-bounces";
const BOUNCE_WINDOW_MS = 30_000;

function recordBounce(): boolean {
  try {
    const now = Date.now();
    const recent = (JSON.parse(localStorage.getItem(BOUNCE_KEY) ?? "[]") as number[]).filter(
      (t) => typeof t === "number" && now - t < BOUNCE_WINDOW_MS,
    );
    recent.push(now);
    localStorage.setItem(BOUNCE_KEY, JSON.stringify(recent));
    return recent.length >= 2;
  } catch {
    return false;
  }
}

function clearBounces(): void {
  try {
    localStorage.removeItem(BOUNCE_KEY);
  } catch {
    /* storage blocked */
  }
}

async function bounce(): Promise<void> {
  if (recordBounce() && auth) {
    clearBounces();
    await signOut(auth).catch(() => undefined);
  }
  leave();
}

function initials(user: User): string {
  const source = user.displayName?.trim() || user.email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2);
  return letters.toUpperCase() || "ME";
}

function leave(): void {
  // Carry a pending rental invitation in the landing URL fragment (never sent to a server).
  // Writing sessionStorage right before an immediate redirect is not reliable on a tab's first load.
  let invite: string | null = null;
  try {
    invite = sessionStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    invite = null;
  }
  window.location.replace(invite ? `${LANDING_URL}#join=${invite}` : LANDING_URL);
}

export async function logout(): Promise<void> {
  if (auth) await signOut(auth);
  leave();
}

function showUser(user: User): void {
  const avatar = document.querySelector<HTMLElement>(".topbar .avatar");
  if (!avatar) return;
  avatar.title = user.email ? `${user.displayName ?? ""} (${user.email})`.trim() : user.displayName ?? "";
  avatar.setAttribute("aria-label", `Account: ${user.email ?? user.displayName ?? ""}`);
  const showInitials = () => {
    avatar.removeAttribute("style");
    avatar.textContent = initials(user);
  };
  if (!user.photoURL) return showInitials();

  // Profile photo of the signed-in account (e.g. the Google account picture), filling the whole circle.
  const img = document.createElement("img");
  img.src = user.photoURL;
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.style.cssText = "display:block;width:100%;height:100%;border-radius:50%;object-fit:cover";
  img.onerror = showInitials;
  avatar.style.cssText =
    "width:40px;height:40px;padding:0;overflow:hidden;border-radius:50%;background:#fff;border:2px solid #ff7a00;flex:none";
  avatar.replaceChildren(img);
}

async function start(): Promise<void> {
  // Runs before any redirect: keep a rental invitation link for after sign-in.
  captureInviteFromHash();
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
  if (!current) return leave();
  const signedIn = await isSignedIn(current);
  // Only a definite "not verified" leaves. If the check can't be reached, stay: the API still enforces
  // verification on every data request, so nothing is exposed.
  if (signedIn === "no") return bounce();
  clearBounces();
  showUser(current);
  document.documentElement.classList.remove("auth-pending");

  // Signing out anywhere in the app (or in another tab) returns to the landing page.
  onAuthStateChanged(firebaseAuth, (user) => {
    if (!user || user.isAnonymous || user.uid !== current.uid) leave();
    else showUser(user);
  });
}

start().catch(() => bounce());
