#!/usr/bin/env node
// Copies the raw landing pages (served unbundled, exactly as Apache serves them from landing/) into
// dist/landing so a static host (Firebase Hosting `public: "dist"`) can serve /, /login, /register, ...
// Run after `npm run build`. Never copies anything outside landing/ (no .env, backend or sources).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "nfc.html"))) {
  console.error("dist/index.html or dist/nfc.html is missing: run `npm run build` first.");
  process.exit(1);
}
const target = join(dist, "landing");
rmSync(target, { recursive: true, force: true });
cpSync(join(root, "landing"), target, { recursive: true, filter: (src) => !src.endsWith("README.md") });
console.log("Copied landing/ -> dist/landing");
