import { deleteAssetObject } from "./storage.js";
import { withUser } from "./db.js";

/**
 * Delete everything that belongs to a Clerk account.
 *
 * Storage objects live outside Postgres, so they are destroyed first (before
 * the User row cascades away the asset records that point at them). The User
 * row delete then cascades courses, notes, assets, jobs, chat messages, review
 * logs, quiz attempts, push tokens and usages.
 *
 * Idempotent on purpose: POST /me/delete runs it once, and the Clerk
 * user.deleted webhook runs it again afterwards — a no-op every time.
 */
export async function deleteAccountData(clerkId) {
  try {
    const assets = await withUser(clerkId, (tx) =>
      tx.asset.findMany({
        where: { user: { clerkId }, publicId: { not: "pending" } },
      }),
    );
    const results = await Promise.allSettled(assets.map(deleteAssetObject));
    for (const result of results) {
      if (result.status === "rejected") console.error("Storage cleanup failed for account", result.reason);
    }
  } catch (err) {
    console.error("Storage cleanup failed for account", err);
  }
  await withUser(clerkId, (tx) => tx.user.deleteMany({ where: { clerkId } }));
}
