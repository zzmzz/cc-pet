import { useEffect, useLayoutEffect, useRef, useCallback, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore, makeChatKey } from "@/lib/store";
import {
  sendMessage,
  sendFile,
  clearHistory,
  revealFile,
  connectBridge,
  disconnectBridge,
  listBridgeSessions,
  getHistory,
  fetchLinkPreview,
} from "@/lib/commands";
import { runManualUpdateCheckWithDialogs } from "@/lib/manualUpdateCheck";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatMessage, LinkPreviewData } from "@/lib/types";
import { SlashCommandMenu, useSlashMenu, getFilteredCommands } from "./SlashCommandMenu";
import type { SlashCommand } from "./SlashCommandMenu";
import { SessionDropdown } from "./SessionDropdown";

const NEAR_BOTTOM_PX = 72;
const FILE_LINK_EXTS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mp3", "wav",
  "apk", "exe", "dmg", "msi",
]);
const LINK_PREVIEW_CACHE = new Map<string, LinkPreviewData | null>();
const LINK_PREVIEW_INFLIGHT = new Map<string, Promise<LinkPreviewData | null>>();

function isNearBottom(el: HTMLDivElement, threshold = NEAR_BOTTOM_PX) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function parseUrl(href?: string): URL | null {
  const cleanedHref = normalizeHref(href);
  if (!cleanedHref) return null;
  try {
    return new URL(cleanedHref);
  } catch {
    return null;
  }
}

function normalizeHref(href?: string): string {
  if (!href) return "";
  const trimmed = href.trim().replace(/(?:%20)+$/gi, "");
  if (!trimmed) return "";
  return splitUrlTrailingNote(trimmed)?.url ?? trimmed;
}

function getNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map((item) => getNodeText(item)).join("");
  if (typeof node === "object" && "props" in node) {
    const el = node as { props?: { children?: ReactNode } };
    return getNodeText(el.props?.children);
  }
  return "";
}

function isFileLikeLink(url: URL): boolean {
  const path = url.pathname || "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (FILE_LINK_EXTS.has(ext)) return true;
  const q = url.search.toLowerCase();
  return q.includes("download=") || q.includes("filename=");
}

function getDisplayFileName(url: URL): string {
  const seg = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
  if (seg) return seg;
  const filename = url.searchParams.get("filename");
  if (filename) return filename;
  return "下载文件";
}

function normalizeLinkDisplayText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([（(\[【《])/g, "$1")
    .replace(/([（(\[【《])\s+/g, "$1")
    .replace(/\s+([）)\]】》])/g, "$1")
    .trim();
}

function splitUrlTrailingNote(text: string): { url: string; note: string } | null {
  if (!text.startsWith("http")) return null;
  if (!text.endsWith("）")) return null;
  const idx = text.lastIndexOf("（");
  if (idx <= 0) return null;
  const urlPart = text.slice(0, idx);
  const note = text.slice(idx);
  if (note.length > 40) return null;
  if (!parseUrl(urlPart)) return null;
  return { url: urlPart, note };
}

function getReadablePath(url: URL): string {
  const pathname = normalizeLinkDisplayText(decodeURIComponent(url.pathname || "/"));
  if (!pathname || pathname === "/") return "";
  if (pathname.length <= 28) return pathname;
  return `${pathname.slice(0, 25)}...`;
}

function getReadableLinkTitle(url: URL): string {
  const host = url.hostname.replace(/^www\./, "");
  const pathname = decodeURIComponent(url.pathname || "");
  if (!pathname || pathname === "/") return host;
  const last = pathname.split("/").filter(Boolean).pop() || "";
  const fromLast = normalizeLinkDisplayText(last.replace(/[-_]+/g, " "));
  if (fromLast) return fromLast;
  return `${host}${getReadablePath(url)}`;
}

