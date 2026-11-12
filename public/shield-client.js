/*
 * Keeps the app working when the browser-check cookie expires while a page is open (or an installed PWA serves
 * its cached page): if a same-origin /api/ request is refused with "Verification required", solve a fresh
 * proof-of-work puzzle (GET /__t, then GET /__v), and retry the request once.
 */
(function () {
  "use strict";
  if (!window.fetch || !window.crypto || !crypto.subtle) return;
  var nativeFetch = window.fetch.bind(window);
  var pending = null;

  function leadingZeros(bytes, d) {
    for (var i = 0; i < d; i++) if (((i & 1) ? bytes[i >> 1] & 15 : bytes[i >> 1] >> 4) !== 0) return false;
    return true;
  }

  async function solve() {
    var res = await nativeFetch("/__t", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw new Error("check unavailable");
    var p = await res.json(), enc = new TextEncoder();
    for (var n = 0; ; n++) {
      var hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(p.t + ":" + n)));
      if (leadingZeros(hash, p.d)) break;
    }
    var ok = await nativeFetch("/__v?t=" + encodeURIComponent(p.t) + "&n=" + n, { credentials: "same-origin", cache: "no-store" });
    if (!ok.ok) throw new Error("check failed");
  }

  function sameOriginApi(input) {
    try {
      var url = new URL(typeof input === "string" ? input : input.url, location.href);
      return url.origin === location.origin && url.pathname.indexOf("/api/") === 0;
    } catch (_) { return false; }
  }

  window.fetch = async function (input, init) {
    var retryable = sameOriginApi(input) && !(input instanceof Request);
    var response = await nativeFetch(input, init);
    if (!retryable || response.status !== 403) return response;
    var body;
    try { body = await response.clone().json(); } catch (_) { return response; }
    if (!body || body.detail !== "Verification required") return response;
    try {
      pending = pending || solve().finally(function () { pending = null; });
      await pending;
    } catch (_) { return response; }
    return nativeFetch(input, init);
  };
})();
