import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore, makeChatKey, defaultSessionKeyFromBridge } from "./store";
import type { ChatMessage, BridgeConfig } from "./types";

const testBridge: BridgeConfig = {
  id: "test-conn",
  name: "Test",
  host: "127.0.0.1",
  port: 9810,
  token: "t",
  platformName: "platform",
  userId: "user1",
};
const CONN = testBridge.id;
const SESSION = defaultSessionKeyFromBridge(testBridge);
const CHAT_KEY = makeChatKey(CONN, SESSION);

const initialState = useAppStore.getState();

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
  });

  it("setConnections + setConnectionStatus updates connected flag", () => {
    useAppStore.getState().setConnections([testBridge]);
    useAppStore.getState().setConnectionStatus(CONN, true);
    expect(useAppStore.getState().connected).toBe(true);

    useAppStore.getState().setConnectionStatus(CONN, false);
    expect(useAppStore.getState().connected).toBe(false);
  });

  it("add/update/clearMessages mutate messagesByChat as expected", () => {
    useAppStore.getState().setConnections([testBridge]);

    const m1: ChatMessage = {
      id: "m1",
      connectionId: CONN,
      sessionKey: SESSION,
      role: "user",
      content: "hello",
      contentType: "text",
      timestamp: 1,
    };
    const m2: ChatMessage = {
      id: "m2",
      connectionId: CONN,
      sessionKey: SESSION,
      role: "bot",
      content: "world",
      contentType: "text",
      timestamp: 2,
    };

    const store = useAppStore.getState();
    store.addMessage(CONN, SESSION, m1);
    store.addMessage(CONN, SESSION, m2);
    store.updateMessage(CONN, SESSION, "m1", { content: "hello2" });

    expect(useAppStore.getState().messagesByChat[CHAT_KEY]?.[0].content).toBe("hello2");
    expect(useAppStore.getState().messagesByChat[CHAT_KEY]?.[1].content).toBe("world");

    store.clearMessages(CONN, SESSION);
    expect(useAppStore.getState().messagesByChat[CHAT_KEY]).toEqual([]);
  });

  it("setMessages replaces full message list", () => {
    useAppStore.getState().setConnections([testBridge]);

    const list: ChatMessage[] = [
      {
        id: "m3",
        connectionId: CONN,
        sessionKey: SESSION,
        role: "bot",
        content: "replaced",
        contentType: "text",
        timestamp: 3,
      },
    ];
    useAppStore.getState().setMessages(CONN, SESSION, list);
    expect(useAppStore.getState().messagesByChat[CHAT_KEY]).toEqual(list);
  });
});
