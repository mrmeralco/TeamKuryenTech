import { checkResetCode, setNewPassword, friendlyError } from "/landing/auth.js";

const $ = (id) => document.getElementById(id);
const msg = (text, kind) => { $("msg").textContent = text || ""; $("msg").className = "msg" + (kind ? " " + kind : ""); };
const params = new URLSearchParams(location.search);
const oobCode = params.get("oobCode");

function showBad(text) { $("loading").hidden = true; $("bad").hidden = false; $("badText").textContent = text; }

if (params.get("mode") && params.get("mode") !== "resetPassword") {
  showBad("This link isn’t a password reset link.");
} else if (!oobCode) {
  showBad("This reset link is incomplete. Request a new one.");
} else {
  checkResetCode(oobCode)
    .then((email) => { $("loading").hidden = true; $("resetForm").hidden = false; $("forEmail").textContent = email; $("password").focus(); })
    .catch((err) => showBad(friendlyError(err)));
}

$("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("password").value;
  if (password.length < 8) return msg("Use a password with at least 8 characters.", "err");
  if (password !== $("password2").value) return msg("Passwords don’t match.", "err");
  $("submit").disabled = true; msg("");
  try {
    await setNewPassword(oobCode, password);
    location.replace("/login?reset=1");
  } catch (err) {
    msg(friendlyError(err), "err");
    $("submit").disabled = false;
  }
});
