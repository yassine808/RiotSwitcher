/**
 * Self-update for the portable build.
 *
 * electron-updater drives the NSIS installer, which a portable copy does not
 * have: it runs from a temporary extraction and quits without installing
 * anything. The portable build therefore updates itself: fetch the release
 * manifest from the update feed, download the new portable exe, swap it in
 * place of the running one and start it again.
 *
 * The swap cannot be done from inside the app: the portable stub is the file
 * being replaced and Windows keeps a running executable open, so a rename
 * fails until that process is gone. A short batch script waits for this
 * process to exit, renames the old exe, drops the new one in its place and
 * starts it. The script is written next to the exe because only that folder
 * can be written to without elevation, and its leftovers are removed on the
 * next start.
 *
 * `updater.ts` stays separate (it is pinned by CI); this module emits the same
 * `update:status` events so the renderer needs no changes.
 */

import { BrowserWindow, app, dialog, net } from "electron";
import log from "electron-log";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import { UPDATE_FEED_URL } from "./updateFeed";

// Same cadence as the installed build: once at startup, then every four hours.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 5000;
// The downloaded file is verified before this delay starts, so it only gives
// the renderer time to show "restarting soon".
const INSTALL_DELAY_MS = 3000;
// A failure message stays up this long before the process closes. An ignored
// dialog must not keep a copy that cannot update itself running.
const FAILURE_EXIT_MS = 10000;

interface FeedFile {
  url: string;
  sha256?: string;
  size?: number;
}

interface Feed {
  version: string;
  files?: { portable?: FeedFile };
}

let updateWindow: BrowserWindow | null = null;
let checkTimer: NodeJS.Timeout | null = null;
let downloadedPath: string | null = null;
let checking = false;
let installing = false;
// One failure, one message, one exit.
let failedStep: string | null = null;

/** True when this process is the portable build's extracted app. */
export function isPortableBuild(): boolean {
  return app.isPackaged && Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

/** The portable exe the user actually launched, or null when it is gone. */
function portableExe(): string | null {
  const path = process.env.PORTABLE_EXECUTABLE_FILE;
  return path && existsSync(path) ? path : null;
}

function send(payload: Record<string, unknown>): void {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send("update:status", payload);
  }
}

/**
 * Reports a failed update and closes the app.
 *
 * Same rule as the installed build: say which step failed and why, then stop.
 * A portable copy that cannot fetch or replace its exe must not keep running.
 */
function failUpdate(step: string, error: unknown): void {
  if (failedStep) return;
  failedStep = step;
  const detail = error instanceof Error ? error.message : String(error);
  log.error(`${step} failed:`, error);
  send({ state: "error", step, message: detail });

  const options = {
    type: "error" as const,
    title: "RiotSwitcher update failed",
    message: `${step} failed`,
    detail: `${detail}\n\nRiotSwitcher will close now.`,
    buttons: ["Close"],
    noLink: true,
  };
  const win = updateWindow && !updateWindow.isDestroyed() ? updateWindow : null;
  const shown = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  const wait = new Promise<void>((resolve) => setTimeout(resolve, FAILURE_EXIT_MS));
  void Promise.race([shown.catch(() => undefined), wait]).then(() => app.quit());
}

/** Numeric comparison of dotted versions, ignoring a leading `v`. */
function compareVersions(a: string, b: string): number {
  const left = a
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = b
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchFeed(): Promise<Feed> {
  // The manifest must never be served from a cache: a stale copy would hide a
  // release, and a fresh one would announce a file the CDN has not got yet.
  const response = await net.fetch(`${UPDATE_FEED_URL}/latest.json?t=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`update feed returned HTTP ${response.status}`);
  }
  return (await response.json()) as Feed;
}

async function download(file: FeedFile, version: string): Promise<string> {
  const dir = join(app.getPath("userData"), "updates");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `RiotSwitcher-${version}-portable.exe`);
  rmSync(target, { force: true });

  const response = await net.fetch(file.url, { cache: "no-store" });
  if (!response.ok || !response.body) {
    throw new Error(`download returned HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? file.size ?? 0);
  const hash = createHash("sha256");
  let received = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      if (total > 0) {
        send({
          state: "downloading",
          version,
          percent: Math.min(100, Math.round((received / total) * 100)),
          transferred: received,
          total,
        });
      }
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
    meter,
    createWriteStream(target),
  );

  const digest = hash.digest("hex");
  if (file.sha256 && digest !== file.sha256.toLowerCase()) {
    rmSync(target, { force: true });
    throw new Error("downloaded file failed its checksum");
  }
  if (file.size && statSync(target).size !== file.size) {
    rmSync(target, { force: true });
    throw new Error("downloaded file has the wrong size");
  }
  return target;
}

// 120 tries, one ping apart: a couple of minutes for this process to release
// the exe before the swap gives up and says so.
const SWAP_TRIES = 120;

/**
 * Batch script that performs the swap once this process is gone.
 *
 * The wait is the rename itself: Windows refuses the move while the exe is
 * open, so retrying it is both the wait and the test. Nothing here may read
 * stdin -- a detached silent script can inherit a stdin that never reaches
 * EOF, which is what hung an earlier `tasklist | find` version of this loop.
 * `ping` is the delay for the same reason `timeout` is unusable: it refuses to
 * run when stdin is redirected.
 *
 * If the swap fails the old exe is started again with a marker file next to
 * it, so the app can report the failure and close instead of silently running
 * the old version.
 */
