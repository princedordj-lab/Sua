import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

// Everything Prisma needs from a connection is a transaction's entire budget:
// each `withUser` is BEGIN + set_config + the route's queries + COMMIT, and every
// one of those statements is a WAN round trip to Neon. Slots are pinned for the
// whole transaction, so the pool size is a concurrency cap, not a comfort
// setting. The old code passed only `{connectionString}`, which left pg's own
// defaults in charge: `max: 10` per process and `connectionTimeoutMillis: 0` —
// never give up — so a Prisma `maxWait` timeout could orphan a socket that was
// still connecting.
//
// 5 is deliberately below the pooler's ceiling (measured `max_connections` is in
// the hundreds) and below pg's old default: one Vercel instance serves roughly
// one request at a time, the client's post-sign-in burst is capped at 3
// concurrent pulls, and a cold compute finishes fewer, faster transactions when
// fewer land on it at once. Raise `PG_POOL_MAX` only with the burst cap in mind.
const poolMax = Math.max(1, Number(process.env.PG_POOL_MAX) || 5);

// `error` events on an idle pooled client otherwise land in debug logging only,
// so a socket Neon closed after autosuspend never reaches the API log.
const reportPoolError = (source) => (error) => {
  console.error(`[pg-${source}-error] name=${String(error?.name ?? "Error")}: ${String(error?.message ?? error).slice(0, 200)}`);
};

const adapter = new PrismaPg(
  {
    connectionString: process.env.DATABASE_URL,
    max: poolMax,
    // Must stay below Prisma's `maxWait` (10s in lib/db.js) so the driver, not
    // the transaction API, is the one that gives up — and the attempt ends.
    connectionTimeoutMillis: 5_000,
    // Keep the warm sockets a burst is billed for: pg's 10s idle default would
    // drop them between bursts and the next one would pay TCP+TLS+auth again.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: "sua-api",
  },
  {
    onPoolError: reportPoolError("pool"),
    onConnectionError: reportPoolError("connection"),
  },
);

export const prisma = new PrismaClient({
  adapter,
  transactionOptions: {
    // Neon can take longer than Prisma's 2s default to provide a pooled
    // connection after idle periods or brief bursts of concurrent requests.
    // Keep transactions themselves short; only extend the acquisition wait.
    maxWait: 10_000,
  },
});
