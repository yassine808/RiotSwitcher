/**
 * Shared facts about the update feed.
 *
 * Two scripts disagreeing about what a feed object is called, or which version
 * it belongs to, is how a prune deletes the wrong thing. The naming rules and
 * the bucket listing live here so `prune-feed.mjs` and `verify-feed.mjs` can
 * never drift apart.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_KEYS = new Set(["latest.yml", "latest.json"]);
export const BUCKET = process.env.R2_BUCKET || "riotswitcher-updates";

/** The public base URL, read from the source of truth the app ships. */
export function feedBase(root) {
  const source = readFileSync(join(root, "src", "main", "updateFeed.ts"), "utf8");
  const match = source.match(/DEFAULT_FEED_URL\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("cannot read DEFAULT_FEED_URL from src/main/updateFeed.ts");
  return match[1].replace(/\/+$/, "");
}

/** Numeric, so 3.1.9 sorts before 3.1.10. */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The three object names one version owns in the flat bucket. */
export function objectNames(version) {
  return [
    `RiotSwitcher-Setup-${version}.exe`,
    `RiotSwitcher-Setup-${version}.exe.blockmap`,
    `RiotSwitcher-${version}-portable.exe`,
  ];
}

/** The version a feed object belongs to, or null for anything else. */
export function versionOfKey(key) {
  const setup = key.match(/^RiotSwitcher-Setup-(\d+\.\d+\.\d+)(?:\.exe|\.exe\.blockmap)$/);
  if (setup) return setup[1];
  const portable = key.match(/^RiotSwitcher-(\d+\.\d+\.\d+)-portable\.exe$/);
  return portable ? portable[1] : null;
}

/**
 * Credentials for the bucket's own API, or null when the run only has a
 * wrangler login (local) and therefore cannot list what is stored.
 */
export function bucketCredentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  return token && accountId ? { token, accountId, bucket: BUCKET } : null;
}

/**
 * Every key in the bucket, straight from the API that owns it.
 *
 * A version that was uploaded without a git tag — or whose tag was deleted —
 * is invisible to tag-based pruning, which then never removes it. Listing is
 * the only way to know what a bucket actually holds.
 */
export async function listBucket({ token, accountId, bucket }) {
  const keys = [];
  let cursor = null;

  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ per_page: "1000" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error(`R2 list returned HTTP ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    if (!body.success) {
      throw new Error(`R2 list failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    for (const object of body.result ?? []) {
      if (object.key) keys.push(object.key);
    }
    cursor = body.result_info?.cursor ?? null;
    if (!body.result_info?.is_truncated || !cursor) break;
  }

  return keys;
}
