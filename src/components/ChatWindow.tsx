import { useEffect, useRef, useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/lib/store";
import {
  sendMessage,
  sendFile,
  clearHistory,
  revealFile,
  connectBridge,
  disconnectBridge,
} from "@/lib/commands";
import { runManualUpdateCheckWithDialogs } from "@/lib/manualUpdateCheck";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatMessage } from "@/lib/types";
import { SlashCommandMenu, useSlashMenu, getFilteredCommands } from "./SlashCommandMenu";
import type { SlashCommand } from "./SlashCommandMenu";

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
                return (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {children}
                  </a>
                );
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
    messagesByConnection,
    chatOpen,
    setChatOpen,
    setSettingsOpen,
    connections,
    activeConnectionId,
    setActiveConnectionId,
    addMessage,
    updateMessage,
    clearMessages,
    setPetState,
    agentCommands,
  } = useAppStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [updateChecking, setUpdateChecking] = useState(false);
  const bridgeStreamBotIdRef = useRef<Record<string, string | null>>({});
  const messages = activeConnectionId
    ? messagesByConnection[activeConnectionId] ?? []
    : [];

  const { isActive: slashMenuVisible, query: slashQuery } = useSlashMenu(input);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    async function setup() {
      const u3 = await listen<{ connectionId: string; delta: string }>(
        "bridge-stream-delta",
        (e) => {
          if (cancelled) return;
          const store = useAppStore.getState();
          const { connectionId, delta } = e.payload;
          let id = bridgeStreamBotIdRef.current[connectionId];
          if (!id) {
            id = `bot-bridge-${Date.now()}`;
            bridgeStreamBotIdRef.current[connectionId] = id;
            store.addMessage(connectionId, {
              id,
              connectionId,
              role: "bot",
              content: delta,
              contentType: "text",
              timestamp: Date.now(),
            });
            store.setPetState("talking");
          } else {
            const prev =
              (store.messagesByConnection[connectionId] ?? []).find(
                (m) => m.id === id
              )?.content || "";
            store.updateMessage(connectionId, id, { content: prev + delta });
          }
        }
      );
      if (cancelled) { u3(); return; }
      unlistenFns.push(u3);

      const u4 = await listen<{ connectionId: string; fullText: string }>(
        "bridge-stream-done",
        (e) => {
          if (cancelled) return;
          const store = useAppStore.getState();
          const { connectionId, fullText } = e.payload;
          const id = bridgeStreamBotIdRef.current[connectionId];
          if (id) {
            if (fullText.length > 0) {
              store.updateMessage(connectionId, id, { content: fullText });
            }
            bridgeStreamBotIdRef.current[connectionId] = null;
          } else if (fullText.length > 0) {
            store.addMessage(connectionId, {
              id: `bot-${Date.now()}`,
              connectionId,
              role: "bot",
              content: fullText,
              contentType: "text",
              timestamp: Date.now(),
            });
          } else {
            bridgeStreamBotIdRef.current[connectionId] = null;
          }
          store.setPetState("idle");
        }
      );
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
    if (!activeConnectionId) return;
    const text = input.trim();
    if (!text) return;
    setInput("");

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      connectionId: activeConnectionId,
      role: "user",
      content: text,
      contentType: "text",
      timestamp: Date.now(),
    };
    addMessage(activeConnectionId, userMsg);

    setPetState("thinking");
    try {
      await sendMessage(activeConnectionId, text);
    } catch (e) {
      console.error("send failed:", e);
      setPetState("error");
      setTimeout(() => setPetState("idle"), 3000);
    }
  }, [activeConnectionId, input, addMessage, setPetState]);

  const handleAttach = useCallback(async () => {
    if (!activeConnectionId) return;
    const selected = await open({ multiple: false });
    if (selected) {
      const path = typeof selected === "string" ? selected : selected;
      addMessage(activeConnectionId, {
        id: `file-${Date.now()}`,
        connectionId: activeConnectionId,
        role: "user",
        content: String(path).split("/").pop() || "file",
        contentType: "file",
        filePath: String(path),
        timestamp: Date.now(),
      });
      try {
        await sendFile(activeConnectionId, String(path));
      } catch (e) {
        console.error("send file failed:", e);
      }
    }
  }, [activeConnectionId, addMessage]);

  const handleSlashSelect = useCallback(
    async (cmd: SlashCommand) => {
      setInput("");
      setSlashIndex(0);

      if (cmd.type === "local") {
        switch (cmd.command) {
          case "/clear":
            if (activeConnectionId) {
              clearHistory(activeConnectionId);
              clearMessages(activeConnectionId);
            }
            break;
          case "/settings":
            setSettingsOpen(true);
            break;
          case "/connect":
            if (activeConnectionId) {
              connectBridge(activeConnectionId).catch(console.error);
            }
            break;
          case "/disconnect":
            if (activeConnectionId) {
              disconnectBridge(activeConnectionId).catch(console.error);
            }
            break;
        }
      } else {
        if (!activeConnectionId) return;
        const userMsg: ChatMessage = {
          id: `user-${Date.now()}`,
          connectionId: activeConnectionId,
          role: "user",
          content: cmd.command,
          contentType: "text",
          timestamp: Date.now(),
        };
        addMessage(activeConnectionId, userMsg);
        setPetState("thinking");
        try {
          await sendMessage(activeConnectionId, cmd.command);
        } catch (e) {
          console.error("send failed:", e);
          setPetState("error");
          setTimeout(() => setPetState("idle"), 3000);
        }
      }

      inputRef.current?.focus();
    },
    [activeConnectionId, addMessage, setPetState, clearMessages, setSettingsOpen]
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

  const isConnected = activeConnectionId
    ? connections[activeConnectionId]?.connected ?? false
    : false;
  const bridgeList = Object.values(connections).map((entry) => entry.config);

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
            <span className="font-bold text-gray-800 text-sm">CC Pet</span>
            <span
              className={`ml-2 w-2 h-2 rounded-full ${
                isConnected ? "bg-green-500" : "bg-red-400"
              }`}
            />
            <span className="ml-1.5 text-[11px] text-gray-400">
              {isConnected ? "已连接" : "未连接"}
            </span>
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
                if (activeConnectionId) {
                  clearHistory(activeConnectionId);
                  clearMessages(activeConnectionId);
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
          {/* Connection Tabs */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-100 overflow-x-auto">
            {bridgeList.map((bridge) => {
              const active = activeConnectionId === bridge.id;
              const online = connections[bridge.id]?.connected ?? false;
              return (
                <button
                  key={bridge.id}
                  onClick={() => setActiveConnectionId(bridge.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs border transition-colors whitespace-nowrap ${
                    active
                      ? "bg-indigo-50 text-indigo-600 border-indigo-200"
                      : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${
                      online ? "bg-green-500" : "bg-red-400"
                    }`}
                  />
                  {bridge.name}
                </button>
              );
            })}
            <button
              onClick={() => setSettingsOpen(true)}
              className="px-2 py-1 rounded-lg text-xs text-gray-500 border border-gray-200 hover:bg-gray-50"
            >
              + 添加
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto py-3 space-y-1">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full text-gray-300 text-sm">
                双击宠物开始聊天
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
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
                disabled={!input.trim() || !activeConnectionId}
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
