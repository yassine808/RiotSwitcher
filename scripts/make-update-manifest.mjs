#!/usr/bin/env node
/**
 * Writes release/latest.json, the manifest the portable build updates from.
 *
 * electron-builder writes latest.yml for the NSIS updater; the portable build
 * needs the same facts in a form it can read without a YAML parser. Run after
 * packaging, before uploading to the feed:
 *
 *   node scripts/make-update-manifest.mjs            # base from updateFeed.ts
 *   node scripts/make-update-manifest.mjs --base https://cdn.example.com
 *   node scripts/make-update-manifest.mjs --version 3.1.11
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const RELEASE_DIR = join(ROOT, "release");

function fail(message) {
  console.error(`[update-manifest] ${message}`);
  process.exit(1);
}

const baseFlag = process.argv.indexOf("--base");
let base = baseFlag === -1 ? null : process.argv[baseFlag + 1];

if (!base) {
  const source = readFileSync(join(ROOT, "src", "main", "updateFeed.ts"), "utf8");
  const match = source.match(/DEFAULT_FEED_URL\s*=\s*"([^"]+)"/);
  if (!match) {
    fail("cannot read DEFAULT_FEED_URL from src/main/updateFeed.ts; pass --base");
  }
  base = match[1];
}
base = base.replace(/\/+$/, "");

// The package version by default; --version writes the manifest for a release
// that is already built, which is what a withdrawal needs.
const versionFlag = process.argv.indexOf("--version");
const { version: pkgVersion } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = versionFlag === -1 ? pkgVersion : process.argv[versionFlag + 1];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail(`invalid version: ${version ?? "(missing)"}`);

const portableName = `RiotSwitcher-${version}-portable.exe`;
const portablePath = join(RELEASE_DIR, portableName);

if (!existsSync(portablePath)) {
  const present = existsSync(RELEASE_DIR)
    ? readdirSync(RELEASE_DIR).filter((name) => name.endsWith("-portable.exe"))
    : [];
  fail(`${portableName} is not in release/` + (present.length > 0 ? ` (found: ${present.join(", ")})` : ""));
}

const bytes = readFileSync(portablePath);
const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  files: {
    portable: {
      url: `${base}/${portableName}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: statSync(portablePath).size,
    },
  },
};

const target = join(RELEASE_DIR, "latest.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[update-manifest] ${target} -> ${manifest.files.portable.url}`);
