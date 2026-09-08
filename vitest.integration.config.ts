import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Integration tests: the real service layer against a real Postgres.
 *
 * Separate from `vitest.config.ts` on purpose — `npm test` must stay offline
 * and fast, and this suite needs a database and takes seconds per file.
 *
 * Jumio itself is always stubbed. These tests prove our persistence and
 * ordering rules, not Jumio's behaviour.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./vitest.integration.setup.ts"],
    // One database, shared rows: parallel files would race on cleanup.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
