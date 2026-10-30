/**
 * Android build, published as a GitHub Release asset.
 *
 * The APK is ~134 MB, so it cannot be committed to the repo (GitHub rejects
 * blobs over 100 MiB) or served from `public/apk/` (Vercel's Hobby static-
 * upload cap is 100 MB). Publishing it as a release asset keeps the repo
 * clean and gives the landing page a stable CDN URL.
 *
 * The APK is built automatically via EAS in the GitHub Actions workflow at
 * `.github/workflows/release-apk.yml` and attached to the release.
 *
 * To ship a new build:
 *   1. Update `version`, `url`, `sizeLabel` and `sha256` below.
 *   2. Commit and push, then create a matching tag:
 *        git tag v<version> && git push origin v<version>
 *      The workflow will trigger an EAS build, download the APK, create the
 *      GitHub release, and attach the APK automatically.
 *   3. Run `npx tsc --noEmit && npx eslint . && npm run build` in `web/`.
 */
export const androidApp = {
  version: "1.0.0",
  url: "https://github.com/princedordj-lab/Sua/releases/download/v1.0.0/sua.apk",
  sizeLabel: "134 MB",
  minAndroid: "8.0",
  sha256: "2177d76694758ab2cd0c22fb2e498a544cb01d211a06410459d82c5c7b586761",
} as const;
