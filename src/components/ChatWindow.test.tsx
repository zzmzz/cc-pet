import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWindow } from "./ChatWindow";
import { useAppStore, makeChatKey, defaultSessionKeyFromBridge } from "@/lib/store";
import type { BridgeConfig } from "@/lib/types";
import * as commands from "@/lib/commands";

type EventPayload = Record<string, unknown>;
type EventListener = (event: { payload: EventPayload }) => void;

const eventHandlers = new Map<string, Set<EventListener>>();

function emitMockEvent(eventName: string, payload: EventPayload) {
  const handlers = eventHandlers.get(eventName);
  if (!handlers) return;
  for (const handler of handlers) handler({ payload });
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: EventListener) => {
    const existing = eventHandlers.get(eventName) ?? new Set<EventListener>();
    existing.add(handler);
    eventHandlers.set(eventName, existing);
    return () => {
      const current = eventHandlers.get(eventName);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) eventHandlers.delete(eventName);
    };
  }),
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
  downloadFileFromUrl: vi.fn(async () => "C:\\Users\\test\\Downloads\\app-v1.2.3.zip"),
  sendCardAction: vi.fn(async () => {}),
  sendFile: vi.fn(async () => {}),
  sendFiles: vi.fn(async () => {}),
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
    vi.useRealTimers();
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(commands.sendMessage).mockClear();
    vi.mocked(commands.sendCardAction).mockClear();
    eventHandlers.clear();
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

  it("shows thinking first and switches to working after stream delta", async () => {
    const user = userEvent.setup();
    render(<ChatWindow />);

    const input = screen.getByPlaceholderText("输入消息，Enter 发送，Shift+Enter 换行");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.getByText("思考中")).toBeInTheDocument();

    emitMockEvent("bridge-stream-delta", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
      delta: "ok",
    });

    await waitFor(() => {
      expect(screen.getByText("处理中")).toBeInTheDocument();
    });
  });

  it("shows stop button while working and sends /stop command", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setSessionTaskState(testBridge.id, SESSION, {
      activeRequestId: "req-working-stop",
      phase: "working",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      firstTokenAt: Date.now(),
      stalledReason: null,
    });
    render(<ChatWindow />);

    const stopButton = screen.getByRole("button", { name: "终止" });
    expect(stopButton).toBeInTheDocument();
    await user.click(stopButton);

    expect(commands.sendMessage).toHaveBeenCalledWith(
      testBridge.id,
      "/stop",
      SESSION,
    );
  });

  it("shows stop button while thinking and sends /stop command", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setSessionTaskState(testBridge.id, SESSION, {
      activeRequestId: "req-thinking-stop",
      phase: "thinking",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      firstTokenAt: null,
      stalledReason: null,
    });
    render(<ChatWindow />);

    const stopButton = screen.getByRole("button", { name: "终止" });
    expect(stopButton).toBeInTheDocument();
    await user.click(stopButton);

    expect(commands.sendMessage).toHaveBeenCalledWith(
      testBridge.id,
      "/stop",
      SESSION,
    );
  });

  it("uses typing events to drive working and completed status", async () => {
    render(<ChatWindow />);
    await waitFor(() => {
      expect((eventHandlers.get("bridge-typing-start")?.size ?? 0) > 0).toBe(true);
      expect((eventHandlers.get("bridge-preview-update")?.size ?? 0) > 0).toBe(true);
      expect((eventHandlers.get("bridge-typing-stop")?.size ?? 0) > 0).toBe(true);
    });

    emitMockEvent("bridge-typing-start", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
    });
    await waitFor(() => {
      expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("thinking");
    });

    emitMockEvent("bridge-preview-update", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
      content: "part",
    });
    await waitFor(() => {
      expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("working");
      expect(useAppStore.getState().petState).toBe("thinking");
    });

    emitMockEvent("bridge-typing-stop", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
    });
    await waitFor(() => {
      expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("completed");
      expect(useAppStore.getState().petState).toBe("idle");
    });
  });

  it("does not auto-complete while typing is active", async () => {
    render(<ChatWindow />);
    await waitFor(() => {
      expect((eventHandlers.get("bridge-typing-start")?.size ?? 0) > 0).toBe(true);
      expect((eventHandlers.get("bridge-message")?.size ?? 0) > 0).toBe(true);
    });
    vi.useFakeTimers();

    emitMockEvent("bridge-typing-start", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
    });
    emitMockEvent("bridge-message", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
      content: "chunk-1",
    });

    vi.advanceTimersByTime(5_000);
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("working");

    emitMockEvent("bridge-typing-stop", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
    });
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("completed");
  });

  it("keeps per-session status isolated when switching sessions", async () => {
    const anotherSession = `${SESSION}-b`;
    useAppStore.setState({
      sessionsByConnection: { [testBridge.id]: [SESSION, anotherSession] },
      activeSessionByConnection: { [testBridge.id]: SESSION },
    });
    render(<ChatWindow />);

    useAppStore.getState().setSessionTaskState(testBridge.id, SESSION, {
      activeRequestId: "req-a",
      phase: "stalled",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      firstTokenAt: null,
      stalledReason: "first_token_timeout",
    });
    await waitFor(() => {
      expect(screen.getByText(/可能卡住/i)).toBeInTheDocument();
    });

    useAppStore.getState().setActiveSessionKey(testBridge.id, anotherSession);
    await waitFor(() => {
      expect(screen.queryByText(/可能卡住/i)).not.toBeInTheDocument();
      expect(screen.getByText("空闲")).toBeInTheDocument();
    });
  });

  it("shows statuses in title and session list, including idle", async () => {
    const anotherSession = `${SESSION}-status`;
    const user = userEvent.setup();
    vi.mocked(commands.listBridgeSessions).mockResolvedValueOnce({
      sessions: [
        { id: SESSION, name: "default", historyCount: 0 },
        { id: anotherSession, name: "任务会话", historyCount: 0 },
      ],
      activeSessionId: SESSION,
    });
    render(<ChatWindow />);

    await waitFor(() => {
      expect(useAppStore.getState().sessionsByConnection[testBridge.id]).toContain(anotherSession);
    });
    useAppStore.getState().setSessionTaskState(testBridge.id, anotherSession, {
      activeRequestId: "req-working",
      phase: "working",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      firstTokenAt: Date.now(),
      stalledReason: null,
    });

    expect(screen.getByText("空闲")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /default/i }));
    await waitFor(() => {
      expect(screen.getByText("处理中")).toBeInTheDocument();
    });
  });

  it("renders bridge buttons, supports custom input, and marks pending confirmation", async () => {
    const user = userEvent.setup();
    render(<ChatWindow />);
    await waitFor(() => {
      expect((eventHandlers.get("bridge-buttons")?.size ?? 0) > 0).toBe(true);
    });
    useAppStore.getState().addMessage(testBridge.id, SESSION, {
      id: "bot-buttons-1",
      connectionId: testBridge.id,
      sessionKey: SESSION,
      replyCtx: "ctx-1",
      role: "bot",
      content: "请选择处理方式",
      contentType: "buttons",
      buttons: [
        [
          { text: "允许", data: "perm:allow" },
          { text: "拒绝", data: "perm:deny" },
        ],
      ],
      timestamp: Date.now(),
    });

    emitMockEvent("bridge-buttons", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
      replyCtx: "ctx-1",
    });

    await waitFor(() => {
      expect(screen.getByText("待确认")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "允许" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
      expect(screen.getByPlaceholderText("输入自定义内容")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "发送自定义" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "允许" }));
    expect(commands.sendCardAction).toHaveBeenCalledWith(
      testBridge.id,
      "perm:allow",
      SESSION,
      "ctx-1",
    );

    await user.type(screen.getByPlaceholderText("输入自定义内容"), "手动确认");
    await user.click(screen.getByRole("button", { name: "发送自定义" }));
    expect(commands.sendMessage).toHaveBeenCalledWith(
      testBridge.id,
      "手动确认",
      SESSION,
      "ctx-1",
    );
  });

  it("does not mark stalled when timeout config is zero", () => {
    vi.useFakeTimers();
    render(<ChatWindow />);

    useAppStore.getState().setSessionTaskState(testBridge.id, SESSION, {
      activeRequestId: "req-zero",
      phase: "thinking",
      startedAt: Date.now() - 60_000,
      lastActivityAt: Date.now() - 60_000,
      firstTokenAt: null,
      stalledReason: null,
    });

    vi.advanceTimersByTime(2_000);
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("thinking");
    expect(screen.queryByText(/可能卡住/i)).not.toBeInTheDocument();
  });

  it("marks session as stalled when timeout is enabled", () => {
    vi.useFakeTimers();
    useAppStore.setState({
      config: {
        bridges: [],
        pet: {
          size: 120,
          alwaysOnTop: true,
          launchOnStartup: false,
          chatWindowOpacity: 0.97,
          chatWindowWidth: 480,
          chatWindowHeight: 640,
          toggleVisibilityShortcut: "Ctrl+Shift+H",
          firstTokenTimeoutMs: 1000,
          streamIdleTimeoutMs: 0,
          appearance: {},
        },
        llm: {
          apiUrl: "",
          apiKey: "",
          model: "",
          enabled: false,
        },
      },
    });
    render(<ChatWindow />);

    useAppStore.getState().setSessionTaskState(testBridge.id, SESSION, {
      activeRequestId: "req-timeout",
      phase: "thinking",
      startedAt: Date.now() - 2_000,
      lastActivityAt: Date.now() - 2_000,
      firstTokenAt: null,
      stalledReason: null,
    });

    vi.advanceTimersByTime(1_500);
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("stalled");
  });

  it("keeps working during chunked bridge-message and completes after quiet debounce", async () => {
    render(<ChatWindow />);
    await Promise.resolve();
    await Promise.resolve();
    vi.useFakeTimers();

    useAppStore.getState().setSessionTaskState(testBridge.id, SESSION, {
      activeRequestId: "req-chunk",
      phase: "thinking",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      firstTokenAt: null,
      stalledReason: null,
    });

    emitMockEvent("bridge-message", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
      content: "part-1",
    });
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("working");

    vi.advanceTimersByTime(800);
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("working");

    emitMockEvent("bridge-message", {
      connectionId: testBridge.id,
      sessionKey: SESSION,
      content: "part-2",
    });
    vi.advanceTimersByTime(800);
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("working");

    vi.advanceTimersByTime(500);
    expect(useAppStore.getState().getActiveSessionTaskState().phase).toBe("completed");
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

    const fileLink = screen.getByRole("button", { name: /app-v1\.2\.3\.zip/i });
    expect(fileLink).toHaveClass("link-preview-card", "file-link-card");
    expect(screen.getByText("下载文件")).toBeInTheDocument();
    expect(fileLink.textContent).toContain("app-v1.2.3.zip");
  });

  it("shows saved path when download completed event arrives", async () => {
    render(<ChatWindow />);
    await waitFor(() => {
      expect((eventHandlers.get("file-download-progress")?.size ?? 0) > 0).toBe(true);
    });

    emitMockEvent("file-download-progress", {
      id: "dl-event-complete",
      status: "completed",
      url: "https://example.com/files/app-v1.2.3.zip",
      fileName: "app-v1.2.3.zip",
      path: "C:\\Users\\test\\Downloads\\app-v1.2.3.zip",
      receivedBytes: 1024,
      totalBytes: 1024,
    });

    await waitFor(() => {
      expect(screen.getByText("app-v1.2.3.zip")).toBeInTheDocument();
      expect(screen.getByText(/C:\\Users\\test\\Downloads\\app-v1.2.3.zip/)).toBeInTheDocument();
      expect(screen.getByText("已下载")).toBeInTheDocument();
    });
  });

  it("opens exact displayed downloaded path", async () => {
    const user = userEvent.setup();
    render(<ChatWindow />);
    await waitFor(() => {
      expect((eventHandlers.get("file-download-progress")?.size ?? 0) > 0).toBe(true);
    });

    const completedPath = "C:\\Users\\test\\Downloads\\report-2026-03.pdf";
    emitMockEvent("file-download-progress", {
      id: "dl-open-path-1",
      status: "completed",
      url: "https://example.com/files/report-2026-03.pdf",
      fileName: "report-2026-03.pdf",
      path: completedPath,
      receivedBytes: 2048,
      totalBytes: 2048,
    });

    await waitFor(() => {
      expect(screen.getByText(completedPath)).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "打开位置" }));
    expect(commands.revealFile).toHaveBeenCalledWith(completedPath);
  });

  it("auto hides completed download tip after 10 seconds", async () => {
    render(<ChatWindow />);
    await waitFor(() => {
      expect((eventHandlers.get("file-download-progress")?.size ?? 0) > 0).toBe(true);
    });
    vi.useFakeTimers();

    const completedPath = "C:\\Users\\test\\Downloads\\demo.zip";
    act(() => {
      emitMockEvent("file-download-progress", {
        id: "dl-auto-hide-1",
        status: "completed",
        url: "https://example.com/files/demo.zip",
        fileName: "demo.zip",
        path: completedPath,
        receivedBytes: 1024,
        totalBytes: 1024,
      });
    });

    expect(screen.getByText(completedPath)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(screen.queryByText(completedPath)).not.toBeInTheDocument();
  });

  it("updates file download progress by backend events", async () => {
    render(<ChatWindow />);
    await waitFor(() => {
      expect((eventHandlers.get("file-download-progress")?.size ?? 0) > 0).toBe(true);
    });

    emitMockEvent("file-download-progress", {
      id: "dl-event-1",
      status: "downloading",
      url: "https://example.com/files/demo.zip",
      fileName: "demo.zip",
      receivedBytes: 512,
      totalBytes: 1024,
    });

    await waitFor(() => {
      expect(screen.getByText(/下载中 50%/)).toBeInTheDocument();
      expect(screen.getByText("demo.zip")).toBeInTheDocument();
    });
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

    const link = await screen.findByRole("button", { name: /report-2026-03\.pdf/i });
    expect(link).toHaveClass("file-link-card");
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

  it("does not mark chat titlebar as native drag region", () => {
    render(<ChatWindow />);

    expect(document.querySelector("[data-tauri-drag-region]")).toBeNull();
  });

  it("applies chat window opacity from config", () => {
    useAppStore.setState({
      config: {
        bridges: [],
        pet: {
          size: 120,
          alwaysOnTop: true,
          launchOnStartup: false,
          chatWindowOpacity: 0.61,
          chatWindowWidth: 480,
          chatWindowHeight: 640,
          toggleVisibilityShortcut: "Ctrl+Shift+H",
          appearance: {},
        },
        llm: {
          apiUrl: "",
          apiKey: "",
          model: "",
          enabled: false,
        },
      },
    });

    render(<ChatWindow />);
    expect(screen.getByTestId("chat-window-panel")).toHaveStyle({
      backgroundColor: "rgba(255, 255, 255, 0.61)",
    });
  });
});
