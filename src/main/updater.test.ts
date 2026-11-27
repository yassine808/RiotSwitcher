// @vitest-environment node
// Main-process code. Running it under jsdom would load a DOM implementation
// these tests never touch, and couples them to jsdom's release cadence.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression tests for the updater wiring.
 *
 * Original bug: `update-downloaded` offered "Restart Now" and the renderer
 * could separately fire the `update:install` IPC. Both paths called
 * `autoUpdater.quitAndInstall()` unguarded, so two installers could race on
 * the same process. The fix funnels both through a single `installOnce()`
 * latch. A downloaded update now installs itself; the IPC route stays for the
 * manual button.
 *
 * The last group pins the "always check" behaviour: packaged builds check on
 * start and then on a timer, dev builds never touch the network.
 */
function mockModules(isPackaged: boolean) {
  const checkForUpdates = vi.fn(async () => undefined);
  const setFeedURL = vi.fn();
  const quit = vi.fn();
  const showMessageBox = vi.fn(async (..._args: unknown[]) => ({ response: 0 }));
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const autoUpdater = {
    logger: null,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    checkForUpdates,
    setFeedURL,
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: quitAndInstallMock,
  };
  vi.doMock("electron-updater", () => ({ autoUpdater }));
  vi.doMock("electron", () => ({
    app: { isPackaged, quit },
    BrowserWindow: class {},
    dialog: { showMessageBox },
  }));
  vi.doMock("electron-log", () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }));
  return { autoUpdater, checkForUpdates, setFeedURL, handlers, quit, showMessageBox };
}

let quitAndInstallMock: ReturnType<typeof vi.fn>;

describe("quitAndInstall re-entrancy", () => {
  beforeEach(() => {
    vi.resetModules();
    quitAndInstallMock = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes quitAndInstall exactly once even when called repeatedly", async () => {
    mockModules(true);

    const mod = await import("./updater");
    mod.quitAndInstall();
    mod.quitAndInstall();
    mod.quitAndInstall();

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("still performs a single install when called once", async () => {
    mockModules(true);

    const mod = await import("./updater");
    mod.quitAndInstall();
    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it("installs silently and reopens the app", async () => {
    mockModules(true);

    const mod = await import("./updater");
    mod.quitAndInstall();

    expect(quitAndInstallMock).toHaveBeenCalledWith(true, true);
  });
});

describe("automatic install", () => {
  beforeEach(() => {
    vi.resetModules();
    quitAndInstallMock = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts into a downloaded update without waiting for a click", async () => {
    vi.useFakeTimers();
    const { handlers } = mockModules(true);

    const mod = await import("./updater");
    mod.initAutoUpdater();
    const downloaded = handlers.get("update-downloaded");
    expect(downloaded).toBeTypeOf("function");

    downloaded!({ version: "9.9.9" });
    expect(quitAndInstallMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
    expect(quitAndInstallMock).toHaveBeenCalledWith(true, true);
  });
});

describe("failed updates close the app", () => {
  beforeEach(() => {
    vi.resetModules();
    quitAndInstallMock = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the failing step, shows it, then quits", async () => {
    vi.useFakeTimers();
    const { handlers, quit, showMessageBox } = mockModules(true);

    const mod = await import("./updater");
    mod.initAutoUpdater();
    handlers.get("error")!(new Error("update feed returned HTTP 500"));

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const options = showMessageBox.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.message).toBe("Update check failed");
    expect(options.detail).toContain("HTTP 500");
    expect(quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10000);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("reports a download failure as the download step", async () => {
    const { handlers, showMessageBox } = mockModules(true);

    const mod = await import("./updater");
    mod.initAutoUpdater();
    handlers.get("update-available")!({ version: "9.9.9" });
    handlers.get("error")!(new Error("sha512 mismatch"));

    const options = showMessageBox.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.message).toBe("Update download failed");
    expect(options.detail).toContain("sha512 mismatch");
  });

  it("shows one message even when both the promise and the event fail", async () => {
    vi.useFakeTimers();
    const { checkForUpdates, handlers, showMessageBox } = mockModules(true);
    checkForUpdates.mockRejectedValueOnce(new Error("offline"));

    const mod = await import("./updater");
    mod.initAutoUpdater();
    await vi.advanceTimersByTimeAsync(5000);
    handlers.get("error")!(new Error("offline"));

    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe("update checks", () => {
  beforeEach(() => {
    vi.resetModules();
    quitAndInstallMock = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never queries GitHub from a development build", async () => {
    vi.useFakeTimers();
    const { checkForUpdates } = mockModules(false);

    const mod = await import("./updater");
    mod.initAutoUpdater();
    mod.checkForUpdates();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("checks on startup and again on the four-hour timer", async () => {
    vi.useFakeTimers();
    const { checkForUpdates } = mockModules(true);

    const mod = await import("./updater");
    mod.initAutoUpdater();

    expect(checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it("reads the newest GitHub release, not a CDN", async () => {
    const { setFeedURL } = mockModules(true);

    const mod = await import("./updater");
    mod.initAutoUpdater();

    expect(setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/yassine808/RiotSwitcher/releases/latest/download",
    });
  });

  // The full installer is the one update path that must always work; the
  // differential path is deliberately off even though the blockmap is published.
  it("skips the differential download", async () => {
    const { autoUpdater } = mockModules(true);

    await import("./updater");

    expect(autoUpdater.disableDifferentialDownload).toBe(true);
  });
});
