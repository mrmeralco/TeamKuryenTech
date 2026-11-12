import { defineConfig } from "vitest/config";

// Security Rules tests run against the Firebase Emulator Suite:
//   npm run test:rules
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rules/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
