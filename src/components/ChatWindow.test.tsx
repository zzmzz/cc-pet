import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWindow } from "./ChatWindow";
import { useAppStore, makeChatKey, defaultSessionKeyFromBridge } from "@/lib/store";
import type { BridgeConfig } from "@/lib/types";
import * as commands from "@/lib/commands";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging: vi.fn(async () => {}),
  })),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

vi.mock("@/lib/manualUpdateCheck", () => ({
  runManualUpdateCheckWithDialogs: vi.fn(async () => {}),
}));

const TEST_SESSION_ID = defaultSessionKeyFromBridge({
  id: "conn-1",
  name: "Test Bridge",
  host: "127.0.0.1",
  port: 9810,
  token: "tok",
  platformName: "desktop-pet",
  userId: "pet-user",
});

vi.mock("@/lib/commands", () => ({
  sendMessage: vi.fn(async () => {}),
  sendFile: vi.fn(async () => {}),
  clearHistory: vi.fn(async () => {}),
  revealFile: vi.fn(async () => {}),
  connectBridge: vi.fn(async () => {}),
  disconnectBridge: vi.fn(async () => {}),
  listBridgeSessions: vi.fn(async () => ({
    sessions: [{ id: TEST_SESSION_ID, name: "default", historyCount: 0 }],
    activeSessionId: TEST_SESSION_ID,
  })),
  getHistory: vi.fn(async () => []),
}));

const testBridge: BridgeConfig = {
  id: "conn-1",
  name: "Test Bridge",
  host: "127.0.0.1",
  port: 9810,
  token: "tok",
  platformName: "desktop-pet",
  userId: "pet-user",
};
const SESSION = defaultSessionKeyFromBridge(testBridge);
const CHAT_KEY = makeChatKey(testBridge.id, SESSION);

const initialState = useAppStore.getState();

describe("ChatWindow", () => {
  beforeEach(() => {
    vi.mocked(commands.sendMessage).mockClear();
    useAppStore.setState(initialState, true);
    useAppStore.setState({
      chatOpen: true,
      connections: {
        [testBridge.id]: { config: testBridge, connected: true },
      },
      connected: true,
      activeConnectionId: testBridge.id,
      sessionsByConnection: { [testBridge.id]: [SESSION] },
      activeSessionByConnection: { [testBridge.id]: SESSION },
      messagesByChat: {},
    });
  });

  it("sends input text via sendMessage and adds to messagesByChat", async () => {
    const user = userEvent.setup();
    render(<ChatWindow />);

    const input = screen.getByPlaceholderText("输入消息，Enter 发送，Shift+Enter 换行");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(commands.sendMessage).toHaveBeenCalledTimes(1);
    const [connId, text, sessionKey] = vi.mocked(commands.sendMessage).mock.calls[0];
    expect(connId).toBe(testBridge.id);
    expect(text).toBe("hello");
    expect(sessionKey).toBe(SESSION);
    expect(useAppStore.getState().messagesByChat[CHAT_KEY]?.[0]?.content).toBe("hello");
  });
});
