export type PetState = "idle" | "thinking" | "talking" | "happy" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "bot";
  content: string;
  contentType: "text" | "file" | "image";
  filePath?: string;
  timestamp: number;
}

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  platformName: string;
  userId: string;
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
  chatWindowOpacity: number;
  chatWindowWidth: number;
  chatWindowHeight: number;
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
  bridge: BridgeConfig;
  pet: PetConfig;
  llm: LlmConfig;
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
