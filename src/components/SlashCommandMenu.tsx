import { useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

export type CommandCategory = "builtin" | "session" | "agent" | "dir" | "cron" | "other";

export interface SlashCommand {
  command: string;
  description: string;
  category: CommandCategory;
  /** "local" runs a client action; "send" dispatches the text to the agent */
  type: "local" | "send";
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { command: "/clear", description: "清空聊天记录", category: "builtin", type: "local" },
  { command: "/settings", description: "打开设置面板", category: "builtin", type: "local" },
  { command: "/connect", description: "连接 cc-connect Bridge", category: "builtin", type: "local" },
  { command: "/disconnect", description: "断开 cc-connect Bridge", category: "builtin", type: "local" },
];

export const CC_CONNECT_COMMANDS: SlashCommand[] = [
  // Session
  { command: "/new", description: "开始新会话 /new [name]", category: "session", type: "send" },
  { command: "/list", description: "列出所有会话", category: "session", type: "send" },
  { command: "/switch", description: "切换会话 /switch <id>", category: "session", type: "send" },
  { command: "/current", description: "当前会话信息", category: "session", type: "send" },
  { command: "/history", description: "查看最近消息 /history [n]", category: "session", type: "send" },
  { command: "/stop", description: "停止当前执行", category: "session", type: "send" },

  // Agent control
  { command: "/model", description: "查看/切换模型 /model [switch <alias>]", category: "agent", type: "send" },
  { command: "/mode", description: "查看/切换权限模式 /mode [yolo|default|plan]", category: "agent", type: "send" },
  { command: "/reasoning", description: "调整推理级别 /reasoning [level]", category: "agent", type: "send" },
  { command: "/provider", description: "管理 API 提供商 /provider [list|switch]", category: "agent", type: "send" },
  { command: "/allow", description: "预授权工具 /allow <tool>", category: "agent", type: "send" },
  { command: "/quiet", description: "切换思考/工具进度消息", category: "agent", type: "send" },

  // Work directory
  { command: "/dir", description: "查看/切换工作目录 /dir [path]", category: "dir", type: "send" },
  { command: "/cd", description: "/dir 的兼容别名 /cd <path>", category: "dir", type: "send" },

  // Cron
  { command: "/cron", description: "管理定时任务 /cron [add|del|enable|disable]", category: "cron", type: "send" },
  { command: "/cron setup", description: "刷新 agent 指令（含附件回传）", category: "cron", type: "send" },

  // Other
  { command: "/help", description: "显示所有可用命令", category: "other", type: "send" },
  { command: "/usage", description: "显示账户/模型配额使用情况", category: "other", type: "send" },
  { command: "/bind", description: "管理多机器人绑定 /bind [project|setup]", category: "other", type: "send" },
  { command: "/workspace", description: "多工作区管理 /workspace [bind|list]", category: "other", type: "send" },
];

const CATEGORY_LABELS: Record<string, string> = {
  builtin: "CC Pet",
  session: "会话管理",
  agent: "Agent 控制",
  dir: "工作目录",
  cron: "定时任务",
  other: "其他",
};

interface SlashCommandMenuProps {
  query: string;
  visible: boolean;
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  extraCommands?: SlashCommand[];
}

export function useSlashMenu(input: string) {
  const isActive = useMemo(() => {
    const trimmed = input.trimStart();
    return trimmed.startsWith("/");
  }, [input]);

  const query = useMemo(() => {
    if (!isActive) return "";
    return input.trimStart().slice(1).toLowerCase();
  }, [isActive, input]);

  return { isActive, query };
}

export function SlashCommandMenu({
  query,
  visible,
  selectedIndex,
  onSelect,
  extraCommands = [],
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const allCommands = useMemo(
    () => [...BUILTIN_COMMANDS, ...CC_CONNECT_COMMANDS, ...extraCommands],
    [extraCommands]
  );

  const filtered = useMemo(() => {
    if (!query) return allCommands;
    return allCommands.filter(
      (cmd) =>
        cmd.command.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query)
    );
  }, [query, allCommands]);

  const grouped = useMemo(() => {
    const groups: Record<string, SlashCommand[]> = {};
    for (const cmd of filtered) {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filtered]);

  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const setItemRef = useCallback(
    (flatIdx: number, el: HTMLDivElement | null) => {
      if (el) itemRefs.current.set(flatIdx, el);
      else itemRefs.current.delete(flatIdx);
    },
    []
  );

  if (!visible || filtered.length === 0) return null;

  let flatIdx = 0;

  return (
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.15 }}
        className="slash-menu"
      >
        {Object.entries(grouped).map(([category, cmds]) => (
          <div key={category}>
            <div className="slash-menu-category">
              {CATEGORY_LABELS[category] || category}
            </div>
            {cmds.map((cmd) => {
              const idx = flatIdx++;
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={cmd.command}
                  ref={(el) => setItemRef(idx, el)}
                  className={`slash-menu-item ${isSelected ? "slash-menu-item-active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(cmd);
                  }}
                >
                  <span className="slash-menu-cmd">{cmd.command}</span>
                  <span className="slash-menu-desc">{cmd.description}</span>
                </div>
              );
            })}
          </div>
        ))}
      </motion.div>
    </AnimatePresence>
  );
}

export function getFilteredCommands(
  query: string,
  extraCommands: SlashCommand[] = []
): SlashCommand[] {
  const all = [...BUILTIN_COMMANDS, ...CC_CONNECT_COMMANDS, ...extraCommands];
  if (!query) return all;
  return all.filter(
    (cmd) =>
      cmd.command.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
  );
}
