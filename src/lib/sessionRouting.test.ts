import { describe, expect, it } from "vitest";
import { resolveIncomingSessionKey } from "./sessionRouting";

describe("resolveIncomingSessionKey", () => {
  it("prefers payload sessionKey over active session to avoid cross-session mixing", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: "session-other",
      replyCtx: undefined,
      knownSessions: ["session-current", "session-other"],
      activeSessionKey: "session-current",
    });
    expect(resolved).toBe("session-other");
  });

  it("extracts session key from ccpet reply context when payload session key is missing", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: "ccpet:session-a:42",
      knownSessions: ["session-a", "session-b"],
      activeSessionKey: "session-b",
    });
    expect(resolved).toBe("session-a");
  });

  it("falls back to active session when no payload key and no valid reply context", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: "invalid",
      knownSessions: ["session-a", "session-b"],
      activeSessionKey: "session-b",
    });
    expect(resolved).toBe("session-b");
  });
});
