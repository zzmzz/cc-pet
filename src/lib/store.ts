import { create } from "zustand";
import type { ChatMessage, PetState, AppConfig, BridgeConfig } from "./types";
import type { SlashCommand } from "@/components/SlashCommandMenu";

// ── Utility exports ────────────────────────────────────────────────────────────

export function makeChatKey(connectionId: string, sessionKey: string): string {
  return `${connectionId}::${sessionKey}`;
}

export function defaultSessionKeyFromBridge(_bridge: BridgeConfig): string {
  return "default";
}

function autoTitle(content: string): string {
  const trimmed = content.trim();
  return trimmed.length <= 15 ? trimmed : trimmed.slice(0, 15) + "…";
}

// ── Types ──────────────────────────────────────────────────────────────────────

type ConnectionEntry = {
  connected: boolean;
  config: BridgeConfig;
};

interface AppStore {
  // connections
  connections: Record<string, ConnectionEntry>;
  setConnections: (configs: BridgeConfig[]) => void;
  setConnectionStatus: (id: string, connected: boolean) => void;
  activeConnectionId: string | null;
  setActiveConnectionId: (id: string | null) => void;
  connected: boolean;

  // sessions per connection
  activeSessionByConnection: Record<string, string>;
  sessionsByConnection: Record<string, string[]>;
  sessionLabelsByConnection: Record<string, Record<string, string>>;
  sessionLastActiveByConnection: Record<string, Record<string, number>>;
  setSessions: (connectionId: string, sessionIds: string[], activeId?: string) => void;
  setSessionLabel: (connectionId: string, sessionId: string, label: string) => void;
  setActiveSessionKey: (connectionId: string, sessionKey: string) => void;
  ensureSession: (connectionId: string, sessionKey: string) => void;

  // messages
  messagesByChat: Record<string, ChatMessage[]>;
  addMessage: (connectionId: string, sessionKey: string, msg: ChatMessage) => void;
  updateMessage: (connectionId: string, sessionKey: string, id: string, partial: Partial<ChatMessage>) => void;
  clearMessages: (connectionId: string, sessionKey: string) => void;
  setMessages: (connectionId: string, sessionKey: string, msgs: ChatMessage[]) => void;

