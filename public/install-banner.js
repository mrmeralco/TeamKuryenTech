/*
 * SmartWatts "Download app now" banner.
 *
 * Plain script (no build step) so it runs on both the landing pages and the dashboard.
 * - Chrome / Edge / Android: waits for `beforeinstallprompt`, then shows a top bar whose
 *   button opens the browser's own install dialog (installs the SmartWatts web app).
 * - iPhone / iPad Safari (no install prompt API): the button explains Share > Add to Home Screen.
 * - Hidden when already running as the installed app, or for 7 days after the user closes it.
 */
(function () {
  "use strict";

  var DISMISS_KEY = "sw-install-dismissed-at";
  var DISMISS_DAYS = 7;

  function isStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  }

  function recentlyDismissed() {
    try {
      var at = Number(localStorage.getItem(DISMISS_KEY) || 0);
      return at > 0 && Date.now() - at < DISMISS_DAYS * 864e5;
    } catch (e) {
      return false;
    }
  }

  function rememberDismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) { /* storage blocked */ }
  }

  var ua = navigator.userAgent || "";
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

  if (isStandalone()) return;

  var deferredPrompt = null;
  var bar = null;

  var CSS = [
    ":root{--sw-install-bar-h:0px}",
    ".sw-install-bar{position:fixed;inset:0 0 auto 0;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:14px;",
    "padding:9px 48px 9px 16px;background:linear-gradient(90deg,#ff6a00,#ff8a1f 55%,#f5ad3c);color:#1d1712;",
    "font:600 14px/1.3 Inter,Nunito,system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 2px 12px rgba(80,40,0,.18);",
    "transform:translateY(-100%);transition:transform .28s ease}",
    ".sw-install-bar.is-shown{transform:none}",
    ".sw-install-bar img{width:30px;height:30px;border-radius:8px;flex:none;background:#fffaf2;box-shadow:0 0 0 2px rgba(255,255,255,.55)}",
    ".sw-install-text{display:flex;flex-direction:column;min-width:0}",
    ".sw-install-text b{font-weight:800;font-size:14.5px;color:#1d1712}",
    ".sw-install-text small{font-weight:600;font-size:12px;color:#3d2a17;opacity:.9}",
    ".sw-install-btn{flex:none;display:inline-flex;align-items:center;gap:7px;border:0;border-radius:999px;padding:8px 16px;cursor:pointer;",
    "background:#1d1712;color:#fff;font-family:inherit;font-weight:800;font-size:13.5px;line-height:1;box-shadow:0 2px 0 rgba(0,0,0,.25)}",
    ".sw-install-btn:hover{background:#000}",
    ".sw-install-btn:focus-visible,.sw-install-close:focus-visible{outline:3px solid #fff;outline-offset:2px}",
    ".sw-install-btn svg{width:16px;height:16px}",
    ".sw-install-close{position:absolute;right:10px;top:50%;transform:translateY(-50%);width:30px;height:30px;border:0;border-radius:50%;",
    "background:transparent;color:#1d1712;font-size:20px;line-height:1;cursor:pointer}",
    ".sw-install-close:hover{background:rgba(0,0,0,.1)}",
    ".sw-install-tip{position:fixed;z-index:2147483001;left:50%;transform:translateX(-50%);top:calc(var(--sw-install-bar-h) + 10px);",
    "max-width:min(92vw,360px);background:#1d1712;color:#fff;border-radius:14px;padding:12px 14px;font:500 13.5px/1.45 Inter,system-ui,sans-serif;",
    "box-shadow:0 10px 30px rgba(0,0,0,.25)}",
    ".sw-install-tip b{color:#ffb15c}",
    /* Desktop: a top bar; make room for it (page, fixed sidebar, sticky topbar / header move down). */
    "@media (min-width:701px){html.sw-has-install-bar body{padding-top:var(--sw-install-bar-h)}",
    "html.sw-has-install-bar .sidebar{top:var(--sw-install-bar-h)}",
    "html.sw-has-install-bar .topbar{top:calc(10px + var(--sw-install-bar-h))}",
    "html.sw-has-install-bar header[style*='position: sticky']{top:var(--sw-install-bar-h)!important}}",
    ".sw-short{display:none}",
    /* Phones: a floating card above the bottom tab bar; it never moves or covers the page header. */
    "@media (max-width:700px){.sw-install-bar{inset:auto 10px calc(var(--sw-install-bottom,0px) + 12px + env(safe-area-inset-bottom,0px)) 10px;",
    "border-radius:16px;justify-content:flex-start;gap:10px;padding:10px 44px 10px 12px;transform:translateY(calc(100% + 140px));",
    "box-shadow:0 10px 30px rgba(80,40,0,.3)}.sw-install-text small,.sw-long{display:none}.sw-short{display:inline}",
    ".sw-install-btn{margin-left:auto;padding:8px 13px}.sw-install-tip{top:auto;bottom:calc(var(--sw-install-bottom,0px) + 96px)}}",
    "@media (prefers-reduced-motion:reduce){.sw-install-bar{transition:none}}",
  ].join("");

  var DOWNLOAD_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';

  var phone = window.matchMedia ? window.matchMedia("(max-width:700px)") : { matches: false };
  var lastH = -1, lastBottom = -1;

  // Only writes when a value really changes, so scrolling (mobile URL bar) never re-lays out the page.
  function syncHeight() {
    var shown = bar && bar.classList.contains("is-shown");
    var h = shown && !phone.matches ? bar.offsetHeight : 0;
    var tabbar = document.querySelector(".mobile-tabbar");
    var bottom = tabbar && getComputedStyle(tabbar).display !== "none" ? tabbar.offsetHeight : 0;
    var root = document.documentElement;
    if (h !== lastH) {
      lastH = h;
      root.style.setProperty("--sw-install-bar-h", h + "px");
      root.classList.toggle("sw-has-install-bar", h > 0);
    }
    if (bottom !== lastBottom) {
      lastBottom = bottom;
      root.style.setProperty("--sw-install-bottom", bottom + "px");
    }
  }

  function hide(remember) {
    if (remember) rememberDismiss();
    if (!bar) return;
    bar.classList.remove("is-shown");
    var tip = document.querySelector(".sw-install-tip");
    if (tip) tip.remove();
    syncHeight();
  }

  function showIOSTip() {
    var old = document.querySelector(".sw-install-tip");
    if (old) { old.remove(); return; }
    var tip = document.createElement("div");
    tip.className = "sw-install-tip";
    tip.setAttribute("role", "status");
    tip.innerHTML = "To install SmartWatts: tap the <b>Share</b> button in Safari, then choose <b>Add to Home Screen</b>.";
    document.body.appendChild(tip);
    setTimeout(function () { tip.remove(); }, 9000);
  }

  function onDownload() {
    if (deferredPrompt) {
      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      promptEvent.prompt();
      promptEvent.userChoice.then(function (choice) {
        hide(choice && choice.outcome === "dismissed");
      });
      return;
    }
    if (isIOSSafari) showIOSTip();
  }

  function show() {
    if (recentlyDismissed() || isStandalone()) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", show, { once: true });
      return;
    }
    if (!bar) {
      var style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);

      bar = document.createElement("div");
      bar.className = "sw-install-bar";
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "Download the SmartWatts app");
      bar.innerHTML =
        '<img src="/smartwatts-icon-192.png" alt="" width="30" height="30">' +
        '<span class="sw-install-text"><b><span class="sw-long">Download the SmartWatts app now</span>' +
        '<span class="sw-short">Get the SmartWatts app</span></b>' +
        "<small>Open it in one tap from your home screen or desktop.</small></span>" +
        '<button type="button" class="sw-install-btn">' + DOWNLOAD_ICON + "Download app</button>" +
        '<button type="button" class="sw-install-close" aria-label="Close">&times;</button>';
      bar.querySelector(".sw-install-btn").addEventListener("click", onDownload);
      bar.querySelector(".sw-install-close").addEventListener("click", function () { hide(true); });
      document.body.prepend(bar);
      if (window.ResizeObserver) new ResizeObserver(syncHeight).observe(bar);
      if (phone.addEventListener) phone.addEventListener("change", syncHeight);
    }
    requestAnimationFrame(function () {
      bar.classList.add("is-shown");
      syncHeight();
    });
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault(); // keep the browser's mini-infobar away; our bar opens the dialog instead
    deferredPrompt = event;
    show();
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    hide(false);
  });

  if (isIOSSafari) show();
})();
