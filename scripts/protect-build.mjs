#!/usr/bin/env node
// Production hardening of dist/ (run after `npm run build && node scripts/prepare-hosting.mjs`).
// Adapted from the Spotibai reference build.js / build-pass.js:
//  - SmartWatts' own JavaScript is obfuscated (vendor bundles such as Firebase, Mapbox, pdf.js, Tesseract and the
//    service worker are left alone: they are public code and obfuscating megabytes only slows the site down).
//    Debugger protection and console silencing are added once, to deterrents.js, which every page loads.
//  - HTML comments are stripped, and each page's body markup (with its inline styles and templates) leaves the
//    HTML and travels as an XOR + base64 payload inside an obfuscated loader script that writes it back into the
//    page before the app scripts run. View-source then shows only the head and script tags.
// Output stays in dist/ (git-ignored). Source of truth stays in the repo; never edit dist/.
// Honest limit: obfuscation slows reading and copying, it cannot hide code a browser has to run, and the live DOM
// in DevTools is the browser's. External .css files stay readable.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "landing", "index.html"))) {
  console.error("dist/ is incomplete: run `npm run build && node scripts/prepare-hosting.mjs` first.");
  process.exit(1);
}

// ---- JavaScript ----------------------------------------------------------------------------------------------
const VENDOR = /^(firebase|mapbox-gl|pdf|pdf\.worker|ocr|charts|workbox|tesseract)[-.]/i;
const SKIP_FILES = new Set(["sw.js", "registerSW.js", "support.js"]);   // service worker, PWA glue, landing runtime
const LARGE = 250 * 1024;

const base = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,           // keep exports / globals other files rely on (window.Chart, window.SWAuthReady...)
  stringArray: true,
  stringArrayEncoding: ["base64"],
  rotateStringArray: true,
  shuffleStringArray: true,
  selfDefending: true,
  log: false,
};
const light = { ...base, stringArrayThreshold: 0.5, splitStrings: false, controlFlowFlattening: false };
const full = {
  ...base, stringArrayThreshold: 0.8, splitStrings: true, splitStringsChunkLength: 8,
  controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.25, transformObjectKeys: true, numbersToExpressions: true,
};
const guard = { ...full, disableConsoleOutput: true, debugProtection: true, debugProtectionInterval: 4000 };

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === "vendor" ? [] : walk(p)) : [p];
  });
}

let jsCount = 0, jsBefore = 0, jsAfter = 0;
for (const file of walk(dist).filter((p) => /\.m?js$/.test(p))) {
  const name = basename(file);
  if (SKIP_FILES.has(name) || VENDOR.test(name) || name.startsWith("l.")) continue;
  const code = readFileSync(file, "utf8");
  const options = name === "deterrents.js" ? guard : code.length > LARGE ? light : full;
  const out = JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
  writeFileSync(file, out);
  jsCount++; jsBefore += code.length; jsAfter += out.length;
}

// ---- HTML ----------------------------------------------------------------------------------------------------
// Executable scripts must stay real <script> elements (markup inserted with insertAdjacentHTML never runs scripts);
// data templates such as <script type="text/x-dc"> travel inside the payload, where the landing runtime reads them.
const EXECUTABLE = /^<script(?![^>]*\btype=["']?(?!module\b|text\/javascript\b)[^"'\s>]+)[^>]*>/i;

function stripComments(html) {
  // Leave script/style/textarea contents untouched; drop <!-- comments --> elsewhere.
  return html.split(/(<(script|style|textarea)\b[\s\S]*?<\/\2>)/i).map((part, i) => {
    if (i % 3 === 1) return part;
    if (i % 3 === 2) return "";
    return part.replace(/<!--[\s\S]*?-->/g, "");
  }).join("");
}

function obfuscatedLoader(markup) {
  const key = randomBytes(24);
  const enc = Buffer.from(Buffer.from(markup, "utf8").map((b, i) => b ^ key[i % key.length])).toString("base64");
  return JavaScriptObfuscator.obfuscate(
    `(function(){var k=${JSON.stringify([...key])},s=atob(${JSON.stringify(enc)}),u=new Uint8Array(s.length),i;` +
    `for(i=0;i<s.length;i++)u[i]=s.charCodeAt(i)^k[i%k.length];` +
    `var t=document.currentScript;t.insertAdjacentHTML("afterend",new TextDecoder().decode(u));t.remove();})();`,
    { compact: true, identifierNamesGenerator: "hexadecimal", stringArray: true, stringArrayEncoding: ["rc4"],
      stringArrayThreshold: 1, splitStrings: true, splitStringsChunkLength: 16, selfDefending: true, log: false },
  ).getObfuscatedCode();
}

const pages = [join(dist, "index.html"), join(dist, "nfc.html"),
  ...readdirSync(join(dist, "landing")).filter((f) => f.endsWith(".html")).map((f) => join(dist, "landing", f))]
  .filter((p) => existsSync(p));

for (const page of pages) {
  let html = stripComments(readFileSync(page, "utf8"));
  const m = html.match(/(<body\b[^>]*>)([\s\S]*)(<\/body>)/i);
  if (!m) throw new Error(`${relative(dist, page)}: <body> not found`);
  const [whole, open, inner, close] = m;

  const kept = [];
  const markup = inner.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => {
    if (EXECUTABLE.test(tag) && /\bsrc=/.test(tag)) { kept.push(tag); return ""; }
    if (EXECUTABLE.test(tag)) throw new Error(`${relative(dist, page)}: inline executable script (move it to a file)`);
    return tag;   // data template: stays in the payload
  }).trim();

  const loader = obfuscatedLoader(markup);
  const name = `l.${createHash("sha256").update(loader).digest("hex").slice(0, 10)}.js`;
  writeFileSync(join(dist, name), loader);
  html = html.replace(whole, () => `${open}<script src="/${name}"></script>${kept.join("")}${close}`);
  writeFileSync(page, html);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`protect-build: obfuscated ${jsCount} script(s) (${kb(jsBefore)} -> ${kb(jsAfter)}), hid the markup of ${pages.length} page(s).`);
