#!/usr/bin/env node
/**
 * electron-builder entry point that adds the code-signing certificate.
 *
 * `electron-builder` only reads a store certificate when the config names it,
 * and `${env.X}` macros throw when the variable is unset. This wrapper keeps
 * electron-builder.yml static: it resolves the certificate (explicit env or the
 * single one installed), appends the matching `-c.win.*` overrides, and runs
 * the CLI. Without a certificate the build stays unsigned instead of failing,
 * which keeps local development and forks working.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  electronBuilderSigningArgs,
  resolveSigningCertificate,
} from "./lib/signing.mjs";

const require = createRequire(import.meta.url);
const cli = require.resolve("electron-builder/cli.js");
const args = process.argv.slice(2);

let certificate;
try {
  certificate = resolveSigningCertificate();
} catch (error) {
  console.error(`Code signing: ${error.message}`);
  process.exit(1);
}

if (certificate) {
  if (certificate.selfSigned) {
    console.warn(
      "Code signing: this certificate is self-signed. Windows does not trust it, " +
        "so it changes no SmartScreen or antivirus verdict. Do not publish this build.",
    );
  }
  console.log(`Code signing with ${certificate.label}`);
  args.push(...electronBuilderSigningArgs(certificate));
} else {
  console.log(
    "Code signing: no certificate in Cert:\\CurrentUser\\My, building unsigned (docs/SIGNING.md)",
  );
}

const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
