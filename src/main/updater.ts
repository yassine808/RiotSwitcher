import { app, BrowserWindow } from "electron";
import { autoUpdater, UpdateInfo } from "electron-updater";
import log from "electron-log";

import { UPDATE_FEED_URL } from "./updateFeed";

// Re-check every four hours so a long-running session still picks up a release
// published after the app was opened. Startup does the first check.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 5000;
// A downloaded update restarts the app on its own. The short pause lets the
// renderer paint its "restarting" state instead of the window vanishing first.
const AUTO_INSTALL_DELAY_MS = 3000;

autoUpdater.logger = log;
// Download and install without asking: the update applies on its own as soon
// as it has been downloaded and verified. The renderer only reports progress.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.autoRunAppAfterInstall = true;
autoUpdater.allowDowngrade = false;

let updateWindow: BrowserWindow | null = null;
let installing = false;
let checkTimer: NodeJS.Timeout | null = null;

/** Quit-and-install may only be initiated once per process lifetime. */
function installOnce(): void {
  if (installing) {
    return;
  }
  installing = true;
  // Silent: an update the user never had to approve should not pop an
  // installer wizard either. Force-run so the app comes back afterwards.
  autoUpdater.quitAndInstall(true, true);
}

export function setUpdateWindow(win: BrowserWindow): void {
  updateWindow = win;
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send(channel, ...args);
  }
}

function runCheck(): void {
  autoUpdater.checkForUpdates().catch((err) => {
    // Offline, rate-limited, or no release published yet — all non-fatal.
    log.warn("Update check failed:", err?.message ?? err);
  });
}

export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    // electron-updater needs the generated app-update.yml and an installed
    // build; in dev it would only log errors on every check.
    log.info("Auto-updater disabled outside a packaged build");
    return;
  }

  // Release assets on GitHub need a token once the repository is private, and
  // an installed copy has none, so the feed is the public bucket. Setting it
  // here overrides the `publish` block baked into app-update.yml and keeps the
  // URL in one place, shared with the portable updater.
  autoUpdater.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });
  log.info(`Update feed: ${UPDATE_FEED_URL}`);

  autoUpdater.on("checking-for-update", () => {
    sendToRenderer("update:status", { state: "checking" });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    sendToRenderer("update:status", {
      state: "available",
      version: info.version,
      releaseNotes: info.releaseNotes ?? "",
    });
  });

  autoUpdater.on("update-not-available", () => {
    sendToRenderer("update:status", { state: "up-to-date" });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendToRenderer("update:status", {
      state: "downloading",
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    sendToRenderer("update:status", { state: "downloaded", version: info.version });
    // No prompt: the file is downloaded and hash-verified, so restart into it.
    // The delay only gives the renderer time to show "restarting soon".
    setTimeout(installOnce, AUTO_INSTALL_DELAY_MS).unref?.();
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-updater error:", err);
    sendToRenderer("update:status", { state: "error", message: err.message });
  });

  // First check shortly after the window is up, then on a fixed interval.
  setTimeout(runCheck, STARTUP_CHECK_DELAY_MS);
  checkTimer = setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS);
  checkTimer.unref?.();
}

export function checkForUpdates(): void {
  if (!app.isPackaged) {
    sendToRenderer("update:status", { state: "up-to-date" });
    return;
  }
  runCheck();
}

export function downloadUpdate(): void {
  autoUpdater.downloadUpdate().catch(() => {});
}

export function quitAndInstall(): void {
  installOnce();
}
