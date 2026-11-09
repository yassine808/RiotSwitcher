# RiotSwitcher website

Static site + two tiny Cloudflare Pages Functions. No build step.

## Deploy (Cloudflare Pages)
- Push to `main` with any change under `Website/`: `.github/workflows/site.yml` deploys this folder to https://riotswitcher.pages.dev. Nothing else to run.
- Manual fallback, from inside this folder: `npx wrangler pages deploy . --project-name riotswitcher --branch main`.
- Downloads always point to the newest build in the `riotswitcher-updates` bucket.

## How downloads work
- `/download/setup` and `/download/portable` read `latest.yml` from the bucket and redirect to the newest file.
- `/api/latest` returns `{version, setup, portable}`; the page uses it to show the version.
- If Functions aren't available (other host), the page reads `latest.yml` from the bucket directly (needs CORS on the bucket).

## Edit
- Bucket URL and PayPal (Support me button is in the footer): top of `assets/app.js` and `functions/_latest.js`.
- Changelog: `changelog.html`.
- The demo is your real UI built with a fake backend. Dummy accounts and rebuild steps: `_demo-source/`.
- Rotating quotes: `QUOTES` list at the top of `assets/quotes.js` (hold time and word stagger are there too).
- Background music is synthesized in `assets/app.js` (chords and tempo in `CHORDS` / `BAR`).
