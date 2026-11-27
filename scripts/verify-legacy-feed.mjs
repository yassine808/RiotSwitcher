#!/usr/bin/env node
/**
 * Checks the one-time R2 bridge that moves pre-3.1.24 installs onto GitHub.
 *
 * Builds up to 3.1.23 have the R2 bucket URL compiled in, so they cannot be
 * edited after the fact. The bucket therefore serves two small manifests whose
 * download URLs point at GitHub. The client still *checks* R2 once, then
 * downloads and verifies the GitHub asset, and every later check is GitHub.
 *
 * This script proves that bridge is still correct: the legacy manifests parse,
 * every URL is a GitHub release URL for the version they declare, and the
 * hashes/sizes match the manifests GitHub publishes for that same tag. With
 * `--download` it also fetches both binaries and hashes them, which is the only
 * check that covers the bytes an old client installs.
 *
 *   node scripts/verify-legacy-feed.mjs
 *   node scripts/verify-legacy-feed.mjs --download
 */

import { createHash } from "node:crypto";

const REPO = "yassine808/RiotSwitcher";
const GITHUB = `https://github.com/${REPO}`;
const DEFAULT_LEGACY_BASE = "https://pub-6d3d6d22222242dab87967c474f39ada.r2.dev";

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

async function get(url) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

/** The first `files:` entry of an electron-builder latest.yml. */
function parseLatestYml(text) {
  const result = { version: "", path: "", files: [] };
  let current = null;
  let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("version:")) {
      result.version = line.slice("version:".length).trim();
    } else if (line === "files:") {
      inFiles = true;
    } else if (inFiles && /^\s+-\s+url:/.test(line)) {
      current = { url: line.replace(/^\s+-\s+url:\s*/, "") };
      result.files.push(current);
    } else if (inFiles && current && /^\s+sha512:/.test(line)) {
      current.sha512 = line.replace(/^\s+sha512:\s*/, "");
    } else if (inFiles && current && /^\s+size:/.test(line)) {
      current.size = Number(line.replace(/^\s+size:\s*/, ""));
    } else if (line.startsWith("path:")) {
      result.path = line.slice("path:".length).trim();
    }
  }
  return result;
}

