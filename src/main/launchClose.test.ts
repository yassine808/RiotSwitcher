// @vitest-environment node
// Main-process helper; see the note in shortcuts.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { ARM_TIMEOUT_MS, closeAfterLaunchEnabled, createCloseAfterLaunch, isCompletedLaunch } from "./launchClose";

function harness() {
  const quit = vi.fn();
  const close = createCloseAfterLaunch({ quit, timeoutMs: 1000 });
  return { close, quit };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CloseAfterLaunch decisions", () => {
  it("only counts a launch that actually ran", () => {
    expect(isCompletedLaunch({ ok: true, pid: 1 })).toBe(true);
    expect(isCompletedLaunch({ ok: true, skipped: true, code: "launch_pending" })).toBe(false);
    expect(isCompletedLaunch({ ok: false, error: "no session" })).toBe(false);
    expect(isCompletedLaunch(undefined)).toBe(false);
    expect(isCompletedLaunch(null)).toBe(false);
    expect(isCompletedLaunch("ok")).toBe(false);
  });

  it("reads only a stored boolean true", () => {
    expect(closeAfterLaunchEnabled({ CloseAfterLaunch: true })).toBe(true);
    expect(closeAfterLaunchEnabled({ CloseAfterLaunch: "true" })).toBe(false);
    expect(closeAfterLaunchEnabled({ CloseAfterLaunch: 1 })).toBe(false);
    expect(closeAfterLaunchEnabled({})).toBe(false);
    expect(closeAfterLaunchEnabled(null)).toBe(false);
  });
});

describe("closing after a launch", () => {
  it("quits once the backend no longer needs the process", () => {
    const { close, quit } = harness();
    close.reset();
    close.arm();

    // The product watchdog is still running: exiting now would cancel it.
    expect(quit).not.toHaveBeenCalled();

    close.launchArmed();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("quits at once when the backend armed before the config read", () => {
    // A client-only launch arms before the config round trip that calls arm().
    const { close, quit } = harness();
    close.reset();
    close.launchArmed();
    close.arm();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("stays open when no launch succeeded", () => {
    const { close, quit } = harness();
    close.launchArmed();
    expect(quit).not.toHaveBeenCalled();
  });

  it("quits when the backend never arms", () => {
    vi.useFakeTimers();
    const { close, quit } = harness();
    close.reset();
    close.arm();

    vi.advanceTimersByTime(999);
    expect(quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending quit", () => {
    vi.useFakeTimers();
    const { close, quit } = harness();
    close.reset();
    close.arm();
    close.cancel();

    vi.advanceTimersByTime(5000);
    close.launchArmed();
    expect(quit).not.toHaveBeenCalled();
  });

  it("never quits twice for one launch", () => {
    const { close, quit } = harness();
    close.reset();
    close.arm();
    close.launchArmed();
    close.launchArmed();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("waits longer than the backend product watchdog", () => {
    // riot_client.PRODUCT_LAUNCH_TIMEOUT_S is 150 s; a shorter fallback would
    // quit before the watchdog gets its last chance to start the game.
    expect(ARM_TIMEOUT_MS).toBeGreaterThan(150_000);
  });
});
