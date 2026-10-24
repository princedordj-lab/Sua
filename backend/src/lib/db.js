import { prisma } from "../config/prisma.js";

/**
 * Run `fn` inside a Prisma transaction with `app.current_user_id` set to the
 * signed-in Clerk user id. Postgres row-level security policies compare this
 * setting against users.clerkId, so every query in `fn` is automatically
 * scoped to the current student. The setting is transaction-local (set_config
 * with is_local=true) which is required behind Neon's pooled connection.
 */
export function withUser(clerkId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${clerkId}, true)`;
    return fn(tx);
  }, {
    // Neon compute wake-ups and transient network latency can exceed Prisma's
    // five-second interactive transaction default. These callbacks should
    // contain database work only; external I/O belongs outside withUser.
    maxWait: 10000,
    timeout: 15000,
  });
}
