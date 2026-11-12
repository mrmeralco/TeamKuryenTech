// Keeps a SmartWatts Rentals invitation while a signed-out visitor logs in or registers.
// The dashboard's session guard sends signed-out visitors here as "/#join=<token>".
// The token is saved to this tab's sessionStorage, removed from the address bar, and the
// dashboard opens the invitation after sign-in. The fragment is never sent to a server.
(function () {
  var KEY = "smartwatts-pending-invite";
  var match = window.location.hash.match(/^#join=([A-Za-z0-9_-]{20,200})$/);
  if (match) {
    try {
      sessionStorage.setItem(KEY, match[1]);
    } catch (error) {
      return;
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  var pending = false;
  try { pending = Boolean(sessionStorage.getItem(KEY)); } catch (error) { pending = false; }
  if (!pending) return;
  function showNotice() {
    if (document.getElementById("swInviteNotice")) return;
    var note = document.createElement("div");
    note.id = "swInviteNotice";
    note.setAttribute("role", "status");
    note.textContent = "You have a SmartWatts Rentals invitation. Log in or create an account to accept it.";
    note.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;max-width:min(92vw,520px);" +
      "padding:12px 18px;border-radius:14px;background:#fff4e6;color:#4a2c00;border:2px solid #ffb35c;" +
      "font:700 14px Nunito,system-ui,sans-serif;box-shadow:0 10px 30px rgba(80,40,0,.18);text-align:center";
    document.body.appendChild(note);
  }
  if (document.body) showNotice();
  else document.addEventListener("DOMContentLoaded", showNotice);
})();
