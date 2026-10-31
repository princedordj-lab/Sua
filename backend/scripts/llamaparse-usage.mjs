// LlamaParse credit and failure summary.
//
//   cd backend && npm run llamaparse:usage
//   cd backend && npm run llamaparse:usage -- --refresh-null
//
// Reads provider metadata from the assets table. Credits can lag billing, so
// --refresh-null re-reads `expand=usage` for completed jobs still missing it.

import "../src/config/env.js";
import { prisma } from "../src/config/prisma.js";
import { getParseJob } from "../src/lib/llamaparse.js";

const refresh = process.argv.includes("--refresh-null");
const monthKey = (date) =>
  date
    ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
    : "unknown";

const assets = await prisma.asset.findMany({
  where: { providerJobId: { not: null } },
  select: {
    id: true,
    format: true,
    extractProvider: true,
    providerJobId: true,
    providerStatus: true,
    providerCredits: true,
    providerPagesFailed: true,
    providerError: true,
    providerSubmittedAt: true,
    providerTier: true,
    createdAt: true,
  },
  orderBy: { createdAt: "desc" },
});

const monthly = new Map();
const totals = {
  jobs: assets.length,
  credits: 0,
  unknown: 0,
  failed: 0,
  fallbacks: 0,
  failedPages: 0,
};

for (const asset of assets) {
  const key = monthKey(asset.providerSubmittedAt ?? asset.createdAt);
  const row = monthly.get(key) ?? {
    jobs: 0,
    credits: 0,
    unknown: 0,
    failed: 0,
    fallbacks: 0,
    failedPages: 0,
  };
  row.jobs += 1;
  if (asset.providerCredits == null) {
    totals.unknown += 1;
    row.unknown += 1;
  } else {
    totals.credits += asset.providerCredits;
    row.credits += asset.providerCredits;
  }
  if (asset.providerStatus === "FAILED") {
    totals.failed += 1;
    row.failed += 1;
  }
  if (
    asset.extractProvider === "fallback" ||
    String(asset.providerError ?? "").startsWith("LLAMA_GAVE_UP")
  ) {
    totals.fallbacks += 1;
    row.fallbacks += 1;
  }
  totals.failedPages += asset.providerPagesFailed ?? 0;
  row.failedPages += asset.providerPagesFailed ?? 0;
  monthly.set(key, row);
}

console.log(
  `LlamaParse jobs=${totals.jobs} credits=${totals.credits} unknown=${totals.unknown} failed=${totals.failed} fallbacks=${totals.fallbacks} failedPages=${totals.failedPages}`,
);
for (const [month, row] of [...monthly.entries()].sort()) {
  console.log(
    `${month}: jobs=${row.jobs} credits=${row.credits} unknown=${row.unknown} failed=${row.failed} fallbacks=${row.fallbacks} failedPages=${row.failedPages}`,
  );
}

if (refresh) {
  const stale = assets.filter(
    (asset) =>
      asset.providerCredits == null &&
      asset.providerStatus === "COMPLETED" &&
      asset.providerJobId,
  );
  console.log(`Refreshing ${stale.length} completed job(s) with missing credits...`);
  for (const asset of stale) {
    try {
      const job = await getParseJob({ jobId: asset.providerJobId });
      if (job.credits != null) {
        await prisma.asset.update({
          where: { id: asset.id },
          data: { providerCredits: job.credits },
        });
        console.log(`${asset.id}: credits=${job.credits}`);
      } else {
        console.log(`${asset.id}: credits still pending`);
      }
    } catch (error) {
      console.warn(`${asset.id}: ${error?.code ?? ""} ${error?.message ?? error}`.trim());
    }
  }
}

await prisma.$disconnect();
