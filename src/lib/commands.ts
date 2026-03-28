import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  ChatMessage,
  LlmMessage,
  UpdateCheckResult,
  ConnectionStatus,
  BridgeSessionsData,
} from "./types";

export async function loadConfig(): Promise<AppConfig> {
  return invoke("load_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function connectBridge(connectionId: string): Promise<void> {
  return invoke("connect_bridge", { connectionId });
}

export async function disconnectBridge(connectionId: string): Promise<void> {
  return invoke("disconnect_bridge", { connectionId });
}

export async function getBridgeStatus(): Promise<ConnectionStatus[]> {
  return invoke("get_bridge_status");
}

export async function listBridgeSessions(connectionId: string): Promise<BridgeSessionsData> {
  return invoke("list_bridge_sessions", { connectionId });
}

export async function createBridgeSession(
  connectionId: string,
  name?: string,
): Promise<void> {
  return invoke("create_bridge_session", { connectionId, name: name ?? null });
}

export async function switchBridgeSession(
  connectionId: string,
  target: string,
): Promise<void> {
  return invoke("switch_bridge_session", { connectionId, target });
}

export async function deleteBridgeSession(
  connectionId: string,
  sessionId: string,
): Promise<void> {
  return invoke("delete_bridge_session", { connectionId, sessionId });
}

export async function sendMessage(
  connectionId: string,
  text: string,
  sessionKey?: string,
  replyCtx?: string,
): Promise<void> {
  return invoke("send_message", {
    connectionId,
    text,
    sessionKey: sessionKey ?? null,
    replyCtx: replyCtx ?? null,
  });
}

export async function sendFile(
  connectionId: string,
  path: string,
  sessionKey?: string,
  replyCtx?: string,
): Promise<void> {
  return invoke("send_file", {
    connectionId,
    path,
    sessionKey: sessionKey ?? null,
    replyCtx: replyCtx ?? null,
  });
}

export async function getHistory(
  connectionId: string,
  limit: number,
  sessionKey?: string,
  beforeId?: string
): Promise<ChatMessage[]> {
  return invoke("get_history", {
    connectionId,
    sessionKey: sessionKey ?? null,
    limit,
    beforeId: beforeId ?? null,
  });
}

export async function clearHistory(connectionId?: string, _sessionKey?: string): Promise<void> {
  return invoke("clear_history", { connectionId: connectionId ?? null });
}

export async function setAlwaysOnTop(on: boolean): Promise<void> {
  return invoke("set_always_on_top", { on });
}

export async function setWindowOpacity(opacity: number): Promise<void> {
  return invoke("set_window_opacity", { opacity });
}

export async function setMainWindowSize(
  width: number,
  height: number
): Promise<void> {
  return invoke("set_main_window_size", { width, height });
}

export async function llmChat(messages: LlmMessage[]): Promise<string> {
  return invoke("llm_chat", { messages });
}

export async function llmGenerateImage(prompt: string): Promise<string> {
  return invoke("llm_generate_image", { prompt });
}

export async function revealFile(path: string): Promise<void> {
  return invoke("reveal_file", { path });
}

export async function quitApp(): Promise<void> {
  return invoke("quit_app");
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke("check_for_updates");
}
