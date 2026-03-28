import { create } from "zustand";
import type { ChatMessage, PetState, AppConfig, BridgeConfig } from "./types";
import type { SlashCommand } from "@/components/SlashCommandMenu";

type ConnectionEntry = {
  connected: boolean;
  config: BridgeConfig;
};

interface AppStore {
  // connection
  connections: Record<string, ConnectionEntry>;
  setConnections: (configs: BridgeConfig[]) => void;
  setConnectionStatus: (id: string, connected: boolean) => void;
  activeConnectionId: string | null;
  setActiveConnectionId: (id: string | null) => void;
  connected: boolean;

  // pet
  petState: PetState;
  setPetState: (s: PetState) => void;

  // chat
  messagesByConnection: Record<string, ChatMessage[]>;
  addMessage: (connectionId: string, msg: ChatMessage) => void;
  updateMessage: (
    connectionId: string,
    id: string,
    partial: Partial<ChatMessage>
  ) => void;
  clearMessages: (connectionId: string) => void;
  setMessages: (connectionId: string, msgs: ChatMessage[]) => void;

  // slash commands from agent
  agentCommands: SlashCommand[];
  setAgentCommands: (cmds: SlashCommand[]) => void;

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
  connections: {},
  setConnections: (configs) =>
    set((state) => {
      const next: Record<string, ConnectionEntry> = {};
      for (const cfg of configs) {
        next[cfg.id] = {
          config: cfg,
          connected: state.connections[cfg.id]?.connected ?? false,
        };
      }
      const activeConnectionId =
        state.activeConnectionId && next[state.activeConnectionId]
          ? state.activeConnectionId
          : configs[0]?.id ?? null;
      return {
        connections: next,
        activeConnectionId,
        connected: Object.values(next).some((c) => c.connected),
      };
    }),
  setConnectionStatus: (id, connected) =>
    set((state) => {
      const existing = state.connections[id];
      if (!existing) return state;
      const connections = {
        ...state.connections,
        [id]: { ...existing, connected },
      };
      return {
        connections,
        connected: Object.values(connections).some((c) => c.connected),
      };
    }),
  activeConnectionId: null,
  setActiveConnectionId: (id) => set({ activeConnectionId: id }),
  connected: false,

  petState: "idle",
  setPetState: (s) => set({ petState: s }),

  messagesByConnection: {},
  addMessage: (connectionId, msg) =>
    set((state) => ({
      messagesByConnection: {
        ...state.messagesByConnection,
        [connectionId]: [...(state.messagesByConnection[connectionId] ?? []), msg],
      },
    })),
  updateMessage: (connectionId, id, partial) =>
    set((state) => ({
      messagesByConnection: {
        ...state.messagesByConnection,
        [connectionId]: (state.messagesByConnection[connectionId] ?? []).map((m) =>
          m.id === id ? { ...m, ...partial } : m
        ),
      },
    })),
  clearMessages: (connectionId) =>
    set((state) => ({
      messagesByConnection: {
        ...state.messagesByConnection,
        [connectionId]: [],
      },
    })),
  setMessages: (connectionId, msgs) =>
    set((state) => ({
      messagesByConnection: {
        ...state.messagesByConnection,
        [connectionId]: msgs,
      },
    })),

  agentCommands: [],
  setAgentCommands: (cmds) => set({ agentCommands: cmds }),

  chatOpen: false,
  setChatOpen: (v) => set({ chatOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  contextMenuOpen: false,
  setContextMenuOpen: (v) => set({ contextMenuOpen: v }),

  config: null,
  setConfig: (c) => set({ config: c }),
}));
