#!/usr/bin/env node
/**
 * Checks the live GitHub release feed after a publish, from the public URL the
 * way both updaters read it.
 *
 * `verify-release.mjs` runs before anything is uploaded and proves the release
 * is consistent. This runs after the release is public and proves the upload
 * worked: both manifests resolve from `releases/latest/download`, name this
 * version, and the binaries behind them answer 200 with the declared size.
 * With `--download` it also fetches the portable once and hashes it, which is
 * the only check that covers the bytes a client actually installs.
 *
 * A stale redirect is retried for a while before it counts as a failure: the
 * latest pointer and the asset CDN do not always update in the same second.
 *
 *   node scripts/verify-feed.mjs                  # package.json version
 *   node scripts/verify-feed.mjs --version 3.1.12 # check the version on the feed
 *   node scripts/verify-feed.mjs --timeout 30     # give up sooner on propagation
 *   node scripts/verify-feed.mjs --download       # also hash the portable itself
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");

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

/** Drops trailing slashes without a regex: the feed is a URL, not a pattern. */
function withoutTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

/** The feed base, read from the source of truth the app ships. */
function feedBase() {
  const source = readFileSync(join(ROOT, "src", "main", "updateFeed.ts"), "utf8");
  const match = source.match(/DEFAULT_FEED_URL\s*=\s*"([^"]+)"/);
  if (!match) {
    console.error("[verify-feed] cannot read DEFAULT_FEED_URL from src/main/updateFeed.ts");
    process.exit(1);
  }
  return withoutTrailingSlashes(match[1]);
}

const current = argvValue("--version", JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
const timeoutMs = Number(argvValue("--timeout", "60")) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(`[verify-feed] invalid timeout: ${timeoutMs}`);
  process.exit(1);
}

const base = feedBase();

/**
 * Fetches an asset until its body satisfies `isCurrent`.
 *
 * The previous release can still be behind the redirect when this runs.
 * Retrying is not leniency: it separates "GitHub has not switched yet" from
 * "the upload never happened", and the second one has to fail the run.
 */
async function readAsset(name, isCurrent) {
  const deadline = Date.now() + timeoutMs;

  // Recursion, not a loop: every attempt must finish before the next starts.
  const attempt = async (n) => {
    const url = `${base}/${name}?t=${Date.now()}`;
    let response;
    try {
      response = await fetch(url, { headers: { "cache-control": "no-cache" }, redirect: "follow" });
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`${name}: ${error.message}`);
      await sleep(3000);
      return attempt(n + 1);
    }

    if (!response.ok) {
      if (Date.now() >= deadline) throw new Error(`${name}: HTTP ${response.status}`);
      await sleep(3000);
      return attempt(n + 1);
    }

    const text = await response.text();
    if (isCurrent(text)) return { text, attempts: n };

    if (Date.now() >= deadline) {
      throw new Error(`${name}: still not this version after ${n} attempt(s)`);
    }
    await sleep(3000);
    return attempt(n + 1);
  };

  return attempt(1);
}

/** The `files:` entries electron-builder writes into latest.yml. */
function parseLatestYml(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- url:")) {
      entries.push({ url: trimmed.slice(6).trim(), size: null });
    } else if (line.startsWith(" ") && trimmed.startsWith("size:") && entries.length > 0) {
      entries.at(-1).size = Number(trimmed.slice(5).trim());
    }
  }
  return entries;
}

function versionOfYml(text) {
  return text.match(/^version:\s*(\S+)\s*$/m)?.[1] ?? null;
}

async function head(url) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    return { status: response.status, headers: response.headers };
  } catch (error) {
    return { status: 0, headers: new Headers(), error: error.message };
  }
}

// 1. latest.json: the manifest the portable build reads.
let portable = null;
try {
  const manifest = await readAsset("latest.json", (text) => {
    try {
      return JSON.parse(text).version === current;
    } catch {
      return false;
    }
  });
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
    check(
      /^[a-f0-9]{64}$/i.test(portable.sha256 ?? ""),
      "latest.json has no portable sha256",
      "latest.json carries the portable sha256",
    );
  }
} catch (error) {
  problems.push(`latest.json: ${error.message}`);
}

// 2. latest.yml: the manifest the installed (NSIS) build reads.
let ymlText = null;
let yml = null;
try {
  const manifest = await readAsset("latest.yml", (text) => versionOfYml(text) === current);
  if (manifest.attempts > 1) {
    passed.push(`latest.yml took ${manifest.attempts} attempts to show ${current}`);
  }

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

const inspected = await Promise.all(
  binaries.map(async (binary) => {
    if (!binary.url) return null;
    const response = await head(binary.url);
    return {
      binary,
      status: response.status,
      length: Number(response.headers.get("content-length") ?? -1),
    };
  }),
);

for (const result of inspected) {
  if (!result) continue;
  const { binary, status, length } = result;
  if (!check(status === 200, `${binary.name} answered HTTP ${status} on the feed`)) continue;
  check(binary.size === length, `${binary.name} is ${length} B on the feed, its manifest says ${binary.size} B`);
  passed.push(`${binary.name} is public (${length} B)`);
}

// 3b. The bytes behind the portable URL hash to what the manifest says. Every
// client refuses a mismatch only after downloading the whole file, so a corrupt
// object would break updates for everyone while every HEAD check still passed.
const wantsDownload = process.argv.includes("--download") || process.env.VERIFY_DOWNLOAD === "1";
if (wantsDownload && portable?.url && portable.sha256) {
  try {
    const hash = createHash("sha256");
    const response = await fetch(portable.url, { headers: { "cache-control": "no-cache" }, redirect: "follow" });
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

if (problems.length > 0) {
  console.error(`[verify-feed] ${problems.length} problem(s) on ${base}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[verify-feed] ${current} is live and consistent, ${passed.length} checks passed:`);
for (const line of passed) console.log(`  - ${line}`);
