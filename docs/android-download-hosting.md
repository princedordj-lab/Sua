# Android APK hosting

The `/download` page hands students a ~134 MB APK that is served **straight
from a Cloudflare R2 bucket** behind a Sua subdomain. There is no app store and
no CI publishing step yet: the APK is uploaded by hand and the page links the
object directly.

## Why R2

| Place | Limit | 134 MB APK |
| :--- | :--- | :--- |
| Git repository blob | GitHub warns >50 MiB, blocks >100 MiB | no |
| Vercel static upload (`web/public/`) | Hobby 100 MB, Pro 1 GB | no on Hobby |
| **Cloudflare R2 + custom domain** | 5 TiB per object, no egress charge | **yes** |

R2 keeps the download on a Sua host: Cloudflare caches `.apk` by default (it is
in the default cached-extension list), the cacheable-file cap is 512 MB on
Free/Pro, and egress is free on every plan.

## How the pieces fit

```
wrangler upload  ──►  s3://sua-downloads/android/sua-<version>.apk
                                   │
                                   ▼
                 https://dl.<domain>/android/sua-<version>.apk
                                   ▲
                                   └── web/config/download.ts
                                       (bucket base + version)
```

`web/config/download.ts` holds everything the page knows about the build:

- the bucket base — `NEXT_PUBLIC_ANDROID_APK_BASE_URL` if set, otherwise the
  `bucketBaseUrl` constant in that file (so local/preview deploys can point
  somewhere else without a code change);
- `version` — also the object key suffix (`sua-<version>.apk`);
- `sizeLabel` and `sha256` — what the page shows, and what it asks students to
  check after downloading.

Objects are uploaded with `Cache-Control: public, max-age=31536000, immutable`,
so the key carries the version: a new build is a new key and can never overwrite
a URL a student is already downloading.

## One-time setup

### 1. Bucket

`wrangler` is a devDependency of `backend/`, so run the Cloudflare commands from
that folder (any `npx wrangler …` invocation works too; the existing
`backend/wrangler.toml` describes the `sua-ai-worker` and is ignored by `r2`
commands). Wrangler 4 needs **Node ≥ 22**.

```bash
cd backend
npm install          # brings in wrangler
npm run r2:login     # opens a browser to authorise your Cloudflare account
npm run r2:whoami    # confirms the account and prints its Account ID
npm run r2:bucket:create   # creates `sua-downloads`
```

Without a browser (remote box): `export CLOUDFLARE_API_TOKEN=…` instead of
`r2:login`. That token needs account-level **Workers R2 Storage: Edit**.

Dashboard equivalent: **R2 → Create bucket** → `sua-downloads`.

### 2. Custom domain

```bash
cd backend
npm run r2:domain:add -- --domain dl.<your-domain> --zone-id <ZONE_ID>
```

or Dashboard → **R2** → `sua-downloads` → **Settings** → **Custom Domains** →
*Connect Domain* → `dl.<your-domain>`.

The zone must be on Cloudflare; SSL and CDN caching are automatic. Do **not**
use the `r2.dev` development URL for production — Cloudflare rate-limits it and
says it is not intended for production traffic. A `Cache Everything` rule is not
required: `.apk` is cached by default.

### 3. Point the page at the bucket

One of:

```bash
# Vercel → Project → Settings → Environment Variables (Production + Preview)
NEXT_PUBLIC_ANDROID_APK_BASE_URL=https://dl.<your-domain>/android
```

or edit `bucketBaseUrl` in `web/config/download.ts`. The page is statically
prerendered, so the value is baked in at build time — **set it, then redeploy**
(or rebuild) rather than expecting an env change to take effect on its own.

## Publishing a build

There is no CI step: upload the APK yourself and update the three values in
`web/config/download.ts`. Never upload through `dl.<domain>` — Cloudflare caps
uploads through a proxied hostname at 100 MB on Free/Pro, so a 134 MB `PUT`
would fail. Use wrangler (S3 API under the hood) or `aws s3 cp`:

