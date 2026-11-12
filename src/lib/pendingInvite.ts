/**
 * Rental invitation tokens arrive as `/dashboard#join=<token>`.
 *
 * The token is moved into this tab's sessionStorage and removed from the address bar so it
 * is not kept in history. The session guard calls this before redirecting a signed-out
 * visitor to the landing page, so the invitation resumes after they sign in or register
 * in the same tab.
 */
export const PENDING_INVITE_KEY = "smartwatts-pending-invite";
const TOKEN = /^#join=([A-Za-z0-9_-]{20,200})$/;

export function captureInviteFromHash(): boolean {
  const match = window.location.hash.match(TOKEN);
  if (!match) return false;
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, match[1]);
  } catch {
    return false;
  }
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}

export function hasPendingInvite(): boolean {
  try {
    return Boolean(sessionStorage.getItem(PENDING_INVITE_KEY));
  } catch {
    return false;
  }
}
