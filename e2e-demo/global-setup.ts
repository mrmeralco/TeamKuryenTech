import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

/** Seeds the fixture through the real CLI (twice, to prove idempotency) and records the result for the spec. */
export default function globalSetup() {
  const env = {
    ...process.env,
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8380",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399",
  };
  const run = (...extra: string[]) => JSON.parse(execFileSync(
    "backend/.venv/bin/python",
    ["scripts/seed_demo_data.py", "--project", "demo-smartwatts", "--json", ...extra],
    { env, encoding: "utf8" },
  ));
  const preview = run("--create-emulator-accounts"); // dry run: creates nothing
  const first = run("--create-emulator-accounts", "--apply");
  const second = run("--apply");
  if (first.result !== "seeded" || second.result !== "already-seeded" || second.propertyId !== first.propertyId) {
    throw new Error(`Unexpected seed results: ${first.result} / ${second.result}`);
  }
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/demo-seed.json", JSON.stringify({ preview, first, second }, null, 2));
  process.env.DEMO_PROPERTY_ID = first.propertyId;
}
