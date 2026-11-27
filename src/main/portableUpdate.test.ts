// @vitest-environment node
// Main-process helpers; see the note in updater.test.ts.
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => tmpdir(), quit: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 0 })) },
  net: { fetch: vi.fn() },
  BrowserWindow: class {},
}));

import { manifestUrl, swapScript } from "./portableUpdate";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "riotswitcher-swap-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("portable update feed", () => {
  // The portable build cannot use electron-updater, so this manifest is its
  // only update source. It must resolve from the same public release as the
  // installed build.
  it("reads latest.json from the newest GitHub release", () => {
    expect(manifestUrl()).toBe("https://github.com/yassine808/RiotSwitcher/releases/latest/download/latest.json");
  });
});

describe("portable swap script", () => {
  // The first version polled `tasklist | find` and hung forever: the detached
  // script inherits a stdin that never reaches EOF, so any command that reads
  // stdin blocks. Nothing in the script may do that.
  it("never reads stdin", () => {
    const script = swapScript("C:\\a\\app.exe", "C:\\a\\app.exe.new");
    expect(script).not.toMatch(/tasklist|findstr|\bfind\b|\bmore\b|\bset \/p\b/);
  });

  it("gives up after a bounded number of tries and leaves a marker", () => {
    const script = swapScript("C:\\a\\app.exe", "C:\\a\\app.exe.new");
    expect(script).toMatch(/if %TRIES% geq 120 goto giveup/);
    expect(script).toContain('"%EXE%.update-failed"');
  });

  // The script waits with `ping` between attempts, so a slow CI runner can take
  // longer than vitest's 5 s default. The script caps itself at 30 s.
  it.skipIf(process.platform !== "win32")("swaps the exe and starts it again", { timeout: 60_000 }, () => {
    const dir = scratch();
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    // Real exes, not .cmd files: `start` on a .cmd keeps a console open
    // forever, and the test would hang on that instead of on the script.
    const exe = join(dir, "app.exe");
    const next = `${exe}.new`;
    const script = `${exe}.update.cmd`;
    copyFileSync(join(system32, "where.exe"), exe);
    copyFileSync(join(system32, "whoami.exe"), next);
    const nextSize = statSync(next).size;
    writeFileSync(script, swapScript(exe, next), "ascii");

    // A hang here is the bug this test exists for, so cap the run. stdio is
    // ignored so the relaunched app cannot hold the pipe open.
    const run = spawnSync("cmd.exe", ["/d", "/c", script], {
      timeout: 30_000,
      windowsHide: true,
      stdio: "ignore",
    });

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(statSync(exe).size).toBe(nextSize);
    expect(existsSync(`${exe}.old`)).toBe(false);
    expect(existsSync(`${exe}.update-failed`)).toBe(false);
  });

  // Deferred so the exit status stays 0; cleanupPrevious() also removes it on
  // the next start if the helper never runs.
  it("hands its own removal to a helper", () => {
    expect(swapScript("C:\\a\\app.exe", "C:\\a\\app.exe.new")).toContain('del ""%~f0"""');
  });

  // The script is spawned hidden, and `start` passes that show state on, so a
  // bare `start "" "%EXE%"` brings the app back with no window.
  it("relaunches the app through explorer", () => {
    expect(swapScript("C:\\a\\app.exe", "C:\\a\\app.exe.new")).toContain('start "" explorer.exe "%EXE%"');
  });
});
