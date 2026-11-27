#!/usr/bin/env node
/**
 * Checks the release about to be published before it reaches the feed:
 *
 *   0. the tag being released names the version in package.json,
 *   1. the pinned updater source still hashes to the lock file,
 *   2. the packaged app carries the live feed URL (the updater it ships is the
 *      one in this tree, not an older build),
 *   3. latest.yml describes the files sitting next to it: version, size and
 *      sha512 for every url it names,
 *   4. latest.json does the same for the portable exe, and both manifests agree
 *      on the version.
 *
 * release.yml runs this after packaging and before publishing, so a manifest
 * that names something the bucket will not have never gets uploaded.
 *
 *   node scripts/verify-release.mjs                  # local, no tag to check
 *   node scripts/verify-release.mjs --tag v3.1.13    # what CI runs
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const RELEASE_DIR = join(ROOT, "release");
const PACKAGED_ASAR = join(RELEASE_DIR, "win-unpacked", "resources", "app.asar");
const MAIN_BUNDLE = join(ROOT, "out", "main", "index.js");

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

function digest(path, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function feedUrl() {
  const source = readFileSync(join(ROOT, "src", "main", "updateFeed.ts"), "utf8");
  const match = source.match(/DEFAULT_FEED_URL\s*=\s*"([^"]+)"/);
  if (!match) {
    problems.push("cannot read DEFAULT_FEED_URL from src/main/updateFeed.ts");
    return null;
  }
  return match[1];
}

function version() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

/**
 * The `files:` blocks electron-builder writes, read line by line so an extra
 * key inside a block cannot make the whole file unparseable.
 */
function parseLatestYml(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- url:")) {
      entries.push({ url: trimmed.slice(6).trim(), sha512: null, size: null });
    } else if (line.startsWith(" ") && trimmed.startsWith("sha512:") && entries.length > 0) {
      entries.at(-1).sha512 = trimmed.slice(7).trim();
    } else if (line.startsWith(" ") && trimmed.startsWith("size:") && entries.length > 0) {
      entries.at(-1).size = Number(trimmed.slice(5).trim());
    }
  }
  return entries;
}

const current = version();
const url = feedUrl();

// 0. The tag names the release; package.json names the build. A mismatch would
// publish one version under another version's name, and nothing downstream
// would notice: both manifests would still agree with each other.
const tagFlag = process.argv.indexOf("--tag");
const tag = tagFlag === -1 ? process.env.RELEASE_TAG : process.argv[tagFlag + 1];
if (tag) {
  const expected = tag.replace(/^v/, "");
  check(
    expected === current,
    `tag ${tag} does not match package.json ${current}: the release would be named ${tag} but contain ${current}`,
    `tag ${tag} matches package.json ${current}`,
  );
} else {
  console.log("[verify-release] no tag given, skipped the tag/version check");
}

// 1. The updater code is the one CI pinned.
try {
  execFileSync(process.execPath, [join(SCRIPT_DIR, "check-updater-lock.mjs")], {
    cwd: ROOT,
    stdio: "pipe",
  });
  passed.push("updater source matches the lock file");
} catch (error) {
  const output = `${error.stderr ?? ""}\n${error.stdout ?? ""}`.replaceAll("\r", "");
  const reason = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(changed|not pinned|cannot read)/.test(line) && !line.includes("unchanged"))
    .join("; ");
  problems.push(reason ? `updater source changed without a re-pin: ${reason}` : "updater source changed without a re-pin");
}

// 2. The app that ships is built from this tree and points at the live feed.
if (url) {
  const artifact = existsSync(PACKAGED_ASAR) ? PACKAGED_ASAR : MAIN_BUNDLE;
  const label = relative(ROOT, artifact).replaceAll("\\", "/");
  if (
    check(
      existsSync(artifact),
      `no packaged app: neither ${relative(ROOT, PACKAGED_ASAR).replaceAll("\\", "/")} nor ${relative(ROOT, MAIN_BUNDLE).replaceAll("\\", "/")} exists (run npm run build)`,
      `packaged app found: ${label}`,
    )
  ) {
    check(
      readFileSync(artifact).includes(url),
      `packaged app does not contain ${url}, so it carries an older updater`,
      `packaged app carries ${url}`,
    );
  }
}

// 3. latest.yml names files that exist here, byte for byte.
const ymlPath = join(RELEASE_DIR, "latest.yml");
if (check(existsSync(ymlPath), "release/latest.yml is missing", "release/latest.yml found")) {
  const text = readFileSync(ymlPath, "utf8");
  const declared = text.match(/^version:\s*(\S+)\s*$/m)?.[1];
  check(
    declared === current,
    `latest.yml declares ${declared}, package.json says ${current}`,
    `latest.yml declares ${current}`,
  );

  const entries = parseLatestYml(text);
  check(entries.length > 0, "latest.yml lists no files", `latest.yml lists ${entries.length} file(s)`);

  for (const entry of entries) {
    const path = join(RELEASE_DIR, entry.url);
    if (!check(existsSync(path), `latest.yml names ${entry.url}, which is not in release/`)) continue;
    const size = statSync(path).size;
    check(entry.size === size, `latest.yml size for ${entry.url} is ${entry.size}, the file is ${size}`);
    check(
      entry.sha512 === digest(path, "sha512", "base64"),
      `latest.yml sha512 for ${entry.url} does not match the file`,
      `latest.yml matches ${entry.url} (${size} B, sha512 ok)`,
    );
  }

  // electron-updater downloads `path` first; it must be one of the entries.
  const pathLine = text.split("\n").find((line) => line.startsWith("path:"));
  const pathEntry = pathLine?.slice(5).trim();
  if (pathEntry) {
    check(
      entries.some((entry) => entry.url === pathEntry),
      `latest.yml path ${pathEntry} is not one of its files`,
      `latest.yml path is ${pathEntry}`,
    );
  }
}

// 4. latest.json does the same for the portable exe.
const jsonPath = join(RELEASE_DIR, "latest.json");
if (check(existsSync(jsonPath), "release/latest.json is missing", "release/latest.json found")) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (error) {
    problems.push(`release/latest.json is not valid JSON: ${error.message}`);
  }

  if (manifest) {
    check(
      manifest.version === current,
      `latest.json declares ${manifest.version}, package.json says ${current}`,
      `latest.json declares ${current}`,
    );

    const portable = manifest.files?.portable;
    if (check(Boolean(portable?.url), "latest.json has no files.portable.url")) {
      check(
        Boolean(url) && portable.url.startsWith(url),
        `latest.json url ${portable.url} is not under the feed ${url}`,
        "latest.json url is on the feed",
      );

      const name = basename(portable.url);
      const path = join(RELEASE_DIR, name);
      if (check(existsSync(path), `latest.json names ${name}, which is not in release/`)) {
        const size = statSync(path).size;
        check(portable.size === size, `latest.json size for ${name} is ${portable.size}, the file is ${size}`);
        check(
          portable.sha256 === digest(path, "sha256", "hex"),
          `latest.json sha256 for ${name} does not match the file`,
          `latest.json matches ${name} (${size} B, sha256 ok)`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`[verify-release] ${problems.length} problem(s), nothing was published:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[verify-release] ${current} is consistent, ${passed.length} checks passed:`);
for (const line of passed) console.log(`  - ${line}`);
