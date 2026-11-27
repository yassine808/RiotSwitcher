// @vitest-environment node
// Main-process constant; see the note in updater.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = process.env.RIOTSWITCHER_UPDATE_FEED;

afterEach(() => {
  vi.resetModules();
  if (ORIGINAL === undefined) {
    delete process.env.RIOTSWITCHER_UPDATE_FEED;
  } else {
    process.env.RIOTSWITCHER_UPDATE_FEED = ORIGINAL;
  }
});

describe("update feed", () => {
  // The feed is what every installed and portable copy will ask for the rest of
  // its life. Pin the exact URL: a typo here is only discovered by users whose
  // app can no longer update.
  it("points at the newest GitHub release and nothing else", async () => {
    delete process.env.RIOTSWITCHER_UPDATE_FEED;

    const mod = await import("./updateFeed");

    expect(mod.UPDATE_FEED_URL).toBe("https://github.com/yassine808/RiotSwitcher/releases/latest/download");
    expect(mod.UPDATE_FEED_URL).not.toMatch(/r2\.dev|cloudflare|pub-/i);
  });

  it("lets a local server stand in while testing an update", async () => {
    process.env.RIOTSWITCHER_UPDATE_FEED = "http://127.0.0.1:8080/";

    const mod = await import("./updateFeed");

    expect(mod.UPDATE_FEED_URL).toBe("http://127.0.0.1:8080");
  });
});
