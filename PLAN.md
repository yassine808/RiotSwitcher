# Plan — automated updates

Two phases, one pipeline. Phase 1 is everything that gets a build into the
bucket; phase 2 is everything that gets it out of the bucket and onto a user's
machine. Neither phase is done until it has been run for real, not just built.

```mermaid
flowchart LR
  subgraph P1["Phase 1 — publish"]
    T["git tag v3.1.13"] --> B["build<br/>NSIS + portable"]
    B --> V1{"verify:release"}
    V1 -- fail --> X["stop<br/>nothing published"]
    V1 -- pass --> G["GitHub release"]
    G --> U["upload to R2<br/>binaries, then manifests"]
    U --> P["prune<br/>latest only"]
    P --> V2{"verify:feed"}
  end

  subgraph P2["Phase 2 — consume"]
    C["installed / portable app"] --> F["GET latest.yml / latest.json"]
    F --> D["download + verify"]
    D --> I["install<br/>NSIS silent / portable swap"]
  end

  V2 -- pass --> F
```

## Phase 1 — build → verify → R2

Status: **code complete, one secret missing, first real run pending.**

| # | Step | Where | State |
|---|---|---|---|
| 1 | `v*` tag starts the build | `release.yml` | done |
| 2 | Missing feed credentials fail on step 1 | `release.yml` | done |
| 3 | Typecheck, lint, vitest, pytest must pass | `release.yml` | done |
| 4 | Pinned updater source must match `updater.lock.json` | `check-updater-lock.mjs` | done |
| 5 | Build the Python backend, Electron app, NSIS + portable | `release.yml` | done |
| 6 | `latest.yml` (electron-builder) + `latest.json` (portable) | `make-update-manifest.mjs` | done |
| 7 | Tag names the same version as `package.json` | `verify-release.mjs` | done |
| 8 | Packaged `app.asar` carries the live feed URL | `verify-release.mjs` | done |
| 9 | Both manifests match the files in `release/` byte for byte | `verify-release.mjs` | done |
| 10 | GitHub release: setup, blockmap, `latest.yml`, `latest.json` | `release.yml` | done |
| 11 | Upload binaries first, then manifests, with cache headers | `release.yml` | done |
| 12 | Prune everything outside the window, from the bucket's own listing | `prune-feed.mjs` | done |
| 13 | Read the public feed back: version, sizes, headers, leftovers | `verify-feed.mjs` | done |
| 14 | `CLOUDFLARE_API_TOKEN` repo secret | GitHub settings | **blocked — needs the token** |
| 15 | First end-to-end run for `v3.1.13` | Actions | pending |

Phase 1 is done when a tag push produces a run that goes green and leaves the
bucket serving exactly that version, with no manual step.

### Notes from building it

- `verify:release` runs before **anything** is published. A manifest naming a
  file that does not exist, a stale hash, or an unre-pinned updater change stops
  the run while the bucket is still untouched.
- `verify:feed` runs after the upload and reads the public URL. It is the only
  check that proves the upload worked rather than assuming it.
- Prune now lists the bucket through the R2 API instead of guessing names from
  tags. `3.1.11` and `3.1.12` were never tagged, so tag-based pruning would
  have left `3.1.12` in the bucket after `3.1.13` published.

## Phase 2 — R2 → app → install

Status: **code complete, no live update exercised yet.**

| # | Step | Where | State |
|---|---|---|---|
| 1 | One feed URL constant, overridable for local tests | `src/main/updateFeed.ts` | done |
| 2 | Installed: `electron-updater` against the generic provider | `src/main/updater.ts` | done |
| 3 | Installed: check at startup, then every 4 h | `src/main/updater.ts` | done |
| 4 | Installed: auto-download, hash check by electron-updater, silent quit-and-install | `src/main/updater.ts` | done |
| 5 | Portable: read `latest.json` | `src/main/portableUpdate.ts` | done |
| 6 | Portable: download, verify sha256 + size, delete on mismatch | `src/main/portableUpdate.ts` | done |
| 7 | Portable: batch swap after exit, cleanup on next start | `src/main/portableUpdate.ts` | done |
| 8 | Renderer sees one `update:status` stream from both paths | `src/main/*` | done |
| 9 | Live portable update `3.1.12 → 3.1.13` | manual | pending |
| 10 | Live installed (NSIS) update | manual | pending |
| 11 | Failure modes on the real feed: offline, 404, corrupt download | manual | pending |

Phase 2 is done when a published release updates both build types without a
prompt, a re-download, or a leftover file.

## Decisions already made

| Decision | Why |
|---|---|
| Bucket holds the **latest version only** | simplest state to verify; `--keep N` widens it when a rollback window is wanted |
| Binaries before manifests, never the reverse | a client must never read a manifest that names a file the bucket does not have |
| Binaries `immutable`, manifests `no-cache` | a version's bytes never change; the pointer must be revalidated or releases stay invisible |
| Feed is the only update source | the repo is private, so a GitHub release asset cannot be fetched by an installed copy |
| Portable builds re-download in full | they re-extract on every launch, so there is no stable file to delta against |
| No auto-tag on a version bump | a tag pushed by `GITHUB_TOKEN` does not trigger another workflow; it needs a PAT or `workflow_call` |

## Known limits

- `r2.dev` is Cloudflare's testing endpoint: it throttles at a few hundred
  requests/second. Fine at this scale; a custom domain removes it.
- Feed size: one version ≈ 265 MB, the free tier is 10 GB-month (~37 versions).
- Rollback needs the older version still in the bucket: `--keep N` first, then
  `withdraw.yml` repoints the manifests.

## Next action

Create the R2 API token (**My Profile → API Tokens → Create Token → Workers R2
Storage: Edit**), then dispatch `release.yml` for `v3.1.13` and watch
`verify:feed` go green. That closes phase 1 and unblocks the phase 2 live test.
