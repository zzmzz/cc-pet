import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { sendMessage, switchBridgeSession } from "@/lib/commands";

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const oneDay = 86_400_000;
  if (diff < oneDay) {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < oneDay * 7) {
    const days = Math.floor(diff / oneDay);
    return days === 1 ? "昨天" : `${days}天前`;
  }
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

const RECENT_VISIBLE = 2;

export function SessionDropdown() {
  const {
    activeConnectionId,
    activeSessionByConnection,
    sessionsByConnection,
    sessionLabelsByConnection,
    sessionLastActiveByConnection,
    setActiveSessionKey,
  } = useAppStore();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowAll(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!activeConnectionId) {
    return (
      <span className="text-[12px] font-semibold text-gray-800 px-2">CC Pet</span>
    );
  }

  const activeSessionKey = activeSessionByConnection[activeConnectionId] ?? null;
  const allSessions = sessionsByConnection[activeConnectionId] ?? [];
  const labels = sessionLabelsByConnection[activeConnectionId] ?? {};
  const lastActive = sessionLastActiveByConnection[activeConnectionId] ?? {};

  const activeLabel = activeSessionKey
    ? (labels[activeSessionKey] || activeSessionKey.split(":").pop() || activeSessionKey)
    : "CC Pet";

  const inactive = allSessions
    .filter((sid) => sid !== activeSessionKey)
    .sort((a, b) => (lastActive[b] ?? 0) - (lastActive[a] ?? 0));

  const recentInactive = showAll ? inactive : inactive.slice(0, RECENT_VISIBLE);
  const hiddenCount = inactive.length - RECENT_VISIBLE;

  function sessionLabel(sid: string): string {
    return labels[sid] || sid.split(":").pop() || sid;
  }

  async function handleSwitch(sessionId: string) {
    setOpen(false);
    setShowAll(false);
    setActiveSessionKey(activeConnectionId!, sessionId);
    switchBridgeSession(activeConnectionId!, sessionId).catch(console.error);
  }

  async function handleNewSession() {
    setOpen(false);
    setShowAll(false);
    if (activeConnectionId) {
      sendMessage(activeConnectionId, "/new").catch(console.error);
    }
  }

  // Don't render the dropdown button if there are no sessions at all
  if (allSessions.length === 0) {
    return (
      <span className="text-[12px] font-semibold text-gray-800 px-2">CC Pet</span>
    );
  }

  return (
    <div ref={ref} className="relative flex items-center min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors min-w-0 max-w-[160px]"
        title={activeLabel}
      >
        <span className="text-[12px] font-semibold text-gray-800 truncate">
          {activeLabel}
        </span>
        <span className="text-[9px] text-gray-400 flex-shrink-0">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
          {/* Current session */}
          <div className="px-3 pt-2.5 pb-1">
            <p className="text-[9px] text-gray-400 uppercase tracking-wide mb-1">当前会话</p>
            <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-50 rounded-lg">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
              <span className="text-[11px] text-indigo-700 font-medium truncate flex-1">
                {activeLabel}
              </span>
              {activeSessionKey && lastActive[activeSessionKey] && (
                <span className="text-[9px] text-indigo-300 flex-shrink-0">
                  {formatTime(lastActive[activeSessionKey])}
                </span>
              )}
            </div>
          </div>

          {/* Inactive sessions */}
          {inactive.length > 0 && (
            <div className="px-3 pb-1">
              <p className="text-[9px] text-gray-400 uppercase tracking-wide mb-1">最近会话</p>
              {recentInactive.map((sid) => (
                <button
                  key={sid}
                  type="button"
                  onClick={() => handleSwitch(sid)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors text-left"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0" />
                  <span className="text-[11px] text-gray-600 truncate flex-1">
                    {sessionLabel(sid)}
                  </span>
                  {lastActive[sid] && (
                    <span className="text-[9px] text-gray-300 flex-shrink-0">
                      {formatTime(lastActive[sid])}
                    </span>
                  )}
                </button>
              ))}

              {!showAll && hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="w-full flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors text-indigo-500 text-[10px]"
                >
                  <span>▶</span>
                  <span>显示 {hiddenCount} 个更旧的会话</span>
                </button>
              )}
            </div>
          )}

          {/* Divider + New session */}
          <div className="border-t border-gray-100 mx-2" />
          <div className="px-3 py-1.5">
            <button
              type="button"
              onClick={handleNewSession}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-indigo-50 transition-colors text-indigo-600 text-[11px] font-medium"
            >
              <span>＋</span>
              <span>新建会话</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