export function swapScript(exe: string, next: string): string {
  return [
    "@echo off",
    "setlocal",
    `set "EXE=${exe}"`,
    `set "NEW=${next}"`,
    "set /a TRIES=0",
    ":rename",
    'move /y "%EXE%" "%EXE%.old" >nul 2>&1',
    'if not exist "%EXE%" goto swap',
    "set /a TRIES+=1",
    `if %TRIES% geq ${SWAP_TRIES} goto giveup`,
    "ping -n 2 127.0.0.1 >nul",
    "goto rename",
    ":swap",
    'move /y "%NEW%" "%EXE%" >nul 2>&1',
    'if not exist "%EXE%" goto giveup',
    "ping -n 3 127.0.0.1 >nul",
    // Through explorer, not `start`: the updater spawns this script hidden, and
    // `start` passes that hidden show state on, so the app would come back with
    // no window. explorer always starts it normally.
    'start "" explorer.exe "%EXE%"',
    "ping -n 3 127.0.0.1 >nul",
    'del "%EXE%.old" >nul 2>&1',
    // A batch file cannot delete itself and still exit cleanly: cmd drops the
    // file handle and the exit status becomes 1. Hand the delete to a helper.
    'start /b cmd /c "ping -n 5 127.0.0.1 >nul & del ""%~f0"""',
    "exit /b 0",
    ":giveup",
    'move /y "%EXE%.old" "%EXE%" >nul 2>&1',
    `> "%EXE%.update-failed" echo Could not replace the portable exe: it stayed locked for about two minutes.`,
    "ping -n 3 127.0.0.1 >nul",
    'start "" explorer.exe "%EXE%"',
    "ping -n 3 127.0.0.1 >nul",
    'start /b cmd /c "ping -n 5 127.0.0.1 >nul & del ""%~f0"""',
    "exit /b 1",
    "",
  ].join("\r\n");
}

/** Replace the running exe with the downloaded one and start it again. */
export function installPortableUpdate(): void {
  if (installing) return;
  installing = true;
  const exe = portableExe();
  if (!exe || !downloadedPath) {
    installing = false;
    return;
  }

  const next = `${exe}.new`;
  const script = `${exe}.update.cmd`;
  try {
    rmSync(next, { force: true });
    // Copy rather than move so a half-copied file is never named like a
    // working exe if this process dies mid-way.
    copyFileSync(downloadedPath, next);
    writeFileSync(script, swapScript(exe, next), "ascii");
  } catch (error) {
    installing = false;
    failUpdate("Update install", new Error("could not write next to the portable exe", { cause: error }));
    return;
  }

  try {
    spawn("cmd.exe", ["/d", "/c", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch (error) {
    installing = false;
    failUpdate("Update install", new Error("could not start the updater", { cause: error }));
    return;
  }

  // before-quit releases the tray interceptor and stops the backend.
  app.quit();
}

/** Remove what a previous update or an interrupted one left behind. */
function cleanupPrevious(): string | null {
  const exe = portableExe();
  if (!exe) return null;
  // The swap script writes this when it could not put the new exe in place.
  const failed = `${exe}.update-failed`;
  let failure: string | null = null;
  if (existsSync(failed)) {
    try {
      failure = readFileSync(failed, "utf8").trim() || "the portable exe could not be replaced";
    } catch {
      failure = "the portable exe could not be replaced";
    }
    rmSync(failed, { force: true });
  }
  for (const leftover of [`${exe}.new`, `${exe}.old`, `${exe}.update.cmd`]) {
    try {
      rmSync(leftover, { force: true });
    } catch (error) {
      // A file still held by the swap script is retried on the next start.
      log.warn(`Portable update cleanup skipped ${leftover}:`, error);
    }
  }
  return failure;
}

async function runCheck(): Promise<void> {
  if (checking) return;
  checking = true;
  send({ state: "checking" });
  try {
    const feed = await fetchFeed();
    if (compareVersions(feed.version, app.getVersion()) <= 0) {
      send({ state: "up-to-date" });
      return;
    }
    const portable = feed.files?.portable;
    if (!portable?.url) {
      throw new Error("the release has no portable build");
    }
    send({ state: "available", version: feed.version, releaseNotes: "" });
    downloadedPath = await download(portable, feed.version);
    send({ state: "downloaded", version: feed.version });
    setTimeout(installPortableUpdate, INSTALL_DELAY_MS).unref?.();
  } catch (error) {
    failUpdate("Update check", error);
  } finally {
    checking = false;
  }
}

export function initPortableUpdater(win: BrowserWindow): void {
  updateWindow = win;
  const failure = cleanupPrevious();
  if (failure) {
    // A failed update is never silent: say which step failed and why, then
    // close. The dialog is used instead of the renderer because Settings may
    // not be the open view, and it is read before the process ends.
    failUpdate("Update install", new Error(failure));
    return;
  }
  setTimeout(() => void runCheck(), STARTUP_CHECK_DELAY_MS).unref?.();
  checkTimer = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
  checkTimer.unref?.();
  log.info(`Portable update feed: ${UPDATE_FEED_URL}`);
}

export function checkPortableUpdates(): void {
  void runCheck();
}

export function downloadPortableUpdate(): void {
  // The check already downloads; the renderer only ever asks after it sees
  // "available", which means the download is already running.
  if (!downloadedPath) void runCheck();
}

export function quitAndInstallPortable(): void {
  installPortableUpdate();
}
