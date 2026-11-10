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
- The demo is your real UI built with a fake backend. Dummy accounts and rebuild steps: `_demo-source/`.

## Look and feel
- Background wall: `bg/*.webp` (still frames of the 30 cards), built in `assets/app.js`. Blur halo around the demo: `.halo` in `assets/style.css`.
- Quotes: `QUOTES` list in `assets/app.js` (new one every ~3 s).
- Sound: generated live in `assets/app.js` (`Amb`), no audio files.
- Font: Chakra Petch, self-hosted in `assets/fonts/`, same as the app.
- Intro lines: `Swipe(...)` call under `intro` in `assets/app.js`. Shown once per browser session.
- Support popup: `Support` in `assets/app.js`. To show the official PayPal logo, save it as `assets/paypal.svg` (it appears on the PayPal button automatically).
- FAQ: placeholder questions at the bottom of `index.html`.
