import { useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pet } from "@/components/Pet";
import { ChatWindow } from "@/components/ChatWindow";
import { Settings } from "@/components/Settings";
import { useTauriEvents } from "@/hooks/useTauriEvents";
import { useAppStore } from "@/lib/store";
import {
  loadConfig,
  saveConfig,
  connectBridge,
  getBridgeConnected,
  setMainWindowSize,
} from "@/lib/commands";

export default function App() {
  const { config, setConfig, setConnected, setSettingsOpen, chatOpen, settingsOpen, contextMenuOpen } =
    useAppStore();

  useTauriEvents();

  useEffect(() => {
    loadConfig()
      .then((cfg) => {
        setConfig(cfg);
        if (cfg.bridge?.token) {
          connectBridge()
            .then(async () => {
              for (let i = 0; i < 8; i++) {
                const ok = await getBridgeConnected().catch(() => false);
                if (ok) {
                  setConnected(true);
                  return;
                }
                await new Promise((r) => setTimeout(r, 300));
              }
            })
            .catch(console.error);
        }
        if (!cfg.bridge?.token?.trim()) {
          setSettingsOpen(true);
        }
      })
      .catch(console.error);
  }, [setConfig, setConnected, setSettingsOpen]);

  const petSize = config?.pet.size ?? 120;
  const chatW = config?.pet.chatWindowWidth ?? 480;
  const chatH = config?.pet.chatWindowHeight ?? 640;

  const panelOpen = chatOpen || settingsOpen;
  const prevPanelOpenRef = useRef(false);

  const persistSize = useCallback(async () => {
    const cfg = useAppStore.getState().config;
    if (!cfg) return;
    try {
      const win = getCurrentWindow();
      const scale = await win.scaleFactor();
      const phys = await win.outerSize();
      const w = Math.round(phys.width / scale);
      const h = Math.round(phys.height / scale);
      if (w === cfg.pet.chatWindowWidth && h === cfg.pet.chatWindowHeight) return;
      const updated = { ...cfg, pet: { ...cfg.pet, chatWindowWidth: w, chatWindowHeight: h } };
      useAppStore.getState().setConfig(updated);
      await saveConfig(updated);
    } catch (e) {
      console.error("persist window size failed:", e);
    }
  }, []);

  useEffect(() => {
    const wasPanelOpen = prevPanelOpenRef.current;
    prevPanelOpenRef.current = panelOpen;

    if (panelOpen) {
      if (!wasPanelOpen) {
        setMainWindowSize(chatW, chatH).catch(console.error);
      }
    } else {
      const shrink = async () => {
        if (wasPanelOpen) {
          await persistSize();
        }
        if (contextMenuOpen) {
          const menuW = Math.max(petSize + 160, 280);
          const menuH = Math.max(petSize + 140, 260);
          setMainWindowSize(menuW, menuH).catch(console.error);
        } else {
          setMainWindowSize(petSize, petSize).catch(console.error);
        }
      };
      shrink();
    }
  }, [panelOpen, contextMenuOpen, petSize, chatW, chatH, persistSize]);

  return (
    <div className="w-screen h-screen relative overflow-hidden bg-transparent">
      <Pet size={petSize} />
      <ChatWindow petSize={petSize} />
      <Settings />
    </div>
  );
}
