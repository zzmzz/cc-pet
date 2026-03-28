import type { Session } from "./types";

const KEY = "cc-pet-sessions";

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Session[];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: Session[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions));
  } catch {
    // localStorage 写失败时静默忽略（隐私模式等场景）
  }
}
