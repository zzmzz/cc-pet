import { create } from "zustand";
import type { ChatMessage, PetState, AppConfig } from "./types";

interface AppStore {
  // connection
  connected: boolean;
  setConnected: (v: boolean) => void;

  // pet
  petState: PetState;
  setPetState: (s: PetState) => void;

  // chat
  messages: ChatMessage[];
  addMessage: (msg: ChatMessage) => void;
  updateMessage: (id: string, partial: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  setMessages: (msgs: ChatMessage[]) => void;

  // views
  chatOpen: boolean;
  setChatOpen: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  contextMenuOpen: boolean;
  setContextMenuOpen: (v: boolean) => void;

  // config
  config: AppConfig | null;
  setConfig: (c: AppConfig) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  connected: false,
  setConnected: (v) => set({ connected: v }),

  petState: "idle",
  setPetState: (s) => set({ petState: s }),

  messages: [],
  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),
  updateMessage: (id, partial) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...partial } : m
      ),
    })),
  clearMessages: () => set({ messages: [] }),
  setMessages: (msgs) => set({ messages: msgs }),

  chatOpen: false,
  setChatOpen: (v) => set({ chatOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  contextMenuOpen: false,
  setContextMenuOpen: (v) => set({ contextMenuOpen: v }),

  config: null,
  setConfig: (c) => set({ config: c }),
}));
