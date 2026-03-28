import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import {
  createBridgeSession,
  deleteBridgeSession,
  listBridgeSessions,
  switchBridgeSession,
} from "@/lib/commands";

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
    connections,
    activeConnectionId,
    setActiveConnectionId,
    activeSessionByConnection,
    sessionsByConnection,
    sessionLabelsByConnection,
    sessionLastActiveByConnection,
    sessionUnreadByConnection,
    setSessions,
    setSessionLabel,
    setActiveSessionKey,
    clearSessionUnread,
    removeSession,
    hasAnyUnread,
  } = useAppStore();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowAll(false);
        setConfirmDeleteId(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) setConfirmDeleteId(null);
  }, [open]);

  const bridgeList = Object.values(connections).map((entry) => entry.config);

  if (!activeConnectionId || bridgeList.length === 0) {
    return (
      <span className="text-[12px] font-semibold text-gray-800 px-2">CC Pet</span>
    );
  }

  const activeConnection = connections[activeConnectionId];
  const activeConnectionName = activeConnection?.config.name ?? activeConnectionId;
  const isConnected = activeConnection?.connected ?? false;

  const activeSessionKey = activeSessionByConnection[activeConnectionId] ?? null;
  const allSessions = sessionsByConnection[activeConnectionId] ?? [];
  const labels = sessionLabelsByConnection[activeConnectionId] ?? {};
  const lastActive = sessionLastActiveByConnection[activeConnectionId] ?? {};
  const unread = sessionUnreadByConnection[activeConnectionId] ?? {};
  const hasUnread = hasAnyUnread();
  const totalUnread = Object.values(sessionUnreadByConnection).reduce(
    (sum, bySession) => sum + Object.values(bySession).reduce((n, c) => n + c, 0),
    0
  );

  const activeLabel = activeSessionKey
    ? (labels[activeSessionKey] || activeSessionKey.split(":").pop() || activeSessionKey)
    : null;

  const buttonLabel = bridgeList.length > 1
    ? `${activeConnectionName}${activeLabel ? ` · ${activeLabel}` : ""}`
    : (activeLabel ?? activeConnectionName);

  const inactive = allSessions
    .filter((sid) => sid !== activeSessionKey)
    .sort((a, b) => (lastActive[b] ?? 0) - (lastActive[a] ?? 0));

  const recentInactive = showAll ? inactive : inactive.slice(0, RECENT_VISIBLE);
  const hiddenCount = inactive.length - RECENT_VISIBLE;

  const otherConnections = bridgeList.filter((b) => b.id !== activeConnectionId);

  function sessionLabelText(sid: string): string {
    return labels[sid] || sid.split(":").pop() || sid;
  }

  function formatUnread(count: number): string {
    return count > 99 ? "99+" : String(count);
  }

  async function handleSwitch(sessionId: string) {
    setOpen(false);
    setShowAll(false);
    setConfirmDeleteId(null);
    setActiveSessionKey(activeConnectionId!, sessionId);
    clearSessionUnread(activeConnectionId!, sessionId);
    switchBridgeSession(activeConnectionId!, sessionId).catch(console.error);
  }

  function handleSwitchConnection(connId: string) {
    setOpen(false);
    setShowAll(false);
    setConfirmDeleteId(null);
    setActiveConnectionId(connId);
  }

  function handleDeleteClick(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    e.preventDefault();
    if (confirmDeleteId === sessionId) {
      // Second click = confirm
      if (!activeConnectionId) return;
      removeSession(activeConnectionId, sessionId);
      deleteBridgeSession(activeConnectionId, sessionId).catch(console.error);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(sessionId);
    }
  }

  async function handleNewSession() {
    if (!activeConnectionId) return;
    setOpen(false);
    setShowAll(false);
    setConfirmDeleteId(null);
    try {
      await createBridgeSession(activeConnectionId);
      const data = await listBridgeSessions(activeConnectionId);
      const ids = data.sessions.map((s) => s.id);
      const newId = data.activeSessionId ?? ids[ids.length - 1];
      setSessions(activeConnectionId, ids, data.activeSessionId ?? undefined);
      for (const s of data.sessions) {
        if (s.name && s.id !== newId) setSessionLabel(activeConnectionId, s.id, s.name);
      }
      if (newId) {
        setActiveSessionKey(activeConnectionId, newId);
        switchBridgeSession(activeConnectionId, newId).catch(console.error);
      }
    } catch (e) {
      console.error("create session failed:", e);
    }
  }

  if (allSessions.length === 0 && bridgeList.length <= 1) {
    return (
      <span className="text-[12px] font-semibold text-gray-800 px-2">CC Pet</span>
    );
  }

  function DeleteBtn({ sid, className }: { sid: string; className?: string }) {
    const confirming = confirmDeleteId === sid;
    return (
      <button
        type="button"
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onClick={(e) => handleDeleteClick(e, sid)}
        className={`items-center justify-center rounded flex-shrink-0 transition-colors ${
          confirming
            ? "flex w-auto px-1 bg-red-100 text-red-600 text-[9px]"
            : `hidden ${className ?? ""} w-4 h-4 hover:bg-red-100 text-red-400 hover:text-red-600`
        }`}
        title={confirming ? "再次点击确认删除" : "删除会话"}
      >
        {confirming ? (
          <span className="leading-none whitespace-nowrap">确认?</span>
        ) : (
          <span className="text-[10px] leading-none">✕</span>
        )}
      </button>
    );
  }

  return (
    <div ref={ref} className="relative flex items-center min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors min-w-0 max-w-[200px]"
        title={buttonLabel}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConnected ? "bg-green-500" : "bg-red-400"}`}
        />
        <span className="text-[12px] font-semibold text-gray-800 truncate">
          {buttonLabel}
        </span>
        {hasUnread && (
          <span className="inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex-shrink-0">
            {formatUnread(totalUnread)}
          </span>
        )}
        <span className="text-[9px] text-gray-400 flex-shrink-0">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-60 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">

          {/* Connection section */}
          {bridgeList.length > 1 && (
            <>
              <div className="px-3 pt-2.5 pb-1">
                <p className="text-[9px] text-gray-400 uppercase tracking-wide mb-1">连接</p>
                <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-50 rounded-lg mb-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConnected ? "bg-green-500" : "bg-red-400"}`}
                  />
                  <span className="text-[11px] text-indigo-700 font-medium truncate flex-1">
                    {activeConnectionName}
                  </span>
                </div>
                {otherConnections.map((conn) => {
                  const online = connections[conn.id]?.connected ?? false;
                  return (
                    <button
                      key={conn.id}
                      type="button"
                      onClick={() => handleSwitchConnection(conn.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors text-left"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${online ? "bg-green-500" : "bg-red-400"}`}
                      />
                      <span className="text-[11px] text-gray-600 truncate flex-1">{conn.name}</span>
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-gray-100 mx-2" />
            </>
          )}

          {/* Session section */}
          {allSessions.length > 0 && (
            <>
              {/* Current session */}
              <div className="px-3 pt-2 pb-1">
                <p className="text-[9px] text-gray-400 uppercase tracking-wide mb-1">当前会话</p>
                <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-50 rounded-lg group/active">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
                  <span className="text-[11px] text-indigo-700 font-medium truncate flex-1">
                    {activeLabel ?? "—"}
                  </span>
                  {activeSessionKey && (unread[activeSessionKey] ?? 0) > 0 && (
                    <span className="inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex-shrink-0">
                      {formatUnread(unread[activeSessionKey] ?? 0)}
                    </span>
                  )}
                  {activeSessionKey && lastActive[activeSessionKey] && confirmDeleteId !== activeSessionKey && (
                    <span className="text-[9px] text-indigo-300 flex-shrink-0 group-hover/active:hidden">
                      {formatTime(lastActive[activeSessionKey])}
                    </span>
                  )}
                  {activeSessionKey && allSessions.length > 1 && (
                    <DeleteBtn sid={activeSessionKey} className="group-hover/active:flex" />
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
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors text-left group/item"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0" />
                      <span className="text-[11px] text-gray-600 truncate flex-1">
                        {sessionLabelText(sid)}
                      </span>
                      {(unread[sid] ?? 0) > 0 && (
                        <span className="inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex-shrink-0">
                          {formatUnread(unread[sid] ?? 0)}
                        </span>
                      )}
                      {lastActive[sid] && confirmDeleteId !== sid && (
                        <span className="text-[9px] text-gray-300 flex-shrink-0 group-hover/item:hidden">
                          {formatTime(lastActive[sid])}
                        </span>
                      )}
                      <DeleteBtn sid={sid} className="group-hover/item:flex" />
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
            </>
          )}

          {/* New session */}
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
