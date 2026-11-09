import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";

/**
 * Regression: when the detector reported `created`, the modal set `active`
 * false while its own phase was still "opening", so the start-detection effect
 * fired again: the Riot Client was killed and reopened right after the profile
 * was saved, and the success screen was replaced by "Opening Riot Client".
 */

const { callMock, onEventMock, handlers } = vi.hoisted(() => ({
  callMock: vi.fn(),
  onEventMock: vi.fn(),
  handlers: new Map<string, Set<(params: unknown) => void>>(),
}));

vi.mock("../hooks/useIPC", () => ({
  useIPC: () => ({
    call: callMock,
    onEvent: onEventMock,
  }),
}));

import AddAccountModal from "./AddAccountModal";

function emit(event: string, payload: unknown) {
  handlers.get(event)?.forEach((cb) => cb(payload));
}

describe("AddAccountModal detection lifecycle", () => {
  beforeEach(() => {
    callMock.mockReset();
    handlers.clear();
    onEventMock.mockReset();
    onEventMock.mockImplementation((event: string, cb: (params: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(cb);
      return () => {
        handlers.get(event)?.delete(cb);
      };
    });
    callMock.mockImplementation(async (method: string) => {
      if (method === "account_detection_state") return false;
      if (method === "capture_current_account") {
        return { added: false, reason: "no_session", display: "" };
      }
      if (method === "start_account_detection") return true;
      return null;
    });
  });

  it("does not reopen the Riot Client after the profile is created", async () => {
    render(<AddAccountModal open onClose={vi.fn()} onAccountAdded={vi.fn()} />);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("start_account_detection", { auto_save: true }));
    expect(callMock.mock.calls.filter(([m]) => m === "start_account_detection")).toHaveLength(1);

    await act(async () => {
      emit("account_detection_progress", {
        status: "created",
        message: "Profile created!",
        profile_name: "Fresh#NA1",
      });
    });

    expect(await screen.findByText("Account added")).toBeDefined();

    // Let the effects flushed by the "created" state settle: a second start
    // here is the bug that killed and relaunched the client.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(callMock.mock.calls.filter(([m]) => m === "start_account_detection")).toHaveLength(1);
    expect(screen.getByText("Account added")).toBeDefined();
  });

  it("retries detection after an error", async () => {
    render(<AddAccountModal open onClose={vi.fn()} onAccountAdded={vi.fn()} />);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("start_account_detection", { auto_save: true }));

    await act(async () => {
      emit("account_detection_progress", {
        status: "error",
        message: "Fresh#NA1 is already added.",
      });
    });

    expect(await screen.findByText("Something went wrong")).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    await waitFor(() =>
      expect(callMock.mock.calls.filter(([m]) => m === "start_account_detection")).toHaveLength(2)
    );
  });

  it("clears the finished run so reopening starts a new attempt", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<AddAccountModal open onClose={onClose} onAccountAdded={vi.fn()} />);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("start_account_detection", { auto_save: true }));

    await act(async () => {
      emit("account_detection_progress", {
        status: "created",
        message: "Profile created!",
        profile_name: "Fresh#NA1",
      });
    });

    expect(await screen.findByText("Account added")).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(onClose).toHaveBeenCalled();

    // Reopen: the previous run's "created" progress must not leak through as a
    // fake success screen while a fresh detection starts behind it.
    rerender(<AddAccountModal open={false} onClose={onClose} onAccountAdded={vi.fn()} />);
    rerender(<AddAccountModal open onClose={onClose} onAccountAdded={vi.fn()} />);

    expect(await screen.findByText("Checking for a signed-in account…")).toBeDefined();
    expect(screen.queryByText("Account added")).toBeNull();

    await waitFor(() =>
      expect(callMock.mock.calls.filter(([m]) => m === "start_account_detection")).toHaveLength(2)
    );
  });
});
