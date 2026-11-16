#!/usr/bin/env node
// Production build for Cloudflare: `npm run build:prod` with the deploy guard on (vite.config.ts refuses to build
// without the production VITE_FIREBASE_* values or with the emulators switched on), then dist/ preparation.
// Local only: nothing is uploaded.
import { spawnSync } from "node:child_process";

const env = { ...process.env, SMARTWATTS_DEPLOY_BUILD: "cloudflare" };
for (const [cmd, args] of [["npm", ["run", "build:prod"]], ["node", ["scripts/cloudflare-assets.mjs"]]]) {
  const run = spawnSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
