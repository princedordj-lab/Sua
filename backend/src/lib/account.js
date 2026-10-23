import { cloudinary, cloudinaryConfigured } from "../config/cloudinary.js";
import { withUser } from "./db.js";

/**
 * Delete everything that belongs to a Clerk account.
 *
 * Cloudinary files live outside Postgres, so they are destroyed first (before
 * the User row cascades away the asset records that point at them). The User
 * row delete then cascades courses, notes, assets, jobs, chat messages, review
 * logs, quiz attempts, push tokens and usages.
 *
 * Idempotent on purpose: POST /me/delete runs it once, and the Clerk
 * user.deleted webhook runs it again afterwards — a no-op every time.
 */
export async function deleteAccountData(clerkId) {
  if (cloudinaryConfigured()) {
    try {
      const assets = await withUser(clerkId, (tx) =>
        tx.asset.findMany({
          where: { user: { clerkId }, publicId: { not: "pending" } },
        }),
      );
      await Promise.allSettled(
        assets.map((asset) =>
          cloudinary.uploader.destroy(asset.publicId, {
            resource_type: asset.resourceType,
          }),
        ),
      );
    } catch (err) {
      console.error("Cloudinary cleanup failed for account", err);
    }
  }
  await withUser(clerkId, (tx) => tx.user.deleteMany({ where: { clerkId } }));
}
