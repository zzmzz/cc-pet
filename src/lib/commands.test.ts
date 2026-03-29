import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  clearHistory,
  fetchLinkPreview,
  getHistory,
  sendMessage,
  setWindowOpacity,
  togglePetVisibility,
} from "./commands";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("commands wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps sendMessage to send_message invoke payload", async () => {
    await sendMessage("conn-1", "hello", "s1", "ctx-1");
    expect(invoke).toHaveBeenCalledWith("send_message", {
      connectionId: "conn-1",
      text: "hello",
      sessionKey: "s1",
      replyCtx: "ctx-1",
    });
  });

  it("maps getHistory optional args to null", async () => {
    await getHistory("conn-1", 20);
    expect(invoke).toHaveBeenCalledWith("get_history", {
      connectionId: "conn-1",
      sessionKey: null,
      limit: 20,
      beforeId: null,
    });
  });

  it("maps clearHistory to clear_history invoke", async () => {
    await clearHistory();
    expect(invoke).toHaveBeenCalledWith("clear_history", {
      connectionId: null,
    });
  });

  it("passes primitive window opacity payload", async () => {
    await setWindowOpacity(0.88);
    expect(invoke).toHaveBeenCalledWith("set_window_opacity", {
      opacity: 0.88,
    });
  });

  it("maps fetchLinkPreview to fetch_link_preview invoke payload", async () => {
    await fetchLinkPreview("https://ziiimo.cn/f/ce29");
    expect(invoke).toHaveBeenCalledWith("fetch_link_preview", {
      url: "https://ziiimo.cn/f/ce29",
    });
  });

  it("maps togglePetVisibility to toggle_window_visibility invoke", async () => {
    await togglePetVisibility();
    expect(invoke).toHaveBeenCalledWith("toggle_window_visibility");
  });
});
