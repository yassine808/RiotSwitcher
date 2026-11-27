# Code signing

Windows builds are Authenticode-signed when a certificate is installed. The
certificate is the only missing input: the build, the release gate and the
verification are already wired.

## What gets signed

| Binary | Signed by |
|---|---|
| `RiotSwitcher.exe` (app) | electron-builder |
| `RiotSwitcher-Setup-<version>.exe` | electron-builder |
| `RiotSwitcher-Setup.exe` (README alias) | byte copy of the signed installer |
| `RiotSwitcher-<version>-portable.exe` | electron-builder |
| `resources/python/main.exe` (backend) | electron-builder, which signs `.exe` files copied into `resources` |

The backend is the important one. It is a PyInstaller executable shipped as an
`extraResource`. electron-builder signs it along with every other `.exe` under
`resources`, and `npm run verify:signatures` checks it by name so a future
electron-builder change cannot drop it silently. It is also the file antivirus
engines score hardest: an unsigned, metadata-free bootloader that spawns
processes and touches `%LOCALAPPDATA%` is a textbook heuristic hit.

## What a signature does and does not fix

| Effect | Covered |
|---|---|
| SmartScreen "Unknown publisher" | Yes, once the certificate builds reputation |
| Generic "unsigned / unknown" AV heuristics | Mostly |
| Behaviour detections (`HackTool`, `PUA`, game-tool rules) | **No** |
| An engine that already decided this exact hash is bad | **No** |

Signing raises the floor. It does not argue with a vendor's behavioural rule —
that needs a false-positive report (see below). Expect SmartScreen warnings to
fade over days or weeks as downloads accumulate against the certificate, not
instantly on the first signed release.

Do not self-sign a certificate and call the build signed. A self-signed
certificate is not trusted by anything and changes no verdict.

## Choosing a certificate

Public CAs no longer issue file-based `.pfx` code-signing certificates: since
June 2023 the key must live in FIPS 140-2 Level 2 hardware or a cloud HSM. That
is why the build reads a certificate from the Windows store instead of a file.
Both cloud products below present the key as a virtual smart card, so `signtool`
sees an ordinary store certificate.

| Option | Cost (check current) | Fits | CI |
|---|---|---|---|
| [Certum Open Source Code Signing](https://certum.store/open-source-code-signing-on-simplysign.html) | ~$50–60/yr | Individual maintaining a public, non-commercial OSS project. GPL-3.0 qualifies. Cheapest legitimate path. | Virtual smart card via SimplySign Desktop; the login is interactive, so in practice a self-hosted runner |
| [SSL.com IV Code Signing](https://www.ssl.com/certificates/iv/) | $129/yr + eSigner | Individual, no business entity required. Best documented headless signing. | eSigner CKA or CodeSignTool, built for hosted runners |
| [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) | $9.99/mo | US/Canada organisations with 3+ years of verifiable history. The individual preview is closed. Not available here. | `azure/trusted-signing-action` |
| [SignPath Foundation](https://signpath.org/) | Free | OSS only, **every** component under an OSI licence, no proprietary assets, no "hacking tools", verifiable reputation. The Riot playercards and the account-switching purpose make this a likely rejection. | GitHub App |

For this project the practical choice is Certum (cheapest, individual, OSS) or
SSL.com (more expensive, but the only one of the two designed to sign
unattended on a hosted runner). Buy the certificate in the name that should
appear in the UAC prompt; electron-builder copies that name into
`app-update.yml` and the updater verifies every future installer against it, so
changing certificate later means shipping one release signed with the old
identity.

## Local build

1. Complete the CA's identity validation (government ID, address, sometimes a
   phone call). Nothing in this repository can skip that step.
2. Install the provider agent and sign in:
   - Certum: SimplySign Desktop.
   - SSL.com: eSigner Cloud Key Adapter, or CodeSignTool for a CLI-only flow.
3. Confirm the certificate is visible:

   ```powershell
   Get-ChildItem Cert:\CurrentUser\My |
     Where-Object {
       $_.HasPrivateKey -and
       ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')
     } |
     Select-Object Thumbprint, Subject, NotAfter
   ```

4. Build:

   ```powershell
   npm run dist
   npm run verify:signatures
   ```

`scripts/package.mjs` picks the certificate automatically when exactly one is
installed. With several, name it explicitly:

```powershell
$env:WINDOWS_CERT_SHA1 = "AB12..."; npm run dist
# or
$env:WINDOWS_CERT_SUBJECT = "Yassine"; npm run dist
```

`WINDOWS_PUBLISHER_NAME` overrides the publisher name written to
`app-update.yml`; only needed when the certificate CN is not the name users
should see. It must match the certificate or updates fail signature
verification.

If signing fails with `A certificate chain processed, but terminated in a root
certificate which is not trusted`, the CA's root is missing from the build
machine. Install it (the provider agent usually does) — an unverifiable
signature is not shipped on purpose.

## CI

The runner needs the certificate in its store before packaging. Add the
provider's login as `scripts/signing-agent.ps1`; `release.yml` runs it when the
file exists. The script reads credentials from secrets and must exit non-zero
when signing is not ready — a silent fallback publishes an unsigned release.

```powershell
# scripts/signing-agent.ps1 — shape, not a working login
$ErrorActionPreference = "Stop"
# start SimplySign Desktop / eSigner CKA, wait until the cert is in the store,
# then fail loudly if it never appears
```

Secrets:

| Secret | Purpose |
|---|---|
| `WINDOWS_CERT_SHA1` | Thumbprint of the signing certificate |
| `WINDOWS_CERT_SUBJECT` | Alternative selector when the thumbprint is unknown |
| `WINDOWS_PUBLISHER_NAME` | Optional publisher-name override |

With `WINDOWS_CERT_SHA1` or `WINDOWS_CERT_SUBJECT` set, the release workflow
runs `verify:signatures` with `REQUIRE_SIGNING=1`: a missing, invalid or
untimestamped signature fails the release before anything is published. Without
them the build stays unsigned, as every release up to 3.2.0 was.

## When an engine still flags a build

1. Confirm which engines flag which file. VirusTotal lists them per binary;
   check `main.exe` and the installer separately.
2. Submit the file to Microsoft as a software developer:
   <https://www.microsoft.com/en-us/wdsi/filesubmission> → "Software developer"
   → incorrect detection. Repeat after each release whose hash changes.
3. Submit to the vendor that actually flagged it (Avast, Kaspersky, Bitdefender,
   ...). Most have a false-positive form; a signed binary with a version
   resource and a public source repository is a strong case.
4. Do not add packers, obfuscation or "crypter" layers to dodge a detection.
   They raise the score and can turn a heuristic hit into a permanent one.

If `main.exe` keeps getting flagged after signing, the next structural step is
replacing the PyInstaller bootloader with a plain launcher over an embedded
Python distribution. That is a packaging change, not a signing one, and is not
done yet.
