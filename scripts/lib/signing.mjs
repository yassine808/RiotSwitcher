/**
 * Windows Authenticode signing helpers.
 *
 * The private key never enters the repository or a GitHub secret. Certum
 * SimplySign and SSL.com eSigner both expose the cloud key as a virtual smart
 * card, so while the provider agent runs the certificate shows up under
 * `Cert:\CurrentUser\My` and `signtool` can use it like any other store
 * certificate. The build only needs to know which certificate to pick:
 *
 *   WINDOWS_CERT_SHA1      thumbprint (preferred, unambiguous)
 *   WINDOWS_CERT_SUBJECT   subject substring (fallback)
 *
 * With neither set, a single valid code-signing certificate in the store is
 * used automatically. Zero certificates means an unsigned build, which the
 * release workflow only tolerates while no certificate is configured.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runPowerShell } from "./powershell.mjs";

const TIMESTAMP_URLS = [
  "http://timestamp.digicert.com",
  "http://timestamp.sectigo.com",
];

function env(name) {
  return (process.env[name] || "").trim();
}

/** Code-signing certificates with a private key that have not expired. */
export function listSigningCertificates() {
  // Read the store through .NET: the `Cert:` drive and its dynamic
  // `-CodeSigningCert` parameter are not available in every PowerShell host.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')",
    "$store.Open('ReadOnly')",
    "$certs = @($store.Certificates | Where-Object {",
    "  $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and",
    "  ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')",
    "} | Select-Object Thumbprint, Subject, NotAfter,",
    "  @{ Name = 'SelfSigned'; Expression = { $_.Subject -eq $_.Issuer } })",
    "$store.Close()",
    "ConvertTo-Json -Compress -InputObject $certs",
  ].join("\n");
  const raw = runPowerShell(script).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * The certificate the build should sign with, or null when none is available.
 *
 * A self-signed certificate is never picked automatically: Windows treats its
 * signature as untrusted, so it changes no SmartScreen or antivirus verdict and
 * only makes a release look signed when it is not. Name it explicitly to test
 * the signing path.
 */
export function resolveSigningCertificate() {
  const sha1 = env("WINDOWS_CERT_SHA1");
  const subject = env("WINDOWS_CERT_SUBJECT");
  if (sha1 || subject) {
    const requested = sha1
      ? { kind: "sha1", value: sha1, label: sha1 }
      : { kind: "subject", value: subject, label: subject };
    const match = listSigningCertificates().find((certificate) =>
      sha1
        ? certificate.Thumbprint.toUpperCase() === sha1.toUpperCase()
        : certificate.Subject.includes(subject),
    );
    return { ...requested, selfSigned: match ? match.SelfSigned === true : false };
  }

  const certificates = listSigningCertificates().filter(
    (certificate) => certificate.SelfSigned !== true,
  );
  if (certificates.length === 0) return null;
  if (certificates.length > 1) {
    const names = certificates.map((c) => `${c.Thumbprint} ${c.Subject}`).join("; ");
    throw new Error(
      `several code-signing certificates are installed (${names}); set WINDOWS_CERT_SHA1 to choose one`,
    );
  }
  const only = certificates[0];
  return { kind: "sha1", value: only.Thumbprint, label: only.Subject, auto: true };
}

/** electron-builder CLI overrides that select the certificate. */
export function electronBuilderSigningArgs(certificate) {
  if (!certificate) return [];
  const args =
    certificate.kind === "sha1"
      ? [`-c.win.signtoolOptions.certificateSha1=${certificate.value}`]
      : [`-c.win.signtoolOptions.certificateSubjectName=${certificate.value}`];
  const publisher = env("WINDOWS_PUBLISHER_NAME");
  // Normally electron-builder reads the publisher name from the certificate.
  // The override exists for certificates whose CN differs from the name users
  // should see; it must match what app-update.yml will verify.
  if (publisher) args.push(`-c.win.signtoolOptions.publisherName=${publisher}`);
  return args;
}

/** `signtool.exe` from PATH or the newest Windows SDK. */
export function findSignTool() {
  try {
    const fromPath = execFileSync("where.exe", ["signtool.exe"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (fromPath) return fromPath.split(/\r?\n/)[0];
  } catch {
    // not on PATH; fall through to the SDK
  }

  for (const root of [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
  ]) {
    if (!root) continue;
    const bin = join(root, "Windows Kits", "10", "bin");
    if (!existsSync(bin)) continue;
    const versions = readdirSync(bin)
      .filter((name) => /^\d+\.\d+/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(bin, version, "x64", "signtool.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    "signtool.exe was not found. Install the Windows SDK or add signtool to PATH.",
  );
}

function runSignTool(args) {
  const signtool = findSignTool();
  try {
    execFileSync(signtool, args, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || "").trim();
    throw new Error(`signtool ${args[0]} failed for ${args.at(-1)}: ${detail}`);
  }
}

/**
 * Sign one file and verify the result. Tries the timestamp servers in order:
 * a signature without a timestamp stops being valid when the certificate
 * expires, which is exactly when an old installer still needs to verify.
 */
export function signFile(file, certificate) {
  if (!certificate) throw new Error("signFile called without a certificate");
  const selector =
    certificate.kind === "sha1"
      ? ["/sha1", certificate.value]
      : ["/n", certificate.value];

  // Retry only the signing step: a failed timestamp server means no signature
  // was written, while a failed verification must not be papered over by a
  // second signing pass.
  let lastError;
  for (const timestamp of TIMESTAMP_URLS) {
    try {
      runSignTool([
        "sign",
        "/fd",
        "sha256",
        "/td",
        "sha256",
        "/tr",
        timestamp,
        "/s",
        "My",
        ...selector,
        file,
      ]);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;

  // A CA-signed file must verify against the machine's trust store; an
  // unverifiable signature is not shipped. A self-signed certificate can never
  // pass that check, so it is only allowed through with a warning — it exists to
  // exercise the signing path locally, and verify-signatures.mjs still refuses
  // it in a release.
  try {
    runSignTool(["verify", "/pa", "/q", file]);
  } catch (error) {
    if (!certificate.selfSigned) throw error;
    console.warn(
      `signtool could not verify the self-signed signature on ${file}; Windows will not trust it`,
    );
  }
}