  // pet
  petState: PetState;
  setPetState: (s: PetState) => void;

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

// ── Store ──────────────────────────────────────────────────────────────────────

export const useAppStore = create<AppStore>((set) => ({
  // ── connections ──
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
      const connections = { ...state.connections, [id]: { ...existing, connected } };
      return {
        connections,
        connected: Object.values(connections).some((c) => c.connected),
      };
    }),
  activeConnectionId: null,
  setActiveConnectionId: (id) => set({ activeConnectionId: id }),
  connected: false,

  // ── sessions ──
  activeSessionByConnection: {},
  sessionsByConnection: {},
  sessionLabelsByConnection: {},
  sessionLastActiveByConnection: {},

  setSessions: (connectionId, sessionIds, activeId) =>
    set((state) => {
      const current = state.activeSessionByConnection[connectionId];
      const newActive =
        activeId ??
        (current && sessionIds.includes(current) ? current : sessionIds[0]);
      return {
        sessionsByConnection: { ...state.sessionsByConnection, [connectionId]: sessionIds },
        activeSessionByConnection: newActive
          ? { ...state.activeSessionByConnection, [connectionId]: newActive }
          : state.activeSessionByConnection,
      };
    }),

  setSessionLabel: (connectionId, sessionId, label) =>
    set((state) => ({
      sessionLabelsByConnection: {
        ...state.sessionLabelsByConnection,
        [connectionId]: {
          ...(state.sessionLabelsByConnection[connectionId] ?? {}),
          [sessionId]: label,
        },
      },
    })),

  setActiveSessionKey: (connectionId, sessionKey) =>
    set((state) => ({
      activeSessionByConnection: {
        ...state.activeSessionByConnection,
        [connectionId]: sessionKey,
      },
      sessionLastActiveByConnection: {
        ...state.sessionLastActiveByConnection,
        [connectionId]: {
          ...(state.sessionLastActiveByConnection[connectionId] ?? {}),
          [sessionKey]: Date.now(),
        },
      },
    })),

  ensureSession: (connectionId, sessionKey) =>
    set((state) => {
      const existing = state.sessionsByConnection[connectionId] ?? [];
      if (existing.includes(sessionKey)) return state;
      return {
        sessionsByConnection: {
          ...state.sessionsByConnection,
          [connectionId]: [...existing, sessionKey],
        },
      };
    }),

  // ── messages ──
  messagesByChat: {},

  addMessage: (connectionId, sessionKey, msg) =>
    set((state) => {
      const key = makeChatKey(connectionId, sessionKey);
      const prev = state.messagesByChat[key] ?? [];
      const updated = [...prev, msg];

      // Auto-title: when a user's first text message arrives and there's no label yet
      let labelUpdate: Partial<AppStore> = {};
      const existingLabel = state.sessionLabelsByConnection[connectionId]?.[sessionKey];
      if (!existingLabel && msg.role === "user" && msg.contentType === "text") {
        labelUpdate = {
          sessionLabelsByConnection: {
            ...state.sessionLabelsByConnection,
            [connectionId]: {
              ...(state.sessionLabelsByConnection[connectionId] ?? {}),
              [sessionKey]: autoTitle(msg.content),
            },
          },
        };
      }

      return {
        messagesByChat: { ...state.messagesByChat, [key]: updated },
        sessionLastActiveByConnection: {
          ...state.sessionLastActiveByConnection,
          [connectionId]: {
            ...(state.sessionLastActiveByConnection[connectionId] ?? {}),
            [sessionKey]: Date.now(),
          },
        },
        ...labelUpdate,
      };
    }),

  updateMessage: (connectionId, sessionKey, id, partial) =>
    set((state) => {
      const key = makeChatKey(connectionId, sessionKey);
      return {
        messagesByChat: {
          ...state.messagesByChat,
          [key]: (state.messagesByChat[key] ?? []).map((m) =>
            m.id === id ? { ...m, ...partial } : m
          ),
        },
      };
    }),

  clearMessages: (connectionId, sessionKey) =>
    set((state) => {
      const key = makeChatKey(connectionId, sessionKey);
      return {
        messagesByChat: { ...state.messagesByChat, [key]: [] },
      };
    }),

  setMessages: (connectionId, sessionKey, msgs) =>
    set((state) => {
      const key = makeChatKey(connectionId, sessionKey);

      // Auto-title from history: use first user text message if no label exists
      let labelUpdate: Partial<AppStore> = {};
      const existingLabel = state.sessionLabelsByConnection[connectionId]?.[sessionKey];
      if (!existingLabel) {
        const firstUserMsg = msgs.find((m) => m.role === "user" && m.contentType === "text");
        if (firstUserMsg) {
          labelUpdate = {
            sessionLabelsByConnection: {
              ...state.sessionLabelsByConnection,
              [connectionId]: {
                ...(state.sessionLabelsByConnection[connectionId] ?? {}),
                [sessionKey]: autoTitle(firstUserMsg.content),
              },
            },
          };
        }
      }

      return {
        messagesByChat: { ...state.messagesByChat, [key]: msgs },
        ...labelUpdate,
      };
    }),

  // ── pet ──
  petState: "idle",
  setPetState: (s) => set({ petState: s }),

  // ── slash commands ──
  agentCommands: [],
  setAgentCommands: (cmds) => set({ agentCommands: cmds }),

  // ── views ──
  chatOpen: false,
  setChatOpen: (v) => set({ chatOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  contextMenuOpen: false,
  setContextMenuOpen: (v) => set({ contextMenuOpen: v }),

  // ── config ──
  config: null,
  setConfig: (c) => set({ config: c }),
}));
