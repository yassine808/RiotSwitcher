#!/usr/bin/env node
/**
 * Verify that every Windows binary in `release/` carries a valid, timestamped
 * Authenticode signature.
 *
 * Run after packaging and before publishing. With REQUIRE_SIGNING=1 (the
 * release workflow sets it as soon as a certificate is configured) an unsigned
 * or broken binary fails the release. Without it — local builds, forks, the
 * unsigned releases published before a certificate existed — problems are
 * reported but do not fail.
 *
 * Pass file paths to check specific binaries instead of the release set.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPowerShell } from "./lib/powershell.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(ROOT, "release");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const explicit = process.argv.slice(2);
const targets =
  explicit.length > 0
    ? explicit.map((file) => ({ path: resolve(file), required: true }))
    : [
        { path: join(RELEASE, "win-unpacked", "RiotSwitcher.exe"), required: true },
        { path: join(RELEASE, "win-unpacked", "resources", "python", "main.exe"), required: true },
        { path: join(RELEASE, `RiotSwitcher-Setup-${version}.exe`), required: true },
        { path: join(RELEASE, `RiotSwitcher-${version}-portable.exe`), required: true },
        // Byte-for-byte copy made for the stable README link; only the release
        // workflow creates it.
        { path: join(RELEASE, "RiotSwitcher-Setup.exe"), required: false },
      ];

const present = targets.filter((target) => existsSync(target.path));
const label = (file) => (file.startsWith(RELEASE) ? file.slice(RELEASE.length + 1) : file);
const missing = targets
  .filter((target) => target.required && !existsSync(target.path))
  .map((target) => label(target.path));

if (missing.length > 0) {
  // A missing binary is not a signing problem: the build is incomplete, and
  // nothing downstream can fix that. Fail whether or not signing is required.
  for (const name of missing) console.error(`bad ${name}: missing`);
  console.error("verify-signatures: expected release binaries are missing; run the packaging step first");
  process.exit(1);
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const script = [
  "$ErrorActionPreference = 'Stop'",
  "$rows = @()",
  ...present.map((target) => {
    const file = quotePowerShell(target.path);
    return [
      `$signature = Get-AuthenticodeSignature -LiteralPath ${file}`,
      "$subject = ''",
      "if ($signature.SignerCertificate) { $subject = $signature.SignerCertificate.Subject }",
      "$rows += [pscustomobject]@{",
      `  File = ${file}`,
      "  Status = $signature.Status.ToString()",
      "  Subject = $subject",
      "  Timestamped = ($null -ne $signature.TimeStamperCertificate)",
      "}",
    ].join("\n");
  }),
  "ConvertTo-Json -Compress -InputObject $rows",
].join("\n");

const raw = runPowerShell(script).trim();
const parsed = JSON.parse(raw);
const results = Array.isArray(parsed) ? parsed : [parsed];

const requireSigning = ["1", "true", "yes"].includes(
  (process.env.REQUIRE_SIGNING || "").trim().toLowerCase(),
);

const problems = [];
for (const target of present) {
  const result = results.find((row) => row.File === target.path);
  const name = label(target.path);
  if (!result) {
    problems.push(`${name}: no signature result`);
    continue;
  }
  if (result.Status !== "Valid") {
    problems.push(`${name}: signature is ${result.Status}`);
    continue;
  }
  if (!result.Timestamped) {
    problems.push(`${name}: signed but not timestamped`);
    continue;
  }
  console.log(`ok  ${name}  ${result.Subject}`);
}

if (problems.length === 0) {
  console.log(`verify-signatures: ${present.length} binaries signed and timestamped`);
  process.exit(0);
}

for (const problem of problems) console.error(`bad ${problem}`);
if (requireSigning) {
  console.error("verify-signatures: signing is required for this build");
  process.exit(1);
}
console.warn("verify-signatures: unsigned build; set REQUIRE_SIGNING=1 to make this fatal");
process.exit(0);
