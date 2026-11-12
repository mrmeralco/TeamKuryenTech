// Starts loading the auth module early; pages await window.SWAuthReady (was an inline script).
window.SWAuthReady = import("/landing/auth.js");
