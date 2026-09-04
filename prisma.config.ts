// Prisma CLI configuration. The CLI does not read `.env` on its own (unlike
// `next dev`), so dotenv is loaded here to make DATABASE_URL available to
// `prisma migrate`, `prisma db push` and `prisma studio`.
import "dotenv/config";

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations take a session-level advisory lock, which Neon's connection
    // pooler does not support — so the CLI uses the unpooled host when one is
    // configured. The app itself still runs on the pooled DATABASE_URL via
    // src/lib/prisma.ts.
    url: process.env.DIRECT_URL ?? env("DATABASE_URL"),
  },
});
