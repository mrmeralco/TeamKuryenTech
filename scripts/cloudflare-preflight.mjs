#!/usr/bin/env node
// Checks a Cloudflare environment before it is deployed. Read-only: never uploads or changes anything.
//
//   node scripts/cloudflare-preflight.mjs preview      (or production)
//
// Fails when: the environment's BACKEND_ORIGIN is not an https URL, PUBLIC_HOSTNAME is empty (production), dist/ was not
// prepared by `npm run build:cloudflare` (whose guard rejects emulator or missing Firebase settings) in the last 24 h.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envName = process.argv[2];
if (!["preview", "production"].includes(envName)) {
  console.error("Usage: node scripts/cloudflare-preflight.mjs <preview|production>");
  process.exit(2);
}

/** Removes // and /* *\/ comments and trailing commas from JSONC, leaving string contents (URLs) untouched. */
export function parseJsonc(text) {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const problems = [];
const config = parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
const vars = config.env?.[envName]?.vars ?? {};
let origin;
try {
  origin = new URL(vars.BACKEND_ORIGIN || "");
} catch {
  origin = null;
}
if (!origin || origin.protocol !== "https:") problems.push(`env.${envName}.vars.BACKEND_ORIGIN must be the https URL of the Cloud Run service.`);
// Used by the production Cron Trigger (notification scheduler); optional for preview.
if (envName === "production" && !String(vars.PUBLIC_HOSTNAME || "").trim()) problems.push("env.production.vars.PUBLIC_HOSTNAME must be the public hostname (needed by the notification scheduler).");
if (/^https?:\/\//.test(vars.PUBLIC_HOSTNAME || "")) problems.push("PUBLIC_HOSTNAME is a hostname, without https://.");
if (!config.env?.[envName]?.ratelimits?.length) problems.push(`env.${envName}.ratelimits is missing.`);

const dist = join(root, "dist");
const marker = join(dist, ".cloudflare-build.json");
if (!existsSync(join(dist, "_headers")) || !existsSync(marker)) {
  // The marker is written only by `npm run build:cloudflare`, whose Vite deploy guard refuses to build without the
  // production VITE_FIREBASE_* values or with VITE_USE_FIREBASE_EMULATORS=true.
  problems.push("dist/ was not built with `npm run build:cloudflare` (production Firebase config guard).");
} else {
  const { builtAt } = JSON.parse(readFileSync(marker, "utf8"));
  const hours = (Date.now() - Date.parse(builtAt)) / 3.6e6;
  if (!(hours < 24)) problems.push(`dist/ was built ${Math.round(hours)} h ago: rebuild with \`npm run build:cloudflare\`.`);
}

if (problems.length) {
  console.error(`Cloudflare preflight (${envName}) FAILED:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`Cloudflare preflight (${envName}) OK: backend ${origin.origin}${vars.PUBLIC_HOSTNAME ? `, public host ${vars.PUBLIC_HOSTNAME}` : ""}.`);
