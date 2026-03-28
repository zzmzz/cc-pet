import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWindow } from "./ChatWindow";
import { useAppStore } from "@/lib/store";
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

vi.mock("@/lib/commands", () => ({
  sendMessage: vi.fn(async () => {}),
  sendFile: vi.fn(async () => {}),
  clearHistory: vi.fn(async () => {}),
  revealFile: vi.fn(async () => {}),
  connectBridge: vi.fn(async () => {}),
  disconnectBridge: vi.fn(async () => {}),
}));

const initialState = useAppStore.getState();

describe("ChatWindow", () => {
  beforeEach(() => {
    vi.mocked(commands.sendMessage).mockClear();
    useAppStore.setState(initialState, true);
    useAppStore.setState({ chatOpen: true, connected: true, messages: [] });
  });

  it("sends input text via sendMessage", async () => {
    const user = userEvent.setup();
    render(<ChatWindow />);

    const input = screen.getByPlaceholderText("输入消息，Enter 发送，Shift+Enter 换行");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(commands.sendMessage).toHaveBeenCalledWith("hello");
    expect(useAppStore.getState().messages[0]?.content).toBe("hello");
  });
});
