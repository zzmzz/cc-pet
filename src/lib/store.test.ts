import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./store";
import type { ChatMessage } from "./types";

const initialState = useAppStore.getState();

function resetStore() {
  useAppStore.setState(initialState, true);
}

describe("useAppStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("setConnected updates top-level connected flag", () => {
    useAppStore.getState().setConnected(true);
    expect(useAppStore.getState().connected).toBe(true);

    useAppStore.getState().setConnected(false);
    expect(useAppStore.getState().connected).toBe(false);
  });

  it("add/update/clearMessages mutate message list as expected", () => {
    const m1: ChatMessage = {
      id: "m1",
      role: "user",
      content: "hello",
      contentType: "text",
      timestamp: 1,
    };
    const m2: ChatMessage = {
      id: "m2",
      role: "bot",
      content: "world",
      contentType: "text",
      timestamp: 2,
    };

    const store = useAppStore.getState();
    store.addMessage(m1);
    store.addMessage(m2);
    store.updateMessage("m1", { content: "hello2" });

    expect(useAppStore.getState().messages[0].content).toBe("hello2");
    expect(useAppStore.getState().messages[1].content).toBe("world");

    store.clearMessages();
    expect(useAppStore.getState().messages).toEqual([]);
  });

  it("setMessages replaces full message list", () => {
    const list: ChatMessage[] = [
      {
        id: "m3",
        role: "bot",
        content: "replaced",
        contentType: "text",
        timestamp: 3,
      },
    ];
    useAppStore.getState().setMessages(list);
    expect(useAppStore.getState().messages).toEqual(list);
  });
});
