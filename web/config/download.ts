/**
 * Android build, published as a GitHub Release asset.
 *
 * The APK is ~134 MB, so it cannot be served from `public/apk/` (Vercel's
 * Hobby static-upload cap is 100 MB). Publishing it as a release asset keeps
 * the repo lean and gives the landing page a stable CDN URL.
 *
 * The APK is tracked in `web/public/apk/sua.apk` and automatically uploaded
 * via the GitHub Actions workflow in `.github/workflows/release-apk.yml`.
 *
 * To ship a new build:
 *   1. Replace `web/public/apk/sua.apk` with the new build.
 *   2. Update `version`, `url`, `sizeLabel` and `sha256` below.
 *   3. Commit and push, then create a matching tag:
 *        git tag v<version> && git push origin v<version>
 *      The workflow will create the release and attach the APK automatically.
 *   4. Run `npx tsc --noEmit && npx eslint . && npm run build` in `web/`.
 */
export const androidApp = {
  version: "1.0.0",
  url: "https://github.com/princedordj-lab/Sua/releases/download/v1.0.0/sua.apk",
  sizeLabel: "134 MB",
  minAndroid: "8.0",
  sha256: "2177d76694758ab2cd0c22fb2e498a544cb01d211a06410459d82c5c7b586761",
} as const;
