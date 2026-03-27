import { useEffect } from "react";
import { Pet } from "@/components/Pet";
import { ChatWindow } from "@/components/ChatWindow";
import { Settings } from "@/components/Settings";
import { useTauriEvents } from "@/hooks/useTauriEvents";
import { useAppStore } from "@/lib/store";
import {
  loadConfig,
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

  useEffect(() => {
    if (chatOpen || settingsOpen) {
      setMainWindowSize(480, 640).catch(console.error);
      return;
    }
    if (contextMenuOpen) {
      const menuW = Math.max(petSize + 160, 280);
      const menuH = Math.max(petSize + 140, 260);
      setMainWindowSize(menuW, menuH).catch(console.error);
      return;
    }
    setMainWindowSize(petSize, petSize).catch(console.error);
  }, [chatOpen, settingsOpen, contextMenuOpen, petSize]);

  return (
    <div className="w-screen h-screen relative overflow-hidden bg-transparent">
      <Pet size={petSize} />
      <ChatWindow petSize={petSize} />
      <Settings />
    </div>
  );
}
