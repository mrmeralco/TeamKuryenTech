/*
 * In-page deterrents, adapted from the Spotibai reference (web/index.html lines 1998-2023).
 * Off on localhost / 127.0.0.1 (add ?shield to test them there).
 * Kept for SmartWatts users: selecting, copying and printing text (bill figures, invite links, statements).
 * Honest limit: these only slow people down; the server-side checks are the real protection.
 */
(function () {
  "use strict";
  var host = location.hostname;
  var dev = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (dev && !/[?&]shield\b/.test(location.search)) return;

  var block = function (e) { e.preventDefault(); e.stopPropagation(); return false; };

  // Automated browsers (puppeteer, playwright, selenium) announce themselves: show them nothing.
  if (navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent)) {
    document.documentElement.innerHTML = "";
    return;
  }

  // No context menu, except in form fields (paste / spell-check suggestions keep working).
  document.addEventListener("contextmenu", function (e) {
    if (!(e.target.closest && e.target.closest("input,textarea,[contenteditable]"))) block(e);
  });
  document.addEventListener("dragstart", function (e) { if (e.target && e.target.tagName === "IMG") block(e); });

  // DevTools / view-source shortcuts: F12, Ctrl/Cmd+Shift+I/J/C/E/K, Ctrl/Cmd+U (source), Ctrl/Cmd+S (save page).
  document.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "F12" || (ctrl && e.shiftKey && "ijcek".indexOf(k) !== -1 && k) || (ctrl && !e.shiftKey && (k === "u" || k === "s"))
        || (e.metaKey && e.altKey && "iuj".indexOf(k) !== -1 && k)) block(e);
  }, true);

  // Blur the page while docked DevTools are open.
  var style = document.createElement("style");
  style.textContent = "html.sw-devtools-open body{filter:blur(14px);pointer-events:none;user-select:none}";
  (document.head || document.documentElement).appendChild(style);
  var open = false;
  setInterval(function () {
    var big = outerWidth - innerWidth > 200 || outerHeight - innerHeight > 200;
    if (big !== open) { open = big; document.documentElement.classList.toggle("sw-devtools-open", open); }
  }, 1000);
})();
