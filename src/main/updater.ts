import { app, BrowserWindow, dialog } from "electron";
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
// How long a failure message stays up before the process closes. Long enough to
// read, short enough that an ignored dialog cannot keep a broken build running.
export const FAILURE_EXIT_MS = 10000;

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
// The failing step is remembered so one failure produces one message and one
// exit: electron-updater reports the same problem from `checkForUpdates()` and
// again through its `error` event.
let failedStep: string | null = null;

/**
 * Reports a failed update and closes the app.
 *
 * A build that cannot update itself any more must not keep running: it would
 * silently stay on the old version forever. The message is shown first, the
 * process exits when it is dismissed or after FAILURE_EXIT_MS.
 */
function failUpdate(step: string, error: unknown): void {
  if (failedStep) return;
  failedStep = step;
  const detail = error instanceof Error ? error.message : String(error);
  log.error(`${step} failed:`, error);
  sendToRenderer("update:status", { state: "error", step, message: detail });

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

/** Quit-and-install may only be initiated once per process lifetime. */
function installOnce(): void {
  if (installing) {
    return;
  }
  installing = true;
  try {
    // Silent: an update the user never had to approve should not pop an
    // installer wizard either. Force-run so the app comes back afterwards.
    autoUpdater.quitAndInstall(true, true);
  } catch (error) {
    installing = false;
    failUpdate("Update install", error);
  }
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
    // Offline, rate-limited or no release published: the build can no longer
    // prove it is current, so it says why and closes instead of pretending.
    failUpdate("Update check", err);
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

  // Which stage a later `error` belongs to. electron-updater reports every
  // failure through the same event, so the message has to name the step itself.
  let stage: "Update check" | "Update download" | "Update install" = "Update check";

  autoUpdater.on("checking-for-update", () => {
    stage = "Update check";
    sendToRenderer("update:status", { state: "checking" });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    stage = "Update download";
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
    stage = "Update download";
    sendToRenderer("update:status", {
      state: "downloading",
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    stage = "Update install";
    sendToRenderer("update:status", { state: "downloaded", version: info.version });
    // No prompt: the file is downloaded and hash-verified, so restart into it.
    // The delay only gives the renderer time to show "restarting soon".
    setTimeout(installOnce, AUTO_INSTALL_DELAY_MS).unref?.();
  });

  autoUpdater.on("error", (err) => {
    failUpdate(stage, err);
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
  autoUpdater.downloadUpdate().catch((err) => failUpdate("Update download", err));
}

export function quitAndInstall(): void {
  installOnce();
}
