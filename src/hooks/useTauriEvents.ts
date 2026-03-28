import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, makeChatKey } from "@/lib/store";
import { runManualUpdateCheckWithDialogs } from "@/lib/manualUpdateCheck";
import { listBridgeSessions, getHistory } from "@/lib/commands";
import { resolveIncomingSessionKey } from "@/lib/sessionRouting";

export function useTauriEvents() {
  const {
    setConnectionStatus,
    setPetState,
    addMessage,
    ensureSession,
    setActiveSessionKey,
    setSessions,
    setSessionLabel,
    setMessages,
    setChatOpen,
    setSettingsOpen,
    markSessionUnread,
  } = useAppStore();

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    async function setup() {
      const setIdleRespectUnread = () => {
        const store = useAppStore.getState();
        if (store.hasAnyUnread()) {
          store.setPetState("talking");
          return;
        }
        store.setPetState("idle");
      };

      const u1 = await listen<{ connectionId: string; connected: boolean }>(
        "bridge-connected",
        (e) => {
          if (cancelled) return;
          setConnectionStatus(e.payload.connectionId, e.payload.connected);
          setPetState(e.payload.connected ? "happy" : "idle");
          if (e.payload.connected) {
            setTimeout(() => setIdleRespectUnread(), 3000);
            const connId = e.payload.connectionId;
            console.log("[sessions] bridge-connected, refreshing sessions for", connId);
            listBridgeSessions(connId)
              .then((data) => {
                if (cancelled) return;
                console.log("[sessions] bridge refresh for", connId, ":", data.sessions.length, "sessions, active:", data.activeSessionId);
                const ids = data.sessions.map((s) => s.id);
                setSessions(connId, ids, data.activeSessionId ?? undefined);
                for (const s of data.sessions) {
                  if (s.name) setSessionLabel(connId, s.id, s.name);
                }
                // Load history for the active session
                const activeId = data.activeSessionId ?? ids[0];
                if (activeId) {
                  const store = useAppStore.getState();
                  const key = makeChatKey(connId, activeId);
                  const existing = store.messagesByChat[key];
                  if (!existing || existing.length === 0) {
                    getHistory(connId, 50, activeId)
                      .then((msgs) => {
                        if (cancelled) return;
                        if (msgs.length > 0) setMessages(connId, activeId, msgs);
                      })
                      .catch(console.error);
                  }
                }
              })
              .catch(console.error);
          }
        }
      );
      if (cancelled) { u1(); return; }
      unlistenFns.push(u1);

      const u2 = await listen<{ connectionId: string; sessionKey?: string; replyCtx?: string; content: string }>(
        "bridge-message",
        (e) => {
          if (cancelled) return;
          const store = useAppStore.getState();
          const knownSessions = store.sessionsByConnection[e.payload.connectionId] ?? [];
          const sessionKey = resolveIncomingSessionKey({
            payloadSessionKey: e.payload.sessionKey,
            replyCtx: e.payload.replyCtx,
            knownSessions,
            activeSessionKey: store.activeSessionByConnection[e.payload.connectionId],
          });
          const activeSession = store.activeSessionByConnection[e.payload.connectionId];
          const shouldMarkUnread = !store.chatOpen || activeSession !== sessionKey;
          ensureSession(e.payload.connectionId, sessionKey);
          if (!store.activeSessionByConnection[e.payload.connectionId]) {
            setActiveSessionKey(e.payload.connectionId, sessionKey);
          }
          if (shouldMarkUnread) {
            markSessionUnread(e.payload.connectionId, sessionKey);
          } else {
            setPetState("talking");
          }
          addMessage(e.payload.connectionId, sessionKey, {
            id: `bot-${Date.now()}`,
            connectionId: e.payload.connectionId,
            sessionKey,
            replyCtx: e.payload.replyCtx,
            role: "bot",
            content: e.payload.content,
            contentType: "text",
            timestamp: Date.now(),
          });
          setTimeout(() => setIdleRespectUnread(), 4000);
        }
      );
      if (cancelled) { u2(); return; }
      unlistenFns.push(u2);

      const u2b = await listen<{ connectionId: string; sessionKey?: string; replyCtx?: string; name: string; path: string }>(
        "bridge-file-received",
        (e) => {
          if (cancelled) return;
          const store = useAppStore.getState();
          const knownSessions = store.sessionsByConnection[e.payload.connectionId] ?? [];
          const sessionKey = resolveIncomingSessionKey({
            payloadSessionKey: e.payload.sessionKey,
            replyCtx: e.payload.replyCtx,
            knownSessions,
            activeSessionKey: store.activeSessionByConnection[e.payload.connectionId],
          });
          const activeSession = store.activeSessionByConnection[e.payload.connectionId];
          const shouldMarkUnread = !store.chatOpen || activeSession !== sessionKey;
          ensureSession(e.payload.connectionId, sessionKey);
          if (shouldMarkUnread) {
            markSessionUnread(e.payload.connectionId, sessionKey);
          } else {
            setPetState("happy");
          }
          addMessage(e.payload.connectionId, sessionKey, {
            id: `bot-file-${Date.now()}`,
            connectionId: e.payload.connectionId,
            sessionKey,
            replyCtx: e.payload.replyCtx,
            role: "bot",
            content: e.payload.name,
            contentType: "file",
            filePath: e.payload.path,
            timestamp: Date.now(),
          });
          setTimeout(() => setIdleRespectUnread(), 3000);
        }
      );
      if (cancelled) { u2b(); return; }
      unlistenFns.push(u2b);

      const u3 = await listen<{ connectionId: string; error: string }>(
        "bridge-error",
        (e) => {
          if (cancelled) return;
          setPetState("error");
          console.error("bridge error:", e.payload.connectionId, e.payload.error);
          setTimeout(() => setIdleRespectUnread(), 3000);
        }
      );
      if (cancelled) { u3(); return; }
      unlistenFns.push(u3);
      
      const u4 = await listen("toggle-chat", () => {
        if (cancelled) return;
        setChatOpen(true);
      });
      if (cancelled) { u4(); return; }
      unlistenFns.push(u4);

      const u5 = await listen("toggle-settings", () => {
        if (cancelled) return;
        setSettingsOpen(true);
      });
      if (cancelled) { u5(); return; }
      unlistenFns.push(u5);

      const u6 = await listen("manual-check-updates", () => {
        if (cancelled) return;
        void runManualUpdateCheckWithDialogs();
      });
      if (cancelled) { u6(); return; }
      unlistenFns.push(u6);
    }

    setup();

    return () => {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    };
  }, [setConnectionStatus, setPetState, addMessage, ensureSession, setActiveSessionKey, setSessions, setSessionLabel, setMessages, setChatOpen, setSettingsOpen, markSessionUnread]);
}
