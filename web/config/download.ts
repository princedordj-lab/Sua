/**
 * Android build, served from Cloudflare R2 behind a Sua subdomain.
 *
 * Why it lives on R2 and not somewhere obvious:
 *   - a git blob over 100 MiB is rejected (GitHub), and the APK is ~134 MB;
 *   - Vercel's Hobby plan caps static uploads at 100 MB (Pro allows 1 GB);
 *   - R2 charges no egress, so a 134 MB download costs storage only — a few
 *     builds fit inside the 10 GB-month free tier.
 *
 * `NEXT_PUBLIC_ANDROID_APK_BASE_URL` holds the public base of the bucket's
 * custom domain plus the `android/` prefix, e.g. `https://dl.sua.app/android`.
 * Until it is set the download falls back to the GitHub release asset, which
 * the workflow keeps uploading as a mirror. Setup, upload and verification:
 * `docs/android-download-hosting.md`.
 *
 * Object key: `<base>/sua-<version>.apk`. The version is in the name because
 * objects are served `immutable` for a year: a new build is a new key, so a
 * CDN copy can never go stale under a student mid-download.
 *
 * To ship a new build:
 *   1. Update `version`, `sizeLabel` and `sha256` below.
 *   2. Commit and push, then tag:
 *        git tag v<version> && git push origin v<version>
 *      The workflow builds the APK with EAS, uploads it to R2 and attaches it
 *      to the GitHub release. If that run fails (missing `EXPO_TOKEN`, EAS
 *      queue, …), re-run it from the Actions tab — *Release APK* → *Run
 *      workflow* → tag `v<version>` — instead of moving the tag.
 *   3. Run `npx tsc --noEmit && npx eslint . && npm run build` in `web/`.
 */

/** Public base of the R2 bucket, e.g. `https://dl.sua.app/android`. */
const cdnBaseUrl = process.env.NEXT_PUBLIC_ANDROID_APK_BASE_URL?.replace(/\/+$/, "");

const version = "1.0.0";

/** Version in the key keeps each published build immutable in the CDN. */
const fileName = `sua-${version}.apk`;

/** Mirror on the GitHub release; also the fallback before R2 is connected. */
const releaseAssetUrl = `https://github.com/princedordj-lab/Sua/releases/download/v${version}/sua.apk`;

export const androidApp = {
  version,
  fileName,
  url: cdnBaseUrl ? `${cdnBaseUrl}/${fileName}` : releaseAssetUrl,
  /** False while the CDN is unset: the page still links GitHub as a stopgap. */
  servedFromCdn: Boolean(cdnBaseUrl),
  /** Release notes live on GitHub even when the APK is served from R2. */
  releasesUrl: "https://github.com/princedordj-lab/Sua/releases",
  sizeLabel: "134 MB",
  minAndroid: "8.0",
  sha256: "2177d76694758ab2cd0c22fb2e498a544cb01d211a06410459d82c5c7b586761",
} as const;
