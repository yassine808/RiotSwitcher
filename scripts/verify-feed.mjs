#!/usr/bin/env node
/**
 * Checks the live feed after a publish: everything a client will actually
 * read, from the public URL, not from the files on disk.
 *
 * `verify-release.mjs` runs before anything is uploaded and proves the release
 * is consistent. This runs after the upload and proves the upload worked: the
 * manifests that came out the other end name this version, the binaries behind
 * them answer 200 with the declared size, the cache headers are the ones a
 * client needs, and no version outside the retention window is still there.
 * With `--download` it also fetches the portable once and hashes it, which is
 * the only check that covers the bytes a client actually installs.
 *
 * A stale edge copy is retried for a while before it counts as a failure: a
 * manifest uploaded seconds ago can still be behind a cached copy.
 *
 *   node scripts/verify-feed.mjs                  # package.json version, keep 3
 *   node scripts/verify-feed.mjs --version 3.1.12 # check the version on the feed
 *   node scripts/verify-feed.mjs --keep 5         # expect five versions up there
 *   node scripts/verify-feed.mjs --timeout 30     # give up sooner on propagation
 *   node scripts/verify-feed.mjs --download       # also hash the portable itself
 *
 * The bucket is listed through the R2 API when CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID are set (every CI run). Without them, versions known
 * from tags and release/ are probed instead.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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

const problems = [];
const passed = [];

function check(condition, failure, success) {
  if (condition) {
    if (success) passed.push(success);
    return true;
  }
  problems.push(failure);
  return false;
}

function argvValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const current = argvValue("--version", JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
const keepCount = Number(argvValue("--keep", process.env.R2_KEEP_VERSIONS ?? "3"));
const timeoutMs = Number(argvValue("--timeout", "60")) * 1000;
if (!Number.isInteger(keepCount) || keepCount < 1) {
  console.error(`[verify-feed] invalid keep count: ${keepCount}`);
  process.exit(1);
}

const base = feedBase(ROOT);

/**
 * Fetches a manifest until it reports the expected version.
 *
 * The previous release's copy can still be cached when this runs. Retrying is
 * not leniency: it separates "the edge has not caught up" from "the upload
 * never happened", and the second one has to fail the run.
 */
async function readManifest(name, isCurrent) {
  const deadline = Date.now() + timeoutMs;
  let lastSaid = "no response";

  for (let attempt = 1; ; attempt += 1) {
    // The first request is exactly what a client sends. A cache-busting query
    // is only added on retries, so a stale edge copy is still detectable.
    const url = attempt === 1 ? `${base}/${name}` : `${base}/${name}?t=${Date.now()}`;
    let response;
    try {
      response = await fetch(url, { headers: { "cache-control": "no-cache" } });
    } catch (error) {
      lastSaid = error.message;
      if (Date.now() >= deadline) throw new Error(`${name}: ${lastSaid}`);
      await sleep(3000);
      continue;
    }

    if (!response.ok) {
      lastSaid = `HTTP ${response.status}`;
      if (Date.now() >= deadline) throw new Error(`${name}: ${lastSaid}`);
      await sleep(3000);
      continue;
    }

    const text = await response.text();
    if (isCurrent(text)) {
      return {
        text,
        cacheControl: response.headers.get("cache-control") ?? "(none)",
        attempts: attempt,
      };
    }

    lastSaid = "still not this version";
    if (Date.now() >= deadline) {
      throw new Error(`${name}: ${lastSaid} after ${attempt} attempt(s)`);
    }
    await sleep(3000);
  }
}

/** The `files:` entries electron-builder writes into latest.yml. */
function parseLatestYml(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const url = line.match(/^\s*-\s*url:\s*(.+?)\s*$/);
    const size = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (url) entries.push({ url: url[1], size: null });
    else if (size && entries.length > 0) entries.at(-1).size = Number(size[1]);
  }
  return entries;
}

function versionOfYml(text) {
  return text.match(/^version:\s*(\S+)\s*$/m)?.[1] ?? null;
}

async function head(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return { status: response.status, headers: response.headers };
  } catch (error) {
    return { status: 0, headers: new Headers(), error: error.message };
  }
}

function isNoCache(value) {
  return /(^|,)\s*no-cache\s*(,|$)/i.test(value) || /no-store/i.test(value);
}

function isImmutable(value) {
  return /immutable/i.test(value);
}

// 1. latest.json: the manifest the portable build reads.
let portable = null;
try {
  const manifest = await readManifest("latest.json", (text) => {
    try {
      return JSON.parse(text).version === current;
    } catch {
      return false;
    }
  });
  check(
    isNoCache(manifest.cacheControl),
    `latest.json is served with cache-control "${manifest.cacheControl}", so a client can hold a stale copy`,
    `latest.json is revalidated (${manifest.cacheControl})`,
  );
  if (manifest.attempts > 1) {
    passed.push(`latest.json took ${manifest.attempts} attempts to show ${current}`);
  }

  const body = JSON.parse(manifest.text);
  portable = body.files?.portable ?? null;
  if (check(Boolean(portable?.url), "latest.json has no files.portable.url")) {
    check(portable.url.startsWith(base), `latest.json points at ${portable.url}, outside the feed ${base}`);
    check(
      portable.url.endsWith(`RiotSwitcher-${current}-portable.exe`),
      `latest.json points at ${portable.url}, not the ${current} portable build`,
    );
  }
} catch (error) {
  problems.push(`latest.json: ${error.message}`);
}

