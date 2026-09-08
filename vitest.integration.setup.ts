import { config as loadEnv } from "dotenv";

/**
 * Point the Prisma singleton at the throwaway Neon branch.
 *
 * `src/lib/prisma.ts` reads `DATABASE_URL` at module load, so the swap has to
 * happen here — setup files run before any test file is imported.
 *
 * The guard is the point: without it, a missing `TEST_DATABASE_URL` would
 * silently leave `DATABASE_URL` pointing at the development database, and this
 * suite deletes rows.
 */
loadEnv();

const testUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. The integration suite needs a throwaway Neon branch — " +
      "it will not run against DATABASE_URL. See .env.example.",
  );
}

if (testUrl === process.env.DATABASE_URL?.trim()) {
  throw new Error("TEST_DATABASE_URL must not be the same database as DATABASE_URL.");
}

process.env.DATABASE_URL = testUrl;

// Fake Jumio credentials. Every test injects a stub client, so nothing here is
// ever sent anywhere — they exist only so `getJumioConfig()` resolves.
process.env.JUMIO_CLIENT_ID ??= "test-client-id";
process.env.JUMIO_CLIENT_SECRET ??= "test-client-secret";
process.env.JUMIO_DATACENTER = "amer-1";
process.env.JUMIO_WORKFLOW_KEY = "10549";
process.env.JUMIO_CALLBACK_SECRET = "test-callback-secret";
process.env.NEXT_PUBLIC_APP_URL = "https://example.test";