```bash
cd backend
VERSION=1.0.0
npm run r2:upload -- "sua-downloads/android/sua-${VERSION}.apk" \
  --file ../sua.apk \
  --content-type application/vnd.android.package-archive \
  --content-disposition 'attachment; filename="sua.apk"' \
  --cache-control 'public, max-age=31536000, immutable'
```

```bash
# same thing with the AWS CLI, if wrangler is not installed
VERSION=1.0.0
ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

AWS_ACCESS_KEY_ID=<key> AWS_SECRET_ACCESS_KEY=<secret> \
aws s3 cp sua.apk "s3://sua-downloads/android/sua-${VERSION}.apk" \
  --endpoint-url "$ENDPOINT" \
  --content-type application/vnd.android.package-archive \
  --content-disposition 'attachment; filename="sua.apk"' \
  --cache-control 'public, max-age=31536000, immutable'
```

Then in `web/config/download.ts`: bump `version` (if it changed), and set
`sizeLabel` + `sha256` from the file you just uploaded:

```bash
URL=https://dl.<your-domain>/android/sua-1.0.0.apk
curl -sL "$URL" | sha256sum | cut -d' ' -f1                       # -> sha256
curl -sI "$URL" | awk 'tolower($1)=="content-length:"{printf "%.0f MB\n", $2/1000000}'
```

## Verify

```bash
# 1. Object is public, correctly typed and the right size
curl -sI https://dl.<your-domain>/android/sua-1.0.0.apk | \
  grep -Ei 'HTTP/|content-type|content-length|cache-control|content-disposition'

# 2. Edge is caching it (second request should report a HIT)
curl -sI https://dl.<your-domain>/android/sua-1.0.0.apk | grep -i cf-cache-status

# 3. Bytes match the hash the page tells students to check
curl -sL https://dl.<your-domain>/android/sua-1.0.0.apk | sha256sum

# 4. The built page links the bucket, not a third party
cd web && NEXT_PUBLIC_ANDROID_APK_BASE_URL=https://dl.<your-domain>/android npm run build
 grep -o 'https://dl[^"]*\.apk' .next/server/app/download.html
```

If step 1 returns 404, the object key does not match `sua-<version>.apk` —
re-upload under the canonical key rather than editing the page. If it returns
`application/octet-stream`, re-upload with the `--content-type` above; Android
file managers can refuse to launch the installer otherwise.

## Costs

- Storage: `$0.015/GB-month` with **10 GB-month free**; one build is ~0.13 GB, so
  dozens of versions stay inside the free tier.
- Egress: **free** on all plans (this is the reason for choosing R2).
- Class A (writes): 1 million/month free — a manual upload is one per build.
- Class B (reads): 10 million/month free; a CDN `HIT` does not hit the bucket.

## Changing the host or rolling back

- **Different host/bucket:** set `NEXT_PUBLIC_ANDROID_APK_BASE_URL` (or edit
  `bucketBaseUrl`) and rebuild. Nothing else references the URL.
- **Broken build published under an existing version:** never overwrite
  `sua-<version>.apk` — the key is served `immutable` and students may be
  mid-download. Bump `version`, upload a new key, update `sha256`/`sizeLabel`.
- **Play Store later:** keep the APK for sideloads and swap the CTA for the
  listing URL when there is one.

## Deferred: CI publishing

Uploading by hand is deliberate for now. When tag-triggered publishing is worth
wiring, the prepared workflow lives at
`docs/github-actions/release-apk.yml.pending`: it builds on a `v*` tag (and can
be re-run manually with a tag input), uploads the APK to R2, and attaches it to
the GitHub release. It needs `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and `EXPO_TOKEN` as repository secrets, and
it has to be pasted in from a token that may write workflow files. Until then,
none of those secrets are required.

## Secret hygiene

Only the bucket base URL is public. R2 keys stay out of the repo, out of
`backend/.env` (the API never touches R2 — uploads use Neon Object Storage) and
out of every `NEXT_PUBLIC_*` variable. `wrangler login` keeps its credential in
`~/.config/.wrangler`, not in the project.