async function loadLinkPreview(url: string): Promise<LinkPreviewData | null> {
  if (LINK_PREVIEW_CACHE.has(url)) {
    return LINK_PREVIEW_CACHE.get(url) ?? null;
  }
  const existing = LINK_PREVIEW_INFLIGHT.get(url);
  if (existing) return existing;
  const task = fetchLinkPreview(url)
    .then((data) => {
      LINK_PREVIEW_CACHE.set(url, data);
      LINK_PREVIEW_INFLIGHT.delete(url);
      return data;
    })
    .catch(() => {
      LINK_PREVIEW_CACHE.set(url, null);
      LINK_PREVIEW_INFLIGHT.delete(url);
      return null;
    });
  LINK_PREVIEW_INFLIGHT.set(url, task);
  return task;
}

function LinkPreviewAnchor({ href, children }: { href?: string; children: ReactNode }) {
  const normalizedHref = normalizeHref(href);
  const parsed = parseUrl(normalizedHref);
  if (!parsed || !normalizedHref) {
    return <span>{children}</span>;
  }
  const childText = getNodeText(children).trim();
  const isRawHref =
    !childText ||
    childText === href ||
    childText === normalizedHref ||
    childText === decodeURIComponent(href ?? "") ||
    childText === decodeURIComponent(normalizedHref) ||
    childText === parsed.toString();
  const prettyTitle = getReadableLinkTitle(parsed);
  const fallbackTitle = isRawHref ? prettyTitle : childText;
  const fileLike = isFileLikeLink(parsed);
  const [preview, setPreview] = useState<LinkPreviewData | null>(() => LINK_PREVIEW_CACHE.get(normalizedHref) ?? null);
  const previewIndicatesFile = Boolean(preview?.isFile);

  useEffect(() => {
    if (fileLike) return;
    let cancelled = false;
    void loadLinkPreview(normalizedHref).then((data) => {
      if (!cancelled) setPreview(data);
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedHref, fileLike]);

  if (fileLike || previewIndicatesFile) {
    const effectiveUrl = parseUrl(preview?.finalUrl) ?? parsed;
    const fileName = preview?.fileName?.trim() || getDisplayFileName(effectiveUrl);
    const host = effectiveUrl.hostname.replace(/^www\./, "");
    const fileTitle = preview?.title?.trim() || fileName || fallbackTitle;
    return (
      <a href={preview?.finalUrl || normalizedHref} download={fileName || true} className="link-preview-card file-link-card">
        <span className="link-preview-badge">下载文件</span>
        <span className="link-preview-title">{fileTitle}</span>
        <span className="link-preview-meta">{fileName} · {host}</span>
      </a>
    );
  }

  const effectiveUrl = parseUrl(preview?.finalUrl) ?? parsed;
  const title = preview?.title?.trim() || fallbackTitle;
  const description = preview?.description?.trim() || "";
  const siteName = preview?.siteName?.trim() || effectiveUrl.hostname.replace(/^www\./, "");

  return (
    <a href={normalizedHref} target="_blank" rel="noopener noreferrer" className="link-preview-card">
      <span className="link-preview-title">{title}</span>
      <span className="link-preview-meta">
        {siteName}
        {getReadablePath(effectiveUrl) ? ` · ${getReadablePath(effectiveUrl)}` : ""}
      </span>
      {description ? <span className="link-preview-desc">{description}</span> : null}
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="code-copy-btn"
      title="复制代码"
    >
      {copied ? "✓ 已复制" : "复制"}
    </button>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

  if (msg.contentType === "file") {
    const canOpen = !isUser && msg.filePath;
    return (
      <div
        className={`flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1`}
      >
        <div
          className={`${
            isUser
              ? "bg-blue-50 border-blue-200 text-blue-700"
              : "bg-green-50 border-green-200 text-green-700"
          } border rounded-lg px-3 py-2 text-sm flex items-center gap-2 max-w-[80%] ${
            canOpen ? "cursor-pointer hover:brightness-95 active:brightness-90 transition-all" : ""
          }`}
          onClick={() => {
            if (canOpen) {
              revealFile(msg.filePath!).catch(console.error);
            }
          }}
        >
          <span>{isUser ? "📎" : "📥"}</span>
          <span className="truncate">{msg.filePath ? msg.filePath.split(/[/\\]/).pop() : msg.content}</span>
          {canOpen && (
            <span className="text-[10px] text-green-500 whitespace-nowrap">点击打开</span>
          )}
        </div>
      </div>
    );
  }

  if (msg.contentType === "image") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
        className={`flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1`}
      >
        <div className="max-w-[85%] rounded-2xl px-4 py-2.5 bg-gray-100 text-gray-800 rounded-bl-md">
          <img
            src={msg.content}
            alt="Generated"
            className="rounded-lg max-w-full max-h-80 object-contain"
            loading="lazy"
          />
          <div className="text-[10px] mt-1 text-gray-400">
            {new Date(msg.timestamp).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.2 }}
      className={`flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1`}
    >
      <div
        className={`max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed ${
          isUser
            ? "bg-indigo-500 text-white rounded-br-md"
            : "bg-gray-100 text-gray-800 rounded-bl-md markdown-body"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                const codeStr = String(children).replace(/\n$/, "");
                if (match) {
                  return (
                    <div className="code-block-wrapper">
                      <div className="code-block-header">
                        <span className="code-block-lang">{match[1]}</span>
                        <CopyButton text={codeStr} />
                      </div>
                      <SyntaxHighlighter
                        style={oneDark}
                        language={match[1]}
                        PreTag="div"
                        wrapLongLines
                        customStyle={{
                          borderRadius: "0 0 8px 8px",
                          margin: 0,
                          fontSize: "12.5px",
                        }}
                      >
                        {codeStr}
                      </SyntaxHighlighter>
                    </div>
                  );
                }
                return (
                  <code
                    className="bg-slate-100 text-rose-600 px-1.5 py-0.5 rounded text-[0.9em]"
                    {...props}
                  >
                    {children}
                  </code>
                );
              },
              a({ href, children }) {
                const rawText = getNodeText(children).trim();
                const trailingNote = splitUrlTrailingNote(rawText);
                if (trailingNote) {
                  return (
                    <>
                      <LinkPreviewAnchor href={trailingNote.url}>{trailingNote.url}</LinkPreviewAnchor>
                      <span>{trailingNote.note}</span>
                    </>
                  );
                }
                return <LinkPreviewAnchor href={href}>{children}</LinkPreviewAnchor>;
              },
            }}
          >
            {msg.content.replace(/\n/g, "  \n")}
          </ReactMarkdown>
        )}
        <div
          className={`text-[10px] mt-1 ${
            isUser ? "text-indigo-200" : "text-gray-400"
          }`}
        >
          {new Date(msg.timestamp).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </motion.div>
  );
}

export function ChatWindow({ petSize = 120 }: { petSize?: number }) {
  const {
    activeConnectionId,
    activeSessionByConnection,
    setSessions,
    setSessionLabel,
    messagesByChat,
    setMessages,
    chatOpen,
    setChatOpen,
    setSettingsOpen,
    addMessage,
    updateMessage,
    clearMessages,
    clearSessionUnread,
    setPetState,
    agentCommands,
  } = useAppStore();

  const activeSessionKey = activeConnectionId
    ? (activeSessionByConnection[activeConnectionId] ?? null)
    : null;

  const messages =
    activeConnectionId && activeSessionKey
      ? (messagesByChat[makeChatKey(activeConnectionId, activeSessionKey)] ?? [])
      : [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const bridgeStreamBotIdRef = useRef<string | null>(null);

  const { isActive: slashMenuVisible, query: slashQuery } = useSlashMenu(input);

  const scrollMessagesToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const syncScrollFlags = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stickToBottomRef.current = near;
    setShowJumpLatest(!near);
  }, []);

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    scrollMessagesToBottom();
    setShowJumpLatest(false);
  }, [scrollMessagesToBottom]);

  useLayoutEffect(() => {
    if (!chatOpen) return;
    stickToBottomRef.current = true;
    scrollMessagesToBottom();
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      scrollMessagesToBottom();
      raf2 = requestAnimationFrame(() => {
        scrollMessagesToBottom();
        syncScrollFlags();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [chatOpen, scrollMessagesToBottom, syncScrollFlags]);

  useEffect(() => {
    if (!chatOpen) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, chatOpen]);

  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stickToBottomRef.current = near;
    setShowJumpLatest(!near);
  }, []);

  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  // 当激活连接变化时，从后端拉取会话列表
  useEffect(() => {
    if (!activeConnectionId) return;
    listBridgeSessions(activeConnectionId)
      .then((data) => {
        setSessions(
          activeConnectionId,
          data.sessions.map((s) => s.id),
          data.activeSessionId ?? undefined
        );
        for (const s of data.sessions) {
          if (s.name) setSessionLabel(activeConnectionId, s.id, s.name);
        }
      })
      .catch(() => undefined);
  }, [activeConnectionId, setSessions, setSessionLabel]);

  // 当激活会话变化且消息为空时，加载历史记录
  useEffect(() => {
    if (!activeConnectionId || !activeSessionKey) return;
    const key = makeChatKey(activeConnectionId, activeSessionKey);
    const current = messagesByChat[key];
    if (current && current.length > 0) return;
    getHistory(activeConnectionId, 50, activeSessionKey)
      .then((msgs) => {
        if (msgs.length > 0) setMessages(activeConnectionId, activeSessionKey, msgs);
      })
      .catch(() => undefined);
  }, [activeConnectionId, activeSessionKey, setMessages, messagesByChat]);

  // 聊天打开且会话有效时，清除当前会话未读
  useEffect(() => {
    if (!chatOpen || !activeConnectionId || !activeSessionKey) return;
    clearSessionUnread(activeConnectionId, activeSessionKey);
  }, [chatOpen, activeConnectionId, activeSessionKey, clearSessionUnread]);

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    async function setup() {
      const u3 = await listen<{
        connectionId: string;
        sessionKey: string;
        replyCtx?: string;
        delta: string;
      }>("bridge-stream-delta", (e) => {
        if (cancelled) return;
        const store = useAppStore.getState();
        const { connectionId, sessionKey, delta } = e.payload;
        let id = bridgeStreamBotIdRef.current;
        if (!id) {
          const activeSession = store.activeSessionByConnection[connectionId];
          const shouldMarkUnread = !store.chatOpen || activeSession !== sessionKey;
          if (shouldMarkUnread) {
            store.markSessionUnread(connectionId, sessionKey);
          }
          id = `bot-bridge-${Date.now()}`;
          bridgeStreamBotIdRef.current = id;
          store.addMessage(connectionId, sessionKey, {
            id,
            connectionId,
            sessionKey,
            role: "bot",
            content: delta,
            contentType: "text",
            timestamp: Date.now(),
          });
          if (!shouldMarkUnread) {
            store.setPetState("talking");
          }
        } else {
          const chatKey = makeChatKey(connectionId, sessionKey);
          const prev =
            (store.messagesByChat[chatKey] ?? []).find((m) => m.id === id)?.content || "";
          store.updateMessage(connectionId, sessionKey, id, { content: prev + delta });
        }
      });
      if (cancelled) { u3(); return; }
      unlistenFns.push(u3);

      const u4 = await listen<{
        connectionId: string;
        sessionKey: string;
        replyCtx?: string;
        fullText: string;
      }>("bridge-stream-done", (e) => {
        if (cancelled) return;
        const store = useAppStore.getState();
        const { connectionId, sessionKey, fullText } = e.payload;
        const id = bridgeStreamBotIdRef.current;
        if (id) {
          if (fullText.length > 0) {
            store.updateMessage(connectionId, sessionKey, id, { content: fullText });
          }
          bridgeStreamBotIdRef.current = null;
        } else if (fullText.length > 0) {
          const activeSession = store.activeSessionByConnection[connectionId];
          const shouldMarkUnread = !store.chatOpen || activeSession !== sessionKey;
          if (shouldMarkUnread) {
            store.markSessionUnread(connectionId, sessionKey);
          }
          store.addMessage(connectionId, sessionKey, {
            id: `bot-${Date.now()}`,
            connectionId,
            sessionKey,
            role: "bot",
            content: fullText,
            contentType: "text",
            timestamp: Date.now(),
          });
        } else {
          bridgeStreamBotIdRef.current = null;
        }
        if (store.hasAnyUnread()) {
          store.setPetState("talking");
        } else {
          store.setPetState("idle");
        }
      });
      if (cancelled) { u4(); return; }
      unlistenFns.push(u4);
    }

    setup();

    return () => {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    };
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeConnectionId || !activeSessionKey) return;
    setInput("");

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
      role: "user",
      content: text,
      contentType: "text",
      timestamp: Date.now(),
    };
    addMessage(activeConnectionId, activeSessionKey, userMsg);

    setPetState("thinking");
    try {
      await sendMessage(activeConnectionId, text, activeSessionKey);
    } catch (e) {
      console.error("send failed:", e);
      setPetState("error");
      setTimeout(() => setPetState("idle"), 3000);
    }
  }, [input, activeConnectionId, activeSessionKey, addMessage, setPetState]);

  const handleAttach = useCallback(async () => {
    if (!activeConnectionId || !activeSessionKey) return;
    const selected = await open({ multiple: false });
    if (selected) {
      const path = String(selected);
      addMessage(activeConnectionId, activeSessionKey, {
        id: `file-${Date.now()}`,
        connectionId: activeConnectionId,
        sessionKey: activeSessionKey,
        role: "user",
        content: path.split(/[/\\]/).pop() || "file",
        contentType: "file",
        filePath: path,
        timestamp: Date.now(),
      });
      try {
        await sendFile(activeConnectionId, path, activeSessionKey);
      } catch (e) {
        console.error("send file failed:", e);
      }
    }
  }, [activeConnectionId, activeSessionKey, addMessage]);

  const handleSlashSelect = useCallback(
    async (cmd: SlashCommand) => {
      setInput("");
      setSlashIndex(0);

      if (cmd.type === "local") {
        switch (cmd.command) {
          case "/clear":
            if (activeConnectionId && activeSessionKey) {
              clearHistory(activeConnectionId).catch(console.error);
              clearMessages(activeConnectionId, activeSessionKey);
            }
            break;
          case "/settings":
            setSettingsOpen(true);
            break;
          case "/connect":
            if (activeConnectionId) connectBridge(activeConnectionId).catch(console.error);
            break;
          case "/disconnect":
            if (activeConnectionId) disconnectBridge(activeConnectionId).catch(console.error);
            break;
        }
      } else if (activeConnectionId && activeSessionKey) {
        const userMsg: ChatMessage = {
          id: `user-${Date.now()}`,
          connectionId: activeConnectionId,
          sessionKey: activeSessionKey,
          role: "user",
          content: cmd.command,
          contentType: "text",
          timestamp: Date.now(),
        };
        addMessage(activeConnectionId, activeSessionKey, userMsg);
        setPetState("thinking");
        try {
          await sendMessage(activeConnectionId, cmd.command, activeSessionKey);
        } catch (e) {
          console.error("send failed:", e);
          setPetState("error");
          setTimeout(() => setPetState("idle"), 3000);
        }
      }

      inputRef.current?.focus();
    },
    [activeConnectionId, activeSessionKey, addMessage, setPetState, clearMessages, setSettingsOpen]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slashMenuVisible) {
        const filtered = getFilteredCommands(slashQuery, agentCommands);
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((prev) => (prev + 1) % filtered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (filtered[slashIndex]) {
            handleSlashSelect(filtered[slashIndex]);
          }
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          if (filtered[slashIndex]) {
            setInput(filtered[slashIndex].command + " ");
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setInput("");
          return;
        }
      }

      if (e.key === "Enter") {
        if (e.ctrlKey || e.shiftKey || e.metaKey) {
          return;
        }
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape") {
        setChatOpen(false);
      }
    },
    [handleSend, setChatOpen, slashMenuVisible, slashQuery, slashIndex, agentCommands, handleSlashSelect]
  );

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  return (
    <AnimatePresence>
      {chatOpen && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="absolute inset-0 flex flex-col bg-white/[0.97] backdrop-blur-sm rounded-2xl border border-gray-200 shadow-2xl overflow-hidden z-10"
        >
          {/* Title bar */}
          <div
            className="flex items-center h-11 px-4 border-b border-gray-100 shrink-0 cursor-grab active:cursor-grabbing"
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              const target = e.target as HTMLElement;
              if (target.closest("button") || target.closest("input") || target.closest("textarea")) return;
              e.preventDefault();
              getCurrentWindow().startDragging().catch(console.error);
            }}
            data-tauri-drag-region
          >
            <SessionDropdown />
            <div className="flex-1" data-tauri-drag-region />
            <button
              type="button"
              title="检查更新"
              disabled={updateChecking}
              onClick={() => {
                void (async () => {
                  setUpdateChecking(true);
                  try {
                    await runManualUpdateCheckWithDialogs();
                  } finally {
                    setUpdateChecking(false);
                  }
                })();
              }}
              className="text-[11px] text-gray-400 hover:text-indigo-500 transition-colors mr-2 disabled:opacity-50"
            >
              {updateChecking ? "…" : "更新"}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-[11px] text-gray-400 hover:text-indigo-500 transition-colors mr-2"
            >
              设置
            </button>
            <button
              onClick={() => {
                if (activeConnectionId && activeSessionKey) {
                  clearHistory(activeConnectionId).catch(console.error);
                  clearMessages(activeConnectionId, activeSessionKey);
                }
              }}
              className="text-[11px] text-gray-400 hover:text-red-500 transition-colors mr-2"
            >
              清空
            </button>
            <button
              onClick={() => setChatOpen(false)}
              className="text-gray-400 hover:text-gray-600 transition-colors text-lg leading-none"
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 min-h-0 relative flex flex-col">
            <div
              ref={scrollRef}
              onScroll={onMessagesScroll}
              className="flex-1 min-h-0 overflow-y-auto py-3 space-y-1"
            >
              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full text-gray-300 text-sm">
                  双击宠物开始聊天
                </div>
              )}
              {messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
            </div>
            {showJumpLatest && (
              <button
                type="button"
                onClick={jumpToLatest}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 rounded-full bg-indigo-500 text-white text-xs font-semibold px-4 py-2 shadow-lg shadow-indigo-500/25 hover:bg-indigo-600 transition-colors"
              >
                查看最新
              </button>
            )}
          </div>

          {/* Input — left padding reserves space for the pet in the corner */}
          <div className="border-t border-gray-100 p-3 shrink-0 relative" style={{ paddingLeft: petSize + 8 }}>
            <SlashCommandMenu
              query={slashQuery}
              visible={slashMenuVisible}
              selectedIndex={slashIndex}
              onSelect={handleSlashSelect}
              extraCommands={agentCommands}
            />
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-[13.5px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-gray-400"
              rows={3}
            />
            <div className="flex items-center mt-2">
              <button
                onClick={handleAttach}
                className="text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
              >
                📎 文件
              </button>
              <div className="flex-1" />
              <button
                onClick={handleSend}
                disabled={!input.trim() || !activeConnectionId || !activeSessionKey}
                className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg px-5 py-1.5 transition-colors"
              >
                发送
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
