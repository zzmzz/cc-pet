import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/types";

vi.mock("@/lib/commands", () => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => {}),
  connectBridge: vi.fn(async () => {}),
  startSshTunnel: vi.fn(async () => {}),
  getBridgeStatus: vi.fn(async () => []),
  setMainWindowSize: vi.fn(async () => {}),
  listLocalSessions: vi.fn(async () => ({ sessions: [], activeSessionId: undefined, lastActiveMap: {} })),
  getHistory: vi.fn(async () => []),
}));

import { initializeBridgeConnections } from "./App";
import { connectBridge, startSshTunnel } from "@/lib/commands";

describe("initializeBridgeConnections", () => {
  it("auto starts enabled tunnel before connecting bridge", async () => {
    const cfg: AppConfig = {
      bridges: [
        {
          id: "b1",
          name: "with tunnel",
          host: "127.0.0.1",
          port: 9810,
          token: "token-1",
          platformName: "desktop-pet",
          userId: "pet-user",
          sshTunnel: {
            enabled: true,
            bastionHost: "example.com",
            bastionPort: 22,
            bastionUser: "user",
            targetHost: "127.0.0.1",
            targetPort: 9810,
            localHost: "127.0.0.1",
            localPort: 9810,
            identityFile: "",
            strictHostKeyChecking: true,
          },
        },
        {
          id: "b2",
          name: "without token",
          host: "127.0.0.1",
          port: 9810,
          token: "  ",
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
        toggleVisibilityShortcut: "Ctrl+Shift+H",
      },
      llm: {
        apiUrl: "",
        apiKey: "",
        model: "",
        enabled: false,
      },
    };

    await initializeBridgeConnections(cfg);

    expect(startSshTunnel).toHaveBeenCalledTimes(1);
    expect(startSshTunnel).toHaveBeenCalledWith("b1", cfg.bridges[0].sshTunnel);
    expect(connectBridge).toHaveBeenCalledTimes(1);
    expect(connectBridge).toHaveBeenCalledWith("b1");
  });
});
