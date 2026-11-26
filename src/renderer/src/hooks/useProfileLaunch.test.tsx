import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

/**
 * A double-click used to send two `launch_profile` requests: both click
 * handlers read the same "idle" state before React re-rendered, and the second
 * request killed the Riot Client the first one had just started. The hook now
 * has a synchronous in-flight ref so only one request leaves the renderer.
 */

const { callMock, onEventMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  onEventMock: vi.fn(),
}));

vi.mock("./useIPC", () => ({
  useIPC: () => ({ call: callMock, onEvent: onEventMock }),
}));

import { useProfileLaunch, type LaunchResult } from "./useProfileLaunch";

describe("useProfileLaunch", () => {
  beforeEach(() => {
    callMock.mockReset();
    onEventMock.mockReset();
    onEventMock.mockReturnValue(() => undefined);
  });

  it("sends one launch when invoked twice in the same tick", async () => {
    let resolveCall: (value: LaunchResult) => void = () => undefined;
    callMock.mockReturnValue(
      new Promise<LaunchResult>((resolve) => {
        resolveCall = resolve;
      }),
    );
    let launchFn: ((name: string) => Promise<LaunchResult | undefined>) | null = null;

    function Probe() {
      const { launch, launchState } = useProfileLaunch();
      launchFn = launch;
      return <span data-testid="state">{launchState}</span>;
    }

    render(<Probe />);
    await act(async () => {
      void launchFn!("Alpha#EUW");
      void launchFn!("Alpha#EUW");
    });

    expect(callMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCall({ ok: false, error: "stop" });
    });
    cleanup();
  });

  it("clears the loading state when the backend already has the launch", async () => {
    callMock.mockResolvedValue({ ok: true, skipped: true, code: "launch_pending" });
    let launchFn: ((name: string) => Promise<LaunchResult | undefined>) | null = null;

    function Probe() {
      const { launch, launchState } = useProfileLaunch();
      launchFn = launch;
      return <span data-testid="state">{launchState}</span>;
    }

    render(<Probe />);
    await act(async () => {
      await launchFn!("Alpha#EUW");
    });

    expect(screen.getByTestId("state").textContent).toBe("idle");
    expect(callMock).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
