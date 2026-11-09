#!/usr/bin/env node
/**
 * Deletes every feed object that belongs to a version other than the one in
 * package.json, so the bucket only ever carries the current release.
 *
 * The bucket is flat and each version owns three names:
 *
 *   RiotSwitcher-Setup-<version>.exe
 *   RiotSwitcher-Setup-<version>.exe.blockmap
 *   RiotSwitcher-<version>-portable.exe
 *
 * Versions are collected from the git tags (every CI release is a tag), from
 * the files in release/ (a local publish), and from --version. Objects named
 * for the current version and both manifests are never touched.
 *
 *   node scripts/prune-feed.mjs                    # delete the rest
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
const KEEP = new Set(["latest.yml", "latest.json"]);

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

function argvVersion() {
  const versions = [];
  process.argv.forEach((arg, index) => {
    if (arg === "--version" && process.argv[index + 1]) versions.push(process.argv[index + 1]);
  });
  return versions;
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
const base = feedBase();

const versions = new Set([...taggedVersions(), ...releasedVersions(), ...argvVersion()]);
versions.delete(current);

// Newest last, so the log reads like the release history.
const ordered = [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

const candidates = ordered.flatMap(names).filter((key) => !KEEP.has(key) && !key.includes(`-${current}`));

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
console.log(
  `[feed-prune] keep ${current}: ${scope} ${dryRun ? candidates.length : deleted} object(s), ` +
    `${absent} already absent, ${failed} failed`,
);

if (failed > 0) process.exit(1);
