/**
 * The decisions `/complete` makes about an upload, kept pure.
 *
 * The route can only run against Postgres, so the parts that are actually
 * rules — is this already active, does the publicId still match, does this row
 * want extraction — live here where they can be tested without a database.
 * Everything here is a read of a row the caller already holds under
 * `SELECT … FOR UPDATE`.
 */

import { storageProviderOf } from "./storage.js";

/**
 * Verify the object exists in the provider before activating it.
 * An already-active asset has been verified once; re-checking it would only
 * add a storage round trip to a retried request.
 */
export function needsVerification(asset) {
  return Boolean(asset) && asset.status !== "active";
}

/**
 * Mark this asset for page-wise extraction.
 *
 * Documents only: PDFs and OOXML files are parsed into SourceChunk rows. Photos
 * and audio are read by the generation job itself (native read / transcription)
 * because a picture is one "page" and a recording has no page model at all.
 *
 * Legacy rows keep their inline `extractedText` as the compat field, so a row
 * that already holds text is never re-parsed.
 */
export function needsExtraction(asset) {
  return (
    Boolean(asset) &&
    asset.kind === "document" &&
    !asset.extractedText &&
    (asset.extractState ?? "none") === "none"
  );
}

/**
 * Validate a completion against the row that is now locked.
 *
 * A second `/complete` for the same upload is a retry, not an error: the client
 * repeats it when the response was lost, and the asset is already active.
 * Anything else is a real conflict — the row's object changed while the PUT was
 * in flight — and must not be activated, because the bytes were never verified.
 *
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkCompletion(asset, { claimedPublicId, provider } = {}) {
  if (!asset) return { ok: false, status: 404, error: "Asset not found" };
  if (asset.status === "active") return { ok: true };
  if (!claimedPublicId || claimedPublicId !== asset.publicId) {
    return { ok: false, status: 400, error: "publicId does not match this upload" };
  }
  if (provider && storageProviderOf(asset) !== provider) {
    return {
      ok: false,
      status: 409,
      error: "Asset changed during upload; retry completion",
    };
  }
  return { ok: true };
}
