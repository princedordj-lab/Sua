/**
 * Android build — downloaded straight from the Cloudflare R2 bucket.
 *
 * There is no app store and no CI publishing step today: the APK is uploaded
 * to the bucket by hand (see `docs/android-download-hosting.md`) and this file
 * is the only place that knows its address. Nothing here points at GitHub any
 * more — a student who taps download stays on a Sua host.
 *
 * Why R2 rather than something simpler:
 *   - a git blob over 100 MiB is rejected (GitHub), and the APK is ~134 MB;
 *   - Vercel's Hobby plan caps static uploads at 100 MB (Pro allows 1 GB);
 *   - R2 charges no egress, so a 134 MB download costs storage only — a few
 *     builds fit inside the 10 GB-month free tier.
 *
 * Set the base once, either here (`bucketBaseUrl`) or, better for previews and
 * for keeping the host out of git, with `NEXT_PUBLIC_ANDROID_APK_BASE_URL` in
 * the Vercel project. Both are read at build time because the page is static.
 *
 * Object key: `<base>/sua-<version>.apk`. The version is in the name because
 * objects are uploaded `immutable` (one year): a new build is a new key, so a
 * CDN copy can never go stale under a student mid-download.
 *
 * To publish a new build:
 *   1. Upload it: `npm run r2:upload -- "sua-downloads/android/sua-<version>.apk"
 *      --file <apk> --content-type application/vnd.android.package-archive
 *      --cache-control "public, max-age=31536000, immutable"` (from `backend/`).
 *   2. Update `version`, `sizeLabel` and `sha256` below.
 *   3. Run `npx tsc --noEmit && npx eslint . && npm run build` in `web/`.
 */

/**
 * Public base of the bucket: host plus the prefix objects live under. Edit the
 * placeholder, or set `NEXT_PUBLIC_ANDROID_APK_BASE_URL` to skip the edit.
 */
const bucketBaseUrl ="https://download.ssyncd.space/android/";

/** Public base actually used: env override first, then the constant above. */
const cdnBaseUrl = (
  process.env.NEXT_PUBLIC_ANDROID_APK_BASE_URL?.trim() || bucketBaseUrl
).replace(/\/+$/, "");



/** Version in the key keeps each published build immutable in the CDN. */
const fileName = `sua-v2[1].apk`;

export const androidApp = {
  fileName,
  /** Direct link to the object — no redirect, no third-party host. */
  url: `${cdnBaseUrl}/${fileName}`,
  sizeLabel: "134 MB",
  minAndroid: "8.0",
  sha256: "2177d76694758ab2cd0c22fb2e498a544cb01d211a06410459d82c5c7b586761",
} as const;
