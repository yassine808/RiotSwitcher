/**
 * CloseAfterLaunch: hide the window after a profile launch and quit once the
 * backend says the launch no longer needs the app.
 *
 * The quit cannot happen when `launch_profile` returns: the product watchdog
 * that asks the Riot Client to start VALORANT runs on a thread in the Python
 * backend, and killing that process would cancel the game start. The backend
 * emits `launch_armed` from the watchdog instead, and this waits for it.
 */

// The backend's watchdog gives up after 150 s (riot_client.PRODUCT_LAUNCH_TIMEOUT_S)
// and arms the launch on every exit, so this only fires when the backend itself
// stops answering. Without it a dead backend would leave a hidden, unreachable
// window running forever.
export const ARM_TIMEOUT_MS = 160_000;

/** `launch_profile` answered with a launch that actually ran. */
export function isCompletedLaunch(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const res = result as { ok?: unknown; skipped?: unknown };
  return res.ok === true && res.skipped !== true;
}

/** The stored setting is on. Only a real `true` counts; a string is not a yes. */
export function closeAfterLaunchEnabled(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  return (config as Record<string, unknown>).CloseAfterLaunch === true;
}

export interface CloseAfterLaunchHooks {
  /** Take the window off screen now. */
  hide: () => void;
  /** The window is still on screen (the user brought it back). */
  isVisible: () => boolean;
  quit: () => void;
  timeoutMs?: number;
}

export interface CloseAfterLaunch {
  /** Call before forwarding a launch request, so the next arm starts clean. */
  reset: () => void;
  /** A launch succeeded: hide now, quit when `launchArmed` arrives. */
  arm: () => void;
  /** The backend no longer needs this process for the current launch. */
  launchArmed: () => void;
  cancel: () => void;
}

export function createCloseAfterLaunch(hooks: CloseAfterLaunchHooks): CloseAfterLaunch {
  let armed = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const finish = () => {
    armed = false;
    clearTimer();
    hooks.quit();
  };

  return {
    reset() {
      settled = false;
    },
    arm() {
      if (armed) return;
      armed = true;
      // The backend can arm before the config round trip that leads here (a
      // client-only launch has nothing to wait for). Do not hide a window that
      // is about to disappear.
      if (settled) {
        finish();
        return;
      }
      hooks.hide();
      timer = setTimeout(finish, hooks.timeoutMs ?? ARM_TIMEOUT_MS);
      timer.unref?.();
    },
    launchArmed() {
      settled = true;
      if (!armed) return;
      // Shown again between the launch and the arm: the user wants the app
      // back, so closing it now would fight them.
      if (hooks.isVisible()) {
        armed = false;
        clearTimer();
        return;
      }
      finish();
    },
    cancel() {
      armed = false;
      settled = false;
      clearTimer();
    },
  };
}
