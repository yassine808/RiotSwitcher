# RiotSwitcher website

Static site + two tiny Cloudflare Pages Functions. No build step.

## Deploy (Cloudflare Pages)
1. Cloudflare dashboard > Workers & Pages > Create > Pages > Upload assets.
2. Upload this folder (keep `functions/` in it) or connect a git repo with build output = `/`.
3. Done. Downloads always point to the newest build in the `riotswitcher-updates` bucket.

## How downloads work
- `/download/setup` and `/download/portable` read `latest.yml` from the bucket and redirect to the newest file.
- `/api/latest` returns `{version, setup, portable}`; the page uses it to show the version.
- If Functions aren't available (other host), the page reads `latest.yml` from the bucket directly (needs CORS on the bucket).

## Edit
- Bucket URL and PayPal: top of `assets/app.js` and `functions/_latest.js`.
- Changelog: `changelog.html`.
- Demo accounts: top of `assets/demo.js`.
