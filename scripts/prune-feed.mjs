#!/usr/bin/env node
/**
 * Deletes every feed object that belongs to a version outside the retention
 * window, so the bucket carries the newest releases and no more.
 *
 * The bucket is flat and each version owns three names:
 *
 *   RiotSwitcher-Setup-<version>.exe
 *   RiotSwitcher-Setup-<version>.exe.blockmap
 *   RiotSwitcher-<version>-portable.exe
 *
 * With CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set, the bucket is listed
 * and every version-shaped object outside the window is deleted. That is the
 * only accurate source: a build uploaded without a tag, or whose tag was
 * deleted, is invisible to tags and would otherwise stay forever. Without the
 * token (a local wrangler login), versions are collected from the git tags, the
 * files in release/ and --version, and their usual names are probed instead.
 *
 * The three newest versions are kept by default, so the bucket always carries
 * the last three builds: room to roll back without a rebuild, and the same
 * window a client may still be running. `--keep N` widens or narrows it. Both
 * manifests are never touched.
 *
 *   node scripts/prune-feed.mjs                    # keep the three newest versions
 *   node scripts/prune-feed.mjs --keep 5           # keep a longer rollback window
 *   node scripts/prune-feed.mjs --dry-run          # list what would go
 *   node scripts/prune-feed.mjs --version 3.1.11   # also prune an untagged build
 *
 * Run after the new binaries and manifests are in the bucket: deleting a
 * version first would break a client still reading its manifest.
 */

import { execFileSync, execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANIFEST_KEYS,
  bucketCredentials,
  compareVersions,
  feedBase,
  listBucket,
  objectNames,
  versionOfKey,
} from "./lib/feed.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const RELEASE_DIR = join(ROOT, "release");

const BUCKET = process.env.R2_BUCKET || "riotswitcher-updates";
// Three releases in the bucket by default. With the previous builds still
// there, a bad release is undone by putting the older manifests back instead
// of rebuilding it, and the newest three are always available to clients.
// release.yml sets R2_KEEP_VERSIONS=3 so prune and verify-feed agree.
const DEFAULT_KEEP = 3;

function fail(message) {
  console.error(`[feed-prune] ${message}`);
  process.exit(1);
}

function argvValues(flag) {
  const values = [];
  process.argv.forEach((arg, index) => {
    if (arg === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  });
  return values;
}

function argvVersion() {
  return argvValues("--version");
}

function retention() {
  const raw = argvValues("--keep").at(-1) ?? process.env.R2_KEEP_VERSIONS ?? String(DEFAULT_KEEP);
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) fail(`invalid keep count: ${raw}`);
  return count;
}

function taggedVersions() {
  try {
    return execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^v\d+\.\d+\.\d+$/.test(line))
      .map((line) => line.slice(1));
  } catch {
    console.warn("[feed-prune] git tags unavailable; using release/ and --version only");
    return [];
  }
}

function releasedVersions() {
  try {
    return readdirSync(RELEASE_DIR).flatMap((name) => {
      const match = name.match(/\d+\.\d+\.\d+/);
      return match ? [match[0]] : [];
    });
  } catch {
    return [];
  }
}

async function exists(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.status === 200;
  } catch {
    return false;
  }
}

function deleteObject(key) {
  try {
    execSync(`wrangler r2 object delete "${BUCKET}/${key}" --remote`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    return true;
  } catch (error) {
    console.error(`[feed-prune] ${key}: ${error.stderr?.toString().trim() || error.message}`);
    return false;
  }
}

const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const dryRun = process.argv.includes("--dry-run");
const keepCount = retention();
const base = feedBase(ROOT);

// The bucket's own list is the source of truth when the API credentials are
// there (every CI run). Without them a local wrangler login can delete but not
// list, so fall back to probing the names the tags and release/ imply.
const credentials = bucketCredentials();
let objects = null;
if (credentials) {
  try {
    objects = await listBucket(credentials);
  } catch (error) {
    fail(`cannot list ${BUCKET}: ${error.message}`);
  }
} else {
  console.warn(
    "[feed-prune] no CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID: probing " +
      "the names known from tags and release/ instead of listing the bucket",
  );
}

const bucketVersions = (objects ?? []).map(versionOfKey).filter(Boolean);
// With a live listing, the window is counted over the versions that actually
// exist in the bucket. A tag whose build never uploaded still names a version;
// counting it would evict a real build and leave fewer than `keepCount` there.
const known = objects
  ? new Set([...bucketVersions, ...argvVersion(), current])
  : new Set([...taggedVersions(), ...releasedVersions(), ...argvVersion(), current]);

// Newest last, so the log reads like the release history.
const ordered = [...known].sort(compareVersions);

// The current version survives even when --keep 1 meets a stale tag list.
const kept = new Set(ordered.slice(-keepCount));
kept.add(current);

const candidates = objects
  ? objects.filter((key) => {
      if (MANIFEST_KEYS.has(key)) return false;
      const version = versionOfKey(key);
      return version !== null && !kept.has(version);
    })
  : ordered
      .filter((version) => !kept.has(version))
      .flatMap(objectNames)
      .filter((key) => !MANIFEST_KEYS.has(key));

let deleted = 0;
let absent = 0;
let failed = 0;

for (const key of candidates) {
  if (!objects && !(await exists(`${base}/${key}`))) {
    absent += 1;
    continue;
  }
  if (dryRun) {
    console.log(`[feed-prune] would delete ${key}`);
    deleted += 1;
    continue;
  }
  if (deleteObject(key)) {
    console.log(`[feed-prune] deleted ${key}`);
    deleted += 1;
  } else {
    failed += 1;
  }
}

const scope = dryRun ? "would delete" : "deleted";
const keeping = [...kept].sort(compareVersions).join(", ");
console.log(
  `[feed-prune] keeping ${kept.size} version(s) (${keeping}): ${scope} ${deleted} object(s), ` +
    `${absent} already absent, ${failed} failed`,
);

if (failed > 0) process.exit(1);
