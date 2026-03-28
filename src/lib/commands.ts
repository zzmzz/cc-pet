import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, ChatMessage, LlmMessage, UpdateCheckResult } from "./types";

export async function loadConfig(): Promise<AppConfig> {
  return invoke("load_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function connectBridge(): Promise<void> {
  return invoke("connect_bridge");
}

export async function disconnectBridge(): Promise<void> {
  return invoke("disconnect_bridge");
}

export async function getBridgeConnected(): Promise<boolean> {
  return invoke("get_bridge_connected");
}

export async function sendMessage(text: string): Promise<void> {
  return invoke("send_message", { text });
}

export async function sendFile(path: string): Promise<void> {
  return invoke("send_file", { path });
}

export async function getHistory(
  limit: number,
  beforeId?: string
): Promise<ChatMessage[]> {
  return invoke("get_history", { limit, beforeId: beforeId ?? null });
}

export async function clearHistory(): Promise<void> {
  return invoke("clear_history");
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
