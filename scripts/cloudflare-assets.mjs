#!/usr/bin/env node
// Prepares dist/ for Cloudflare Workers Static Assets (run after `npm run build:prod`; `npm run build:cloudflare`
// does both). Writes:
//   dist/_headers       security headers for files served straight from the asset store (the same list the
//                       Worker and the backend send: cloudflare/security-headers.json) + cache rules
//   dist/.assetsignore  files never uploaded
// and checks that every page and entry file the Worker maps to exists, so a broken build is never deployed.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const headers = JSON.parse(readFileSync(join(root, "cloudflare", "security-headers.json"), "utf8"));

const REQUIRED = [
  "index.html", "nfc.html", "landing/index.html", "landing/login.html", "landing/register.html",
  "landing/forgot-password.html", "landing/reset-password.html", "sw.js", "manifest.webmanifest",
  "shield-client.js", "robots.txt",
];
const missing = REQUIRED.filter((file) => !existsSync(join(dist, file)));
if (missing.length) {
  console.error(`dist/ is incomplete (missing: ${missing.join(", ")}). Run \`npm run build:prod\` first.`);
  process.exit(1);
}

// A stale _redirects (e.g. from an earlier Pages experiment) would add rules the Worker does not expect.
rmSync(join(dist, "_redirects"), { force: true });

const block = (pattern, entries) => [pattern, ...entries.map(([k, v]) => `  ${k}: ${v}`)].join("\n");
const noCache = [["Cache-Control", "no-cache"]];
const rules = [
  block("/*", Object.entries(headers)),
  block("/assets/*", [["Cache-Control", "public, max-age=31536000, immutable"]]), // content-hashed by Vite
  block("/sw.js", noCache),
  block("/registerSW.js", noCache),
  block("/manifest.webmanifest", noCache),
  block("/workbox-*", noCache),
  block("/index.html", noCache),
  block("/nfc.html", noCache),
];
writeFileSync(join(dist, "_headers"), rules.join("\n") + "\n");
writeFileSync(join(dist, ".assetsignore"), ["*.map", ".DS_Store", "README.md", ".cloudflare-build.json", ""].join("\n"));
if (process.env.SMARTWATTS_DEPLOY_BUILD === "cloudflare") {
  // Read by scripts/cloudflare-preflight.mjs: this dist/ passed the production Firebase config guard.
  writeFileSync(join(dist, ".cloudflare-build.json"), JSON.stringify({ builtAt: new Date().toISOString() }) + "\n");
} else {
  rmSync(join(dist, ".cloudflare-build.json"), { force: true });
}

// Workers Static Assets limits: 25 MiB per file, 20,000 files (Free plan).
const files = [];
const walk = (dir) => readdirSync(dir).forEach((name) => {
  const p = join(dir, name);
  statSync(p).isDirectory() ? walk(p) : files.push(p);
});
walk(dist);
const tooBig = files.filter((p) => statSync(p).size > 25 * 1024 * 1024).map((p) => relative(dist, p));
if (tooBig.length) {
  console.error(`Files over the 25 MiB Workers asset limit: ${tooBig.join(", ")}`);
  process.exit(1);
}
if (files.length > 20000) {
  console.error(`${files.length} files: over the 20,000 file Workers asset limit.`);
  process.exit(1);
}
console.log(`dist/ ready for Cloudflare: ${files.length} files, _headers and .assetsignore written.`);
