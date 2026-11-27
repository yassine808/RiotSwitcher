#!/usr/bin/env node
/**
 * The updater gate.
 *
 * `check-updater-lock.mjs` proves the three updater modules did not change
 * without a re-pin. That is necessary but not enough: a pinned updater can still
 * point at the wrong host, lose a required event, or be shipped by a release
 * workflow that forgets one of the two artifacts. Every one of those failures
 * reaches users only after the installed copy can no longer update itself.
 *
 * This script checks the whole path in one place:
 *
 *   1. the pinned modules still match updater.lock.json;
 *   2. the feed is the public GitHub release of the repository in package.json,
 *      not a CDN;
 *   3. electron-builder still produces both targets and both manifests;
 *   4. `updater.ts` downloads, verifies, installs and reports every stage;
 *   5. `portableUpdate.ts` reads latest.json, checks sha256 + size and swaps;
 *   6. `index.ts` routes each build to its own updater;
 *   7. release.yml publishes both artifacts and both manifests, draft first;
 *   8. no release path still talks to Cloudflare R2.
 *
 *   node scripts/check-updater.mjs             # source-level gate (CI)
 *   node scripts/check-updater.mjs --built     # also require the built bundle
 *                                              # to carry the live feed URL
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

function requirePattern(source, pattern, label, failure) {
  return check(pattern.test(source), failure ?? `${label} is missing`, `${label} present`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// 1. The pinned modules. A deliberate change re-pins in the same commit.
try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "check-updater-lock.mjs")], {
    cwd: ROOT,
    stdio: "pipe",
  });
  passed.push("updater modules match updater.lock.json");
} catch (error) {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n  ");
  problems.push(`updater modules changed without a re-pin:\n  ${output}`);
}

// 2. The feed is the public GitHub release of this repository.
const pkg = JSON.parse(read("package.json"));
const feedSource = read("src/main/updateFeed.ts");
const feedUrl = feedSource.match(/DEFAULT_FEED_URL\s*=\s*"([^"]+)"/)?.[1] ?? null;
const repoMatch = (pkg.repository?.url ?? "").match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
const owner = repoMatch?.[1] ?? null;
const repo = repoMatch?.[2] ?? null;
const expectedFeed = owner && repo ? `https://github.com/${owner}/${repo}/releases/latest/download` : null;

check(Boolean(expectedFeed), "package.json has no GitHub repository URL", "package.json names the GitHub repository");
check(
  feedUrl === expectedFeed,
  `DEFAULT_FEED_URL is ${feedUrl ?? "(missing)"}, expected ${expectedFeed ?? "(unknown)"}`,
  `update feed is ${expectedFeed}`,
);
check(
  !/r2\.dev|cloudflare|\.r2\.|pub-[a-z0-9]/i.test(feedUrl ?? ""),
  `update feed still names a Cloudflare R2 host: ${feedUrl}`,
  "update feed has no Cloudflare host",
);

// 3. electron-builder still produces both artifacts and both manifests.
const builder = read("electron-builder.yml");
if (owner && repo) {
  requirePattern(builder, /^publish:\s*$/m, "publish block");
  requirePattern(builder, /^[ \t]+provider:[ \t]*github[ \t]*$/m, "GitHub publish provider");
  requirePattern(builder, new RegExp(String.raw`^\s+owner:\s*${escapeRegExp(owner)}\s*$`, "m"), "publish owner");
  requirePattern(builder, new RegExp(String.raw`^\s+repo:\s*${escapeRegExp(repo)}\s*$`, "m"), "publish repo");
}
requirePattern(builder, /^[ \t]+-[ \t]+target:[ \t]*nsis[ \t]*$/m, "NSIS target");
requirePattern(builder, /^[ \t]+-[ \t]+target:[ \t]*portable[ \t]*$/m, "portable target");
requirePattern(
  builder,
  /artifactName:\s*"\$\{productName\}-Setup-\$\{version\}\.\$\{ext\}"/,
  "versioned Setup artifact name",
);
requirePattern(
  builder,
  /artifactName:\s*"\$\{productName\}-\$\{version\}-portable\.exe"/,
  "versioned portable artifact name",
);

// 4. The installed build downloads, verifies, installs and reports every stage.
const updater = read("src/main/updater.ts");
requirePattern(updater, /from "electron-updater"/, "electron-updater import");
requirePattern(updater, /autoUpdater\.autoDownload\s*=\s*true/, "automatic download");
requirePattern(
  updater,
  /autoUpdater\.setFeedURL\(\{\s*provider:\s*"generic",\s*url:\s*UPDATE_FEED_URL\s*\}\)/,
  "generic GitHub feed",
);
for (const event of [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
]) {
  requirePattern(updater, new RegExp(String.raw`autoUpdater\.on\("${event}"`), `"${event}" handler`);
}
requirePattern(updater, /autoUpdater\.quitAndInstall\(true,\s*true\)/, "silent install and restart");
requirePattern(updater, /dialog\.showMessageBox/, "visible failure dialog");
requirePattern(updater, /app\.quit\(\)/, "exit after a failed update");
requirePattern(updater, /setInterval\(runCheck,\s*UPDATE_CHECK_INTERVAL_MS\)/, "periodic update check");

// 5. The portable build reads its own manifest, verifies the bytes and swaps.
const portable = read("src/main/portableUpdate.ts");
requirePattern(portable, /export function manifestUrl\(\)/, "portable manifest URL");
requirePattern(portable, /\$\{UPDATE_FEED_URL\}\/latest\.json/, "latest.json on the feed");
requirePattern(portable, /createHash\("sha256"\)/, "portable sha256 hashing");
requirePattern(portable, /file\.sha256 && digest !== file\.sha256\.toLowerCase\(\)/, "portable checksum check");
requirePattern(portable, /statSync\(target\)\.size !== file\.size/, "portable size check");
requirePattern(portable, /const cmd = join\([^)]*"cmd\.exe"\)/, "absolute cmd.exe path");
requirePattern(portable, /spawn\(cmd, \["\/d", "\/c", script\]/, "detached swap script");
requirePattern(portable, /PORTABLE_EXECUTABLE_FILE/, "portable exe detection");
requirePattern(portable, /app\.quit\(\)/, "exit before the swap");

// 6. The main process routes each build to its own updater.
const index = read("src/main/index.ts");
requirePattern(index, /initAutoUpdater\(\)/, "installed updater startup");
requirePattern(index, /initPortableUpdater\(appWindow\.win\)/, "portable updater startup");
requirePattern(index, /setUpdateWindow\(appWindow\.win\)/, "update window registration");
requirePattern(index, /isPortableBuild\(\) \? checkPortableUpdates\(\) : checkForUpdates\(\)/, "update:check routing");
requirePattern(
  index,
  /isPortableBuild\(\) \? downloadPortableUpdate\(\) : downloadUpdate\(\)/,
  "update:download routing",
);
requirePattern(
  index,
  /isPortableBuild\(\) \? quitAndInstallPortable\(\) : quitAndInstall\(\)/,
  "update:install routing",
);

// 7. The release publishes both artifacts and both manifests, draft first.
const release = read(".github/workflows/release.yml");
requirePattern(release, /tags:\s*\["v\*"\]/, "v* release trigger");
requirePattern(release, /npm run check:updater/, "updater gate in the release");
requirePattern(release, /npm run verify:release/, "pre-publish verification");
requirePattern(release, /npm run verify:feed/, "post-publish verification");
requirePattern(release, /latest\.yml/, "latest.yml upload");
requirePattern(release, /latest\.json/, "latest.json upload");
requirePattern(release, /-match '\\\.\(exe\|blockmap\)\$'/, "binary upload filter");
requirePattern(release, /RiotSwitcher-Setup\.exe/, "stable Setup.exe download alias");
requirePattern(release, /--draft\b/, "draft release before upload");
requirePattern(release, /--draft=false/, "publish only after upload");
check(
  !/wrangler|CLOUDFLARE|r2\.dev|R2_BUCKET/i.test(release),
  "release.yml still publishes to Cloudflare R2",
  "release.yml publishes only to GitHub Releases",
);

// 8. Withdrawal uses the GitHub latest pointer, not an object store.
const withdraw = read(".github/workflows/withdraw.yml");
requirePattern(withdraw, /gh release edit .*--latest/, "withdraw via the GitHub latest flag");
check(
  !/wrangler|CLOUDFLARE|r2\.dev|R2_BUCKET/i.test(withdraw),
  "withdraw.yml still talks to Cloudflare R2",
  "withdraw.yml uses GitHub Releases only",
);

// 9. The manifest generator and the release verifier cover both formats.
const manifest = read("scripts/make-update-manifest.mjs");
requirePattern(manifest, /DEFAULT_FEED_URL/, "manifest reads the live feed URL");
requirePattern(manifest, /createHash\("sha256"\)/, "manifest hashes the portable");
requirePattern(manifest, /files:\s*\{[\s\S]*portable:/, "manifest carries the portable file");
const verifyRelease = read("scripts/verify-release.mjs");
requirePattern(verifyRelease, /PACKAGED_ASAR/, "release verifier inspects the packaged app");
requirePattern(verifyRelease, /latest\.yml/, "release verifier checks latest.yml");
requirePattern(verifyRelease, /latest\.json/, "release verifier checks latest.json");

// 10. The runtime dependency is present.
check(
  Boolean(pkg.dependencies?.["electron-updater"]),
  "electron-updater is not a runtime dependency",
  "electron-updater is a runtime dependency",
);

// 11. Optional: the built main bundle really carries the feed URL.
if (process.argv.includes("--built")) {
  const builtPath = join(ROOT, "out", "main", "index.js");
  if (check(existsSync(builtPath), "out/main/index.js is missing; run npm run build first", "built main bundle found")) {
    const built = readFileSync(builtPath, "utf8");
    check(
      feedUrl ? built.includes(feedUrl) : false,
      `the built main bundle does not contain ${feedUrl ?? "the feed URL"}`,
      "built main bundle carries the live feed URL",
    );
    check(
      !built.includes("pub-6d3d6d22222242dab87967c474f39ada.r2.dev"),
      "the built main bundle still contains the old R2 feed",
      "built main bundle has no old R2 feed",
    );
  }
}

if (problems.length > 0) {
  console.error(`[updater-check] ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[updater-check] ${passed.length} checks passed:`);
for (const line of passed) console.log(`  - ${line}`);
