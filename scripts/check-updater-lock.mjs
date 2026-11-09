#!/usr/bin/env node
/**
 * Pins the auto-updater source.
 *
 * `src/main/updater.ts` is the one module that must never change by accident:
 * it is what lets every installed copy receive future versions. A stray edit
 * here breaks updates for everyone, and the breakage only shows up on machines
 * that are already installed -- the hardest place to fix it.
 *
 * This check hashes the pinned files and fails CI when they differ from the
 * recorded digest. Re-pin only after an approved change:
 *
 *   node scripts/check-updater-lock.mjs            # verify (CI)
 *   node scripts/check-updater-lock.mjs --update   # rewrite the lock file
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const LOCK_FILE = join(SCRIPT_DIR, "updater.lock.json");
const PINNED_FILES = ["src/main/updater.ts"];

const update = process.argv.includes("--update");

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (update) {
  const files = Object.fromEntries(
    PINNED_FILES.map((file) => [file, digest(join(ROOT, file))]),
  );
  writeFileSync(
    LOCK_FILE,
    `${JSON.stringify(
      {
        note: "sha256 of files that must not change. Re-pin with: node scripts/check-updater-lock.mjs --update",
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[updater-lock] re-pinned ${PINNED_FILES.length} file(s)`);
  process.exit(0);
}

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
} catch (error) {
  console.error(`[updater-lock] cannot read ${LOCK_FILE}: ${error.message}`);
  console.error("[updater-lock] create it with: node scripts/check-updater-lock.mjs --update");
  process.exit(1);
}

const expected = lock.files ?? {};
const failures = [];

for (const file of PINNED_FILES) {
  let actual;
  try {
    actual = digest(join(ROOT, file));
  } catch (error) {
    failures.push(`${file}: cannot read (${error.message})`);
    continue;
  }
  if (expected[file] === undefined) {
    failures.push(`${file}: not pinned in ${LOCK_FILE}`);
  } else if (actual !== expected[file]) {
    failures.push(
      `${file}: changed\n  pinned   ${expected[file]}\n  current  ${actual}`,
    );
  } else {
    console.log(`[updater-lock] ${file} unchanged (${actual})`);
  }
}

if (failures.length > 0) {
  console.error("[updater-lock] the auto-updater is pinned and must not change:");
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error(
    "[updater-lock] if the change is deliberate, re-pin it in the same commit:\n" +
      "  node scripts/check-updater-lock.mjs --update",
  );
  process.exit(1);
}