// 2. latest.yml: the manifest the installed (NSIS) build reads.
let ymlText = null;
let yml = null;
try {
  const manifest = await readManifest("latest.yml", (text) => versionOfYml(text) === current);
  check(
    isNoCache(manifest.cacheControl),
    `latest.yml is served with cache-control "${manifest.cacheControl}", so a client can hold a stale copy`,
    `latest.yml is revalidated (${manifest.cacheControl})`,
  );

  ymlText = manifest.text;
  const entries = parseLatestYml(ymlText);
  check(entries.length > 0, "latest.yml lists no files");
  yml = entries;
} catch (error) {
  problems.push(`latest.yml: ${error.message}`);
}

// 3. The binaries both manifests name, byte for byte.
const binaries = [];
if (portable?.url) {
  binaries.push({
    name: portable.url.split("/").pop(),
    url: portable.url,
    size: portable.size,
  });
}
for (const entry of yml ?? []) {
  binaries.push({ name: entry.url, url: `${base}/${entry.url}`, size: entry.size });
}

for (const binary of binaries) {
  if (!binary.url) continue;
  const response = await head(binary.url);
  if (!check(response.status === 200, `${binary.name} answered HTTP ${response.status} on the feed`)) {
    continue;
  }
  const length = Number(response.headers.get("content-length") ?? -1);
  const cacheControl = response.headers.get("cache-control") ?? "(none)";
  check(binary.size === length, `${binary.name} is ${length} B on the feed, its manifest says ${binary.size} B`);
  check(
    isImmutable(cacheControl),
    `${binary.name} is served with cache-control "${cacheControl}", so every client re-downloads it`,
    `${binary.name} is immutable (${length} B)`,
  );
}

// 3b. The bytes behind the portable URL hash to what the manifest says. Every
// client refuses a mismatch only after downloading the whole file, so a corrupt
// object would break updates for everyone while every HEAD check still passed.
// `--download` (or VERIFY_DOWNLOAD=1) pays that one download.
const wantsDownload = process.argv.includes("--download") || process.env.VERIFY_DOWNLOAD === "1";
if (wantsDownload && portable?.url && portable.sha256) {
  try {
    const hash = createHash("sha256");
    const response = await fetch(portable.url, { headers: { "cache-control": "no-cache" } });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    let bytes = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const digest = hash.digest("hex");
    check(
      digest === portable.sha256.toLowerCase(),
      `the portable on the feed hashes to ${digest}, latest.json says ${portable.sha256}`,
      `the portable on the feed hashes to its manifest sha256 (${bytes} B)`,
    );
    check(bytes === portable.size, `the portable on the feed is ${bytes} B, latest.json says ${portable.size} B`);
  } catch (error) {
    problems.push(`could not download the portable to hash it: ${error.message}`);
  }
}

// 4. Both manifests describe the same release.
if (ymlText && portable) {
  check(
    versionOfYml(ymlText) === current,
    `latest.yml declares ${versionOfYml(ymlText)}, latest.json declares ${current}`,
    `both manifests declare ${current}`,
  );
}

// 5. Nothing outside the retention window is still being served.
const credentials = bucketCredentials();

function gitTaggedVersions() {
  try {
    return execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^v\d+\.\d+\.\d+$/.test(line))
      .map((line) => line.slice(1));
  } catch {
    return [];
  }
}

function releasedVersions() {
  try {
    return readdirSync(RELEASE_DIR).flatMap((name) => name.match(/\d+\.\d+\.\d+/) ?? []);
  } catch {
    return [];
  }
}

const known = new Set([current, ...gitTaggedVersions(), ...releasedVersions()]);
const ordered = [...known].sort(compareVersions);
const kept = new Set(ordered.slice(-keepCount));
kept.add(current);

if (credentials) {
  try {
    const keys = await listBucket(credentials);
    // The window is counted over the versions that are really in the bucket,
    // not over the tags. A tag whose upload failed never produced an object,
    // and counting it would report an eviction that did not happen.
    const bucketVersions = [...new Set(keys.map(versionOfKey).filter(Boolean))].sort(compareVersions);
    const windowVersions = bucketVersions.slice(-keepCount);
    if (!windowVersions.includes(current)) windowVersions.push(current);
    const windowNames = new Set(windowVersions.flatMap(objectNames));
    const strays = keys.filter((key) => {
      const version = versionOfKey(key);
      return version !== null && !windowNames.has(key);
    });
    check(
      strays.length === 0,
      `${strays.length} object(s) outside the retention window are still in the bucket: ${strays.slice(0, 5).join(", ")}`,
      `the bucket holds ${keys.length} object(s) for ${windowVersions.sort(compareVersions).join(", ")}`,
    );
    for (const key of objectNames(current)) {
      check(keys.includes(key), `${key} is missing from the bucket`);
    }
    for (const key of MANIFEST_KEYS) {
      check(keys.includes(key), `${key} is missing from the bucket`);
    }
  } catch (error) {
    problems.push(`cannot list the bucket: ${error.message}`);
  }
} else {
  passed.push("bucket not listed (no API token); probing the versions release/ knows instead");
  for (const version of ordered.filter((candidate) => !kept.has(candidate))) {
    for (const key of objectNames(version)) {
      const response = await head(`${base}/${key}`);
      check(response.status === 404, `${key} is still on the feed, outside the retention window`, `${key} is gone`);
    }
  }
}

if (problems.length > 0) {
  console.error(`[verify-feed] ${problems.length} problem(s) on ${base}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[verify-feed] ${current} is live and consistent, ${passed.length} checks passed:`);
for (const line of passed) console.log(`  - ${line}`);
