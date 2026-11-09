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
 * Versions are collected from the git tags (every CI release is a tag), from
 * the files in release/ (a local publish), and from --version. The newest
 * three are kept by default, so a bad release can be undone by repointing the
 * manifests at the version before it. Objects named for the current version
 * and both manifests are never touched.
 *
 *   node scripts/prune-feed.mjs                    # keep the newest 3
 *   node scripts/prune-feed.mjs --keep 1           # keep the current one only
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const RELEASE_DIR = join(ROOT, "release");

const BUCKET = process.env.R2_BUCKET || "riotswitcher-updates";
const KEEP_NAMES = new Set(["latest.yml", "latest.json"]);
// The bucket holds the newest few versions, not just the current one: with the
// previous binaries still there, a bad release is undone by putting the older
// manifests back instead of rebuilding and republishing it.
const DEFAULT_KEEP = 3;

function fail(message) {
  console.error(`[feed-prune] ${message}`);
  process.exit(1);
}

function feedBase() {
  const source = readFileSync(join(ROOT, "src", "main", "updateFeed.ts"), "utf8");
  const match = source.match(/DEFAULT_FEED_URL\s*=\s*"([^"]+)"/);
  if (!match) fail("cannot read DEFAULT_FEED_URL from src/main/updateFeed.ts");
  return match[1].replace(/\/+$/, "");
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

// Numeric, so 3.1.9 sorts before 3.1.10 (localeCompare would not).
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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

function names(version) {
  return [
    `RiotSwitcher-Setup-${version}.exe`,
    `RiotSwitcher-Setup-${version}.exe.blockmap`,
    `RiotSwitcher-${version}-portable.exe`,
  ];
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
const base = feedBase();

const known = new Set([...taggedVersions(), ...releasedVersions(), ...argvVersion(), current]);

// Newest last, so the log reads like the release history.
const ordered = [...known].sort(compareVersions);

// The current version survives even when --keep 1 meets a stale tag list.
const kept = new Set(ordered.slice(-keepCount));
kept.add(current);

const stale = ordered.filter((version) => !kept.has(version));
const currentNames = new Set(names(current));

const candidates = stale.flatMap(names).filter((key) => !KEEP_NAMES.has(key) && !currentNames.has(key));

let deleted = 0;
let absent = 0;
let failed = 0;

for (const key of candidates) {
  if (!(await exists(`${base}/${key}`))) {
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
  `[feed-prune] keeping ${keeping}: ${scope} ${deleted} object(s), ` + `${absent} already absent, ${failed} failed`,
);

if (failed > 0) process.exit(1);
