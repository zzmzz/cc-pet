import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
  fetchLinkPreview: vi.fn(async (_url: string) => {
    if (_url.includes("/d/f664")) {
      return {
        url: _url,
        finalUrl: "https://download.example.com/files/report-2026-03.pdf",
        title: "report-2026-03.pdf",
        description: "",
        siteName: "download.example.com",
        isFile: true,
        fileName: "report-2026-03.pdf",
      };
    }
    if (_url.includes("/g/72b6")) {
      throw new Error("preview blocked");
    }
    if (_url.includes("/h/ae4b")) {
      throw new Error("preview blocked");
    }
    return {
      url: _url,
      finalUrl: "https://github.com/zzmzz/cc-pet",
      title: "GitHub - zzmzz/cc-pet",
      description: "CC Pet repository",
      siteName: "GitHub",
      isFile: false,
    };
  }),
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
  afterEach(() => {
    cleanup();
  });

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

  it("renders bot markdown links as preview cards", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-1",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "查看这个链接：[OpenAI](https://openai.com/research)",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    const link = screen.getByRole("link", { name: /openai/i });
    expect(link).toHaveClass("link-preview-card");
    expect(link).toHaveAttribute("href", "https://openai.com/research");
    expect(link.textContent).toContain("openai.com");
  });

  it("marks file links as downloadable cards", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-2",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "下载文件：[Installer](https://example.com/releases/app-v1.2.3.zip)",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    const fileLink = screen.getByRole("link", { name: /app-v1\.2\.3\.zip/i });
    expect(fileLink).toHaveClass("link-preview-card", "file-link-card");
    expect(fileLink).toHaveAttribute("download");
    expect(screen.getByText("下载文件")).toBeInTheDocument();
    expect(fileLink.textContent).toContain("app-v1.2.3.zip");
  });

  it("formats bare url into readable card title without preview label", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-3",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "https://docs.example.com/guides/getting-started",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    expect(screen.getByRole("link", { name: /getting started/i })).toBeInTheDocument();
    expect(screen.queryByText("链接预览")).not.toBeInTheDocument();
  });

  it("resolves short url preview title from backend metadata", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-4",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "https://ziiimo.cn/f/ce29",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    expect(await screen.findByRole("link", { name: /github - zzmzz\/cc-pet/i })).toBeInTheDocument();
  });

  it("uses backend file name for short download links", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-5",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "https://ziiimo.cn/d/f664",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    const link = await screen.findByRole("link", { name: /report-2026-03\.pdf/i });
    expect(link).toHaveClass("file-link-card");
    expect(link).toHaveAttribute("download");
  });

  it("trims trailing spaces encoded as %20 in bare links", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-6",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "https://docs.example.com/guides/getting-started%20%20",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    const links = await screen.findAllByRole("link");
    const link = links.find((item) => item.getAttribute("href") === "https://docs.example.com/guides/getting-started");
    expect(link).toBeTruthy();
    if (!link) return;
    expect(link).toHaveAttribute("href", "https://docs.example.com/guides/getting-started");
    expect(link.textContent).not.toContain("%20");
  });

  it("removes spacing before full-width brackets in link title", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-7",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "https://ziiimo.cn/g/72b6%20%EF%BC%883%E5%B0%8F%E6%97%B6%E6%9C%89%E6%95%88%EF%BC%89",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    const link = await screen.findByRole("link", { name: /72b6（3小时有效）/i });
    expect(link.textContent).toContain("72b6（3小时有效）");
  });

  it("separates trailing full-width note from autolink url", async () => {
    useAppStore.setState({
      messagesByChat: {
        [CHAT_KEY]: [
          {
            id: "bot-link-8",
            connectionId: testBridge.id,
            sessionKey: SESSION,
            role: "bot",
            content: "短链：https://ziiimo.cn/h/ae4b（3小时有效）",
            contentType: "text",
            timestamp: Date.now(),
          },
        ],
      },
    });

    render(<ChatWindow />);

    const links = await screen.findAllByRole("link");
    const target = links.find((item) => item.getAttribute("href") === "https://ziiimo.cn/h/ae4b");
    expect(target).toBeTruthy();
    expect(screen.getByText("（3小时有效）")).toBeInTheDocument();
  });
});
