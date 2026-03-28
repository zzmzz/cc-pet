import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearHistory, getHistory, sendMessage, setWindowOpacity } from "./commands";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("commands wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps sendMessage to send_message invoke payload", async () => {
    await sendMessage("hello");
    expect(invoke).toHaveBeenCalledWith("send_message", {
      text: "hello",
    });
  });

  it("maps getHistory beforeId undefined to null", async () => {
    await getHistory(20);
    expect(invoke).toHaveBeenCalledWith("get_history", {
      limit: 20,
      beforeId: null,
    });
  });

  it("maps clearHistory to clear_history invoke", async () => {
    await clearHistory();
    expect(invoke).toHaveBeenCalledWith("clear_history");
  });

  it("passes primitive window opacity payload", async () => {
    await setWindowOpacity(0.88);
    expect(invoke).toHaveBeenCalledWith("set_window_opacity", {
      opacity: 0.88,
    });
  });
});
