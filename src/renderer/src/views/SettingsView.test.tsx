import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));

vi.mock("../hooks/useIPC", () => ({ useIPC: () => ({ call: callMock }) }));

import SettingsView from "./SettingsView";

describe("SettingsView CloseAfterLaunch", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (method: string) => {
      if (method === "get_config") return { CloseAfterLaunch: true };
      if (method === "get_profiles") return [];
      return null;
    });
  });

  it("saves the switch that closes the app after a launch", async () => {
    render(<SettingsView />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("get_config"));

    const toggle = await screen.findByRole("switch", { name: /close after launch/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(callMock).toHaveBeenCalledWith("set_config", { key: "CloseAfterLaunch", value: false });
  });
});

describe("SettingsView interface sounds", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (method: string) => {
      if (method === "get_config") return {};
      if (method === "get_profiles") return [];
      return null;
    });
  });

  afterEach(() => {
    localStorage.removeItem("rs_sfx");
  });

  it("saves the sound preference the effects read from", async () => {
    render(<SettingsView />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("get_config"));
    const toggle = screen.getByRole("switch", { name: /interface sounds/i });
    const wasOn = toggle.getAttribute("aria-checked") === "true";

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-checked")).toBe(String(!wasOn));
    expect(localStorage.getItem("rs_sfx")).toBe(wasOn ? "off" : "on");
  });
});
