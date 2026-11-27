/**
 * Where the app looks for updates.
 *
 * The repository is public, so GitHub serves release assets anonymously.
 * `releases/latest/download` is a flat view of the newest published release:
 * `latest.yml`, `latest.json`, the Setup exe and the portable exe all resolve
 * from that one base, which is exactly the layout both updaters expect.
 *
 * `RIOTSWITCHER_UPDATE_FEED` overrides the feed so a local HTTP server can
 * stand in while testing an update without publishing anything.
 *
 * `scripts/make-update-manifest.mjs`, `scripts/verify-feed.mjs` and
 * `scripts/check-updater.mjs` read the literal below to build absolute URLs, so
 * keep it a plain string on its own line.
 */
const DEFAULT_FEED_URL = "https://github.com/yassine808/RiotSwitcher/releases/latest/download";

/** Drops trailing slashes without a regex: the path is a URL, not a pattern. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

export const UPDATE_FEED_URL = withoutTrailingSlashes(process.env.RIOTSWITCHER_UPDATE_FEED ?? DEFAULT_FEED_URL);
