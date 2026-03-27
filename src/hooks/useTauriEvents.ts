import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/lib/store";

export function useTauriEvents() {
  const { setConnected, setPetState, addMessage, setChatOpen, setSettingsOpen } =
    useAppStore();

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    async function setup() {
      const u1 = await listen<boolean>("bridge-connected", (e) => {
        if (cancelled) return;
        setConnected(e.payload);
        setPetState(e.payload ? "happy" : "idle");
        if (e.payload) {
          setTimeout(() => setPetState("idle"), 3000);
        }
      });
      if (cancelled) { u1(); return; }
      unlistenFns.push(u1);

      const u2 = await listen<string>("bridge-message", (e) => {
        if (cancelled) return;
        setPetState("talking");
        addMessage({
          id: `bot-${Date.now()}`,
          role: "bot",
          content: e.payload,
          contentType: "text",
          timestamp: Date.now(),
        });
        setTimeout(() => setPetState("idle"), 4000);
      });
      if (cancelled) { u2(); return; }
      unlistenFns.push(u2);

      const u3 = await listen<string>("bridge-error", (e) => {
        if (cancelled) return;
        setPetState("error");
        console.error("bridge error:", e.payload);
        setTimeout(() => setPetState("idle"), 3000);
      });
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
    }

    setup();

    return () => {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    };
  }, [setConnected, setPetState, addMessage, setChatOpen, setSettingsOpen]);
}
