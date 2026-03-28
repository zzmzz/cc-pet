import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings";
import { useAppStore } from "@/lib/store";
import type { AppConfig, BridgeConfig } from "@/lib/types";
import * as commands from "@/lib/commands";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.2.0"),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging: vi.fn(async () => {}),
  })),
}));

vi.mock("@/lib/manualUpdateCheck", () => ({
  runManualUpdateCheckWithDialogs: vi.fn(async () => {}),
}));

vi.mock("@/lib/commands", () => ({
  connectBridge: vi.fn(async () => {}),
  disconnectBridge: vi.fn(async () => {}),
  saveConfig: vi.fn(async () => {}),
  setAlwaysOnTop: vi.fn(async () => {}),
  setWindowOpacity: vi.fn(async () => {}),
}));

const baseConfig: AppConfig = {
  bridges: [
    {
      id: "conn-1",
      name: "conn1",
      host: "127.0.0.1",
      port: 9810,
      token: "token",
      platformName: "desktop-pet",
      userId: "pet-user",
    },
  ],
  pet: {
    size: 120,
    alwaysOnTop: true,
    chatWindowOpacity: 0.95,
    chatWindowWidth: 480,
    chatWindowHeight: 640,
    appearance: {},
  },
  llm: {
    apiUrl: "",
    apiKey: "",
    model: "",
    enabled: false,
  },
};

const initialState = useAppStore.getState();

describe("Settings", () => {
  beforeEach(() => {
    vi.mocked(commands.saveConfig).mockClear();
    vi.mocked(commands.setAlwaysOnTop).mockClear();
    vi.mocked(commands.setWindowOpacity).mockClear();
    vi.mocked(commands.disconnectBridge).mockClear();
    vi.mocked(commands.connectBridge).mockClear();

    useAppStore.setState(initialState, true);
    useAppStore.setState({
      settingsOpen: true,
      config: baseConfig,
    });
  });

  it("saves form and applies side effects", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const tokenInput = screen.getByDisplayValue("token");
    await user.clear(tokenInput);
    await user.type(tokenInput, "new-token");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(commands.saveConfig).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(commands.saveConfig).mock.calls[0][0] as AppConfig;
    expect(saved.bridges[0].token).toBe("new-token");
    expect(commands.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(commands.setWindowOpacity).toHaveBeenCalledWith(0.95);
    expect(commands.connectBridge).toHaveBeenCalled();
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });

  it("adds a new bridge even when randomUUID is unavailable", async () => {
    const user = userEvent.setup();
    const originalRandomUUID = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      render(<Settings />);
      await user.click(screen.getAllByRole("button", { name: "+ 添加连接" })[0]);
      await user.click(screen.getAllByRole("button", { name: "保存" })[0]);

      const saved = vi.mocked(commands.saveConfig).mock.calls[0][0] as AppConfig;
      expect(saved.bridges).toHaveLength(2);
      const created = saved.bridges[1] as BridgeConfig;
      expect(created.id).toMatch(/^bridge-/);
      expect(created.host).toBe("127.0.0.1");
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: originalRandomUUID,
      });
    }
  });
});
