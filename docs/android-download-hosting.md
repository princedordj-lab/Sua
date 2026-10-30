# Android APK hosting

The `/download` page hands students a ~134 MB APK. It is published to a
**Cloudflare R2 bucket behind a Sua subdomain**, and mirrored on the GitHub
release by CI.

## Why R2

| Place | Limit | 134 MB APK |
| :--- | :--- | :--- |
| Git repository blob | GitHub warns >50 MiB, blocks >100 MiB | no |
| Vercel static upload (`web/public/`) | Hobby 100 MB, Pro 1 GB | no on Hobby |
| GitHub release asset | no total-size or bandwidth limit | yes, but on github.com |
| **Cloudflare R2 + custom domain** | 5 TiB per object, no egress charge | **yes** |

R2 also keeps the download on a Sua host: Cloudflare caches `.apk` by default
(it is in the default cached-extension list), the cacheable-file cap is 512 MB
on Free/Pro, and egress is free on every plan.

## How the pieces fit

```
EAS build ──► workflow ──► s3://<bucket>/android/sua-<version>.apk
                    └────► GitHub release asset (mirror / release notes)

dl.<domain>/android/sua-<version>.apk  (R2 custom domain)
        ▲
        └── web: NEXT_PUBLIC_ANDROID_APK_BASE_URL=https://dl.<domain>/android
```

- `web/config/download.ts` builds `url` from `NEXT_PUBLIC_ANDROID_APK_BASE_URL`
  plus `sua-<version>.apk`. **If the variable is unset the page falls back to
  the GitHub release asset** and shows the "All releases" link, so the site
  keeps working before (or without) R2.
- The key carries the version and is uploaded with
  `Cache-Control: public, max-age=31536000, immutable`, so a new build never
  overwrites a URL a student is already downloading.
- CI only uploads to R2 when the four `R2_*` secrets exist; otherwise it logs a
  notice and publishes the GitHub asset alone.

## One-time setup

### 1. Bucket

Dashboard → **R2** → *Create bucket* → name `sua-downloads` (any name, but put
it in `R2_BUCKET`). Or:

```bash
npx wrangler r2 bucket create sua-downloads
```

### 2. Custom domain

Dashboard → **R2** → `sua-downloads` → **Settings** → **Custom Domains** →
*Connect Domain* → `dl.<your-domain>`.

The domain's zone must be on Cloudflare; SSL and CDN caching are automatic.
Do **not** use the `r2.dev` development URL for production — Cloudflare
rate-limits it and says it is not intended for production traffic.
A `Cache Everything` rule is not required: `.apk` is cached by default.

### 3. API token (S3 credentials)

Dashboard → **R2** → **Overview** → *Account Details* → **Manage** →
*Create Account API token* → permission **Object Read and Write** → scope it to
`sua-downloads`. Copy the **Access Key ID** and **Secret Access Key** (the
secret is shown once) and note the account ID: the S3 endpoint is
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

### 4. GitHub repository secrets

| Secret | Value |
| :--- | :--- |
| `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | Access Key ID from step 3 |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key from step 3 |
| `R2_BUCKET` | `sua-downloads` |

```bash
gh secret set R2_ENDPOINT --repo princedordj-lab/Sua
gh secret set R2_ACCESS_KEY_ID --repo princedordj-lab/Sua
gh secret set R2_SECRET_ACCESS_KEY --repo princedordj-lab/Sua
gh secret set R2_BUCKET --repo princedordj-lab/Sua
```

### 5. Vercel environment variable

`NEXT_PUBLIC_ANDROID_APK_BASE_URL=https://dl.<your-domain>/android`

Set it for all environments and **redeploy**: the `/download` page is statically
prerendered, so the URL is baked in at build time.

### 6. Apply the workflow

Copy `docs/github-actions/release-apk.yml.pending` over
`.github/workflows/release-apk.yml` from a token that can write workflows (the
web editor works), then delete the pending copy. It adds the R2 upload step on
top of the tag-triggered build and the manual re-run trigger.

## Publishing a build by hand

Needed when the APK was built somewhere else, or when the secrets were added
after a failed run. Upload against the **S3 endpoint**, not the public domain:
Cloudflare caps uploads through a proxied hostname at 100 MB on Free/Pro, so a
134 MB `PUT` to `dl.<domain>` would fail.

```bash
VERSION=1.0.0
ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

AWS_ACCESS_KEY_ID=<key> AWS_SECRET_ACCESS_KEY=<secret> \
aws s3 cp sua.apk "s3://sua-downloads/android/sua-${VERSION}.apk" \
  --endpoint-url "$ENDPOINT" \
  --content-type application/vnd.android.package-archive \
  --content-disposition 'attachment; filename="sua.apk"' \
  --cache-control 'public, max-age=31536000, immutable'
```

Wrangler equivalent:

```bash
npx wrangler r2 object put "sua-downloads/android/sua-${VERSION}.apk" \
  --file sua.apk --content-type application/vnd.android.package-archive
```

`--content-disposition` keeps the saved file name `sua.apk` even though the
object key is versioned.

## Verify

```bash
# 1. Object is public, correctly typed and the right size
curl -sI https://dl.<your-domain>/android/sua-1.0.0.apk | \
  grep -Ei 'HTTP/|content-type|content-length|cache-control'

# 2. Edge is caching it (second request should report a HIT)
curl -sI https://dl.<your-domain>/android/sua-1.0.0.apk | grep -i cf-cache-status

# 3. Bytes match the hash the page tells students to check
curl -sL https://dl.<your-domain>/android/sua-1.0.0.apk | sha256sum
# compare with `sha256` in web/config/download.ts

# 4. The deployed page actually points at the CDN
curl -s https://<web-host>/download | grep -o 'https://dl[^"]*\.apk'
```

If step 4 prints nothing, `NEXT_PUBLIC_ANDROID_APK_BASE_URL` was not set for the
build that is deployed — set it and redeploy.

## Costs

- Storage: `$0.015/GB-month` with **10 GB-month free**; one build is ~0.13 GB, so
  dozens of versions stay inside the free tier.
- Egress: **free** on all plans (this is the reason for choosing R2).
- Class A (writes): 1 million/month free — uploads are one per build.
- Class B (reads): 10 million/month free.

## Rolling back

- **Back to GitHub:** unset `NEXT_PUBLIC_ANDROID_APK_BASE_URL` and redeploy. The
  page falls back to the release asset and shows "All releases" again.
- **New build, same version:** never overwrite `sua-<version>.apk` — students may
  be mid-download and the object is immutable in the CDN. Bump `version` in
  `web/config/download.ts` and publish a new key.
- **Play Store later:** the APK can keep serving sideloads; swap the CTA for the
  listing URL when there is one.

## Secret hygiene

Only the public base URL (`NEXT_PUBLIC_ANDROID_APK_BASE_URL`) is public. The
`R2_*` values stay in GitHub secrets and never in `.env` files, the repo, or any
`NEXT_PUBLIC_*` variable. The token is scoped to one bucket and can be revoked
from the same dashboard screen that created it.
