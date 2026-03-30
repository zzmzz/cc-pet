export type PetState = "idle" | "thinking" | "talking" | "happy" | "error";

export type SessionTaskPhase =
  | "idle"
  | "thinking"
  | "working"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "stalled";

export type SessionTaskStalledReason =
  | "first_token_timeout"
  | "stream_idle_timeout";

export interface SessionTaskState {
  activeRequestId: string | null;
  phase: SessionTaskPhase;
  startedAt: number | null;
  lastActivityAt: number | null;
  firstTokenAt: number | null;
  stalledReason: SessionTaskStalledReason | null;
}

export interface ChatButtonOption {
  text: string;
  data: string;
}

export interface ChatMessage {
  id: string;
  connectionId: string;
  sessionKey: string;
  replyCtx?: string;
  role: "user" | "bot";
  content: string;
  contentType: "text" | "file" | "image" | "buttons";
  buttons?: ChatButtonOption[][];
  filePath?: string;
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastActiveAt: number;
}

export interface BridgeConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  platformName: string;
  userId: string;
  sshTunnel?: SshTunnelConfig;
}

export interface SshTunnelConfig {
  enabled: boolean;
  bastionHost: string;
  bastionPort: number;
  bastionUser: string;
  targetHost: string;
  targetPort: number;
  localHost: string;
  localPort: number;
  identityFile: string;
  strictHostKeyChecking: boolean;
}

export interface SshTunnelStatus {
  id: string;
  running: boolean;
}


export interface PetAppearance {
  idle?: string;
  thinking?: string;
  talking?: string;
  happy?: string;
  error?: string;
}

export interface PetConfig {
  size: number;
  alwaysOnTop: boolean;
  launchOnStartup: boolean;
  chatWindowOpacity: number;
  chatWindowWidth: number;
  chatWindowHeight: number;
  toggleVisibilityShortcut: string;
  firstTokenTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  appearance?: PetAppearance;
}

export interface LlmConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  imageModel?: string;
  enabled: boolean;
}

export interface AppConfig {
  bridges: BridgeConfig[];
  pet: PetConfig;
  llm: LlmConfig;
}

export interface ConnectionStatus {
  id: string;
  name: string;
  connected: boolean;
}

export interface BridgeSession {
  id: string;
  name: string;
  historyCount: number;
}

export interface BridgeSessionsData {
  sessions: BridgeSession[];
  activeSessionId?: string;
}

export interface LocalSessionsData {
  sessions: BridgeSession[];
  activeSessionId?: string;
  lastActiveMap: Record<string, number>;
}

export type ChatMode = "bridge" | "llm";

export interface LlmMessage {
  role: string;
  content: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseNotes?: string;
}

export interface LinkPreviewData {
  url: string;
  finalUrl: string;
  title?: string;
  description?: string;
  siteName?: string;
  isFile?: boolean;
  fileName?: string;
}

