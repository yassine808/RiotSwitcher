/**
 * Where the app looks for updates.
 *
 * Release assets on GitHub are only served to authenticated requests once the
 * repository is private, and an installed copy cannot hold a token. Builds are
 * therefore published to a public Cloudflare R2 bucket, which serves the same
 * files anonymously.
 *
 * `RIOTSWITCHER_UPDATE_FEED` overrides the bucket so a local HTTP server can
 * stand in while testing an update without publishing anything.
 *
 * `scripts/make-update-manifest.mjs` reads the literal below to build absolute
 * URLs, so keep it a plain string on its own line.
 */
const DEFAULT_FEED_URL = "https://pub-6d3d6d22222242dab87967c474f39ada.r2.dev";

export const UPDATE_FEED_URL = (process.env.RIOTSWITCHER_UPDATE_FEED ?? DEFAULT_FEED_URL).replace(/\/+$/, "");
