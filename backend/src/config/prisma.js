import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prisma = new PrismaClient({
  adapter,
  transactionOptions: {
    // Neon can take longer than Prisma's 2s default to provide a pooled
    // connection after idle periods or brief bursts of concurrent requests.
    // Keep transactions themselves short; only extend the acquisition wait.
    maxWait: 10_000,
  },
});
