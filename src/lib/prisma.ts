import { PrismaNeon } from "@prisma/adapter-neon";

import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 has no built-in database driver — every client is constructed with a
// driver adapter. `PrismaNeon` pools over Neon's serverless WebSocket driver,
// which is what survives the short-lived processes Next.js runs on.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Add your Neon connection string to .env.");
}

const createPrismaClient = () =>
  new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });

// `next dev` reloads modules on every edit; without this the reloads would each
// open a new pool until Neon refuses connections.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
