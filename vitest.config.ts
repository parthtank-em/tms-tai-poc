import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tests for pure logic — mapping, token caching, callback validation.
 *
 * Anything that reaches Prisma is deliberately out of scope here: it would need
 * a live Neon branch, which belongs in the manual end-to-end pass rather than
 * in a test run that has to work offline.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests need a database and their own setup, which enforces
    // that they never point at DATABASE_URL. Without this exclusion `npm test`
    // would pick them up and run those writes against the dev database.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
  },
});