function basename(url) {
  const clean = url.split("?")[0];
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** Content length without downloading the body; HEAD first, range as fallback. */
async function assetSize(url) {
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  const length = head.headers.get("content-length");
  if (head.ok && length) return Number(length);

  const ranged = await fetch(url, { headers: { range: "bytes=0-0" }, redirect: "follow" });
  const contentRange = ranged.headers.get("content-range");
  if (contentRange?.includes("/")) {
    return Number(contentRange.slice(contentRange.lastIndexOf("/") + 1));
  }
  return null;
}

async function downloadHash(url, algorithm) {
  const response = await get(url);
  const hash = createHash(algorithm);
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

const legacyBase = DEFAULT_LEGACY_BASE;
const download = process.argv.includes("--download");

console.log(`[verify-legacy] legacy feed: ${legacyBase}`);

const legacyYmlText = await (await get(`${legacyBase}/latest.yml`)).text();
const legacyJson = await (await get(`${legacyBase}/latest.json`)).json();
const legacyYml = parseLatestYml(legacyYmlText);

check(Boolean(legacyYml.version), "legacy latest.yml has no version", `legacy latest.yml: ${legacyYml.version}`);
check(
  legacyYml.version === legacyJson.version,
  `legacy manifests disagree: latest.yml says ${legacyYml.version}, latest.json says ${legacyJson.version}`,
  "legacy manifests declare the same version",
);

const setup = legacyYml.files[0] ?? {};
const portable = legacyJson.files?.portable ?? {};
const releaseBase = `${GITHUB}/releases/download/v${legacyYml.version}`;

check(
  Boolean(setup.url) && setup.url.startsWith(`${releaseBase}/`),
  `legacy latest.yml Setup URL is not the GitHub release: ${setup.url ?? "(missing)"}`,
  `Setup downloads from GitHub: ${basename(setup.url ?? "")}`,
);
check(
  Boolean(portable.url) && portable.url.startsWith(`${releaseBase}/`),
  `legacy latest.json portable URL is not the GitHub release: ${portable.url ?? "(missing)"}`,
  `portable downloads from GitHub: ${basename(portable.url ?? "")}`,
);
check(
  basename(setup.url ?? "") === `RiotSwitcher-Setup-${legacyYml.version}.exe`,
  `legacy Setup URL does not name RiotSwitcher-Setup-${legacyYml.version}.exe: ${setup.url}`,
  "legacy Setup URL names the versioned installer",
);
check(
  basename(portable.url ?? "") === `RiotSwitcher-${legacyYml.version}-portable.exe`,
  `legacy portable URL does not name RiotSwitcher-${legacyYml.version}-portable.exe: ${portable.url}`,
  "legacy portable URL names the versioned portable exe",
);
check(
  Boolean(legacyYml.path) && legacyYml.path.startsWith(`${releaseBase}/`),
  `legacy latest.yml path is not the GitHub release: ${legacyYml.path || "(missing)"}`,
  "legacy latest.yml path points at GitHub",
);
check(
  !/r2\.dev|cloudflare/i.test(`${setup.url} ${portable.url} ${legacyYml.path}`),
  "a legacy manifest still points back at Cloudflare",
  "no legacy download URL points back at Cloudflare",
);

const githubYml = parseLatestYml(await (await get(`${releaseBase}/latest.yml`)).text());
const githubJson = await (await get(`${releaseBase}/latest.json`)).json();
const githubSetup = githubYml.files[0] ?? {};
const githubPortable = githubJson.files?.portable ?? {};

check(
  githubYml.version === legacyYml.version,
  `GitHub latest.yml declares ${githubYml.version}, legacy says ${legacyYml.version}`,
  "GitHub and legacy latest.yml declare the same version",
);
check(
  setup.sha512 === githubSetup.sha512,
  "legacy Setup sha512 differs from the GitHub-published latest.yml",
  "legacy Setup sha512 matches GitHub",
);
check(
  setup.size === githubSetup.size,
  `legacy Setup size ${setup.size} differs from GitHub ${githubSetup.size}`,
  "legacy Setup size matches GitHub",
);
check(
  portable.sha256 === githubPortable.sha256,
  "legacy portable sha256 differs from the GitHub-published latest.json",
  "legacy portable sha256 matches GitHub",
);
check(
  portable.size === githubPortable.size,
  `legacy portable size ${portable.size} differs from GitHub ${githubPortable.size}`,
  "legacy portable size matches GitHub",
);

if (download) {
  console.log("[verify-legacy] downloading both assets for byte checks...");
  const setupHash = await downloadHash(setup.url, "sha512");
  check(
    setupHash === setup.sha512,
    "downloaded Setup sha512 does not match the legacy manifest",
    "downloaded Setup sha512 matches the legacy manifest",
  );
  const portableHash = await downloadHash(portable.url, "sha256");
  check(
    portableHash === portable.sha256,
    "downloaded portable sha256 does not match the legacy manifest",
    "downloaded portable sha256 matches the legacy manifest",
  );
} else {
  const setupSize = await assetSize(setup.url);
  const portableSize = await assetSize(portable.url);
  check(
    setupSize === setup.size,
    `GitHub Setup reports ${setupSize} bytes, legacy manifest says ${setup.size}`,
    "GitHub Setup answers with the declared size",
  );
  check(
    portableSize === portable.size,
    `GitHub portable reports ${portableSize} bytes, legacy manifest says ${portable.size}`,
    "GitHub portable answers with the declared size",
  );
}

for (const line of passed) console.log(`  PASS ${line}`);
for (const line of problems) console.error(`  FAIL ${line}`);
console.log(`[verify-legacy] ${passed.length} check(s) passed, ${problems.length} failed`);
if (problems.length > 0) process.exit(1);
