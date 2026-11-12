import { requestPasswordReset, resetPasswordWithCode, friendlyError } from "/landing/auth.js";

const $ = (id) => document.getElementById(id);
const msg = (text, kind) => { $("msg").textContent = text || ""; $("msg").className = "msg" + (kind ? " " + kind : ""); };
let email = "";

const preset = new URLSearchParams(location.search).get("email");
if (preset) $("email").value = preset;

function show(step) {
  $("emailForm").hidden = step !== "email";
  $("codeForm").hidden = step !== "code";
  $("linkSent").hidden = step !== "link";
  $("s2").classList.toggle("on", step !== "email");
  document.querySelectorAll(".sentTo").forEach((el) => (el.textContent = email));
  if (step === "code") $("code").focus();
}

async function send() {
  let mode;
  try {
    mode = await requestPasswordReset(email);
  } catch (err) {
    if (err && err.code === "auth/user-not-found") mode = "link"; // don't reveal whether an account exists
    else throw err;
  }
  show(mode);
}

$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  email = $("email").value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return msg("Enter a valid email address.", "err");
  $("submit1").disabled = true; msg("");
  try { await send(); } catch (err) { msg(friendlyError(err), "err"); }
  $("submit1").disabled = false;
});

$("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("code").value.trim(), password = $("password").value;
  if (!/^\d{6}$/.test(code)) return msg("Enter the 6-digit code.", "err");
  if (password.length < 8) return msg("Use a password with at least 8 characters.", "err");
  if (password !== $("password2").value) return msg("Passwords don’t match.", "err");
  $("submit2").disabled = true; msg("");
  try {
    await resetPasswordWithCode(email, code, password);
    location.replace("/login?reset=1");
  } catch (err) {
    msg(friendlyError(err), "err");
    $("submit2").disabled = false;
  }
});

document.querySelectorAll(".resend").forEach((b) => b.addEventListener("click", async () => {
  msg("");
  try { await send(); msg("Sent again.", "ok"); } catch (err) { msg(friendlyError(err), "err"); }
}));
document.querySelectorAll(".change").forEach((b) => b.addEventListener("click", () => { show("email"); msg(""); }));
