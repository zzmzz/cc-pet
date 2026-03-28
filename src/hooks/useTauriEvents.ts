import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/lib/store";
import { runManualUpdateCheckWithDialogs } from "@/lib/manualUpdateCheck";

export function useTauriEvents() {
  const {
    setConnectionStatus,
    setPetState,
    addMessage,
    setChatOpen,
    setSettingsOpen,
  } = useAppStore();

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    async function setup() {
      const u1 = await listen<{ connectionId: string; connected: boolean }>(
        "bridge-connected",
        (e) => {
          if (cancelled) return;
          setConnectionStatus(e.payload.connectionId, e.payload.connected);
          setPetState(e.payload.connected ? "happy" : "idle");
          if (e.payload.connected) {
            setTimeout(() => setPetState("idle"), 3000);
          }
        }
      );
      if (cancelled) { u1(); return; }
      unlistenFns.push(u1);

      const u2 = await listen<{ connectionId: string; content: string }>(
        "bridge-message",
        (e) => {
          if (cancelled) return;
          setPetState("talking");
          addMessage(e.payload.connectionId, {
            id: `bot-${Date.now()}`,
            connectionId: e.payload.connectionId,
            role: "bot",
            content: e.payload.content,
            contentType: "text",
            timestamp: Date.now(),
          });
          setTimeout(() => setPetState("idle"), 4000);
        }
      );
      if (cancelled) { u2(); return; }
      unlistenFns.push(u2);

      const u2b = await listen<{ connectionId: string; name: string; path: string }>(
        "bridge-file-received",
        (e) => {
          if (cancelled) return;
          setPetState("happy");
          addMessage(e.payload.connectionId, {
            id: `bot-file-${Date.now()}`,
            connectionId: e.payload.connectionId,
            role: "bot",
            content: e.payload.name,
            contentType: "file",
            filePath: e.payload.path,
            timestamp: Date.now(),
          });
          setTimeout(() => setPetState("idle"), 3000);
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
          setTimeout(() => setPetState("idle"), 3000);
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
  }, [setConnectionStatus, setPetState, addMessage, setChatOpen, setSettingsOpen]);
}
