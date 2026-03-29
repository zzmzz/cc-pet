import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "@/lib/store";
import {
  connectBridge,
  disconnectBridge,
  getSshTunnelStatus,
  saveConfig,
  startSshTunnel,
  stopSshTunnel,
  setAlwaysOnTop,
  setWindowOpacity,
} from "@/lib/commands";
import type { AppConfig, BridgeConfig, PetAppearance, SshTunnelConfig } from "@/lib/types";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { runManualUpdateCheckWithDialogs } from "@/lib/manualUpdateCheck";

function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeBridges(config: AppConfig): AppConfig {
  const bridges = Array.isArray(config.bridges) ? config.bridges : [];
  return { ...config, bridges };
}

function createBridge(): BridgeConfig {
  return {
    id: makeId(),
    name: "新连接",
    host: "127.0.0.1",
    port: 9810,
    token: "",
    platformName: "desktop-pet",
    userId: "pet-user",
    sshTunnel: defaultSshTunnel(),
  };
}

function defaultSshTunnel(): SshTunnelConfig {
  return {
    enabled: false,
    bastionHost: "",
    bastionPort: 22,
    bastionUser: "",
    targetHost: "192.168.8.2",
    targetPort: 9810,
    localHost: "127.0.0.1",
    localPort: 9810,
    identityFile: "",
    strictHostKeyChecking: true,
  };
}

export function Settings() {
  const {
    settingsOpen,
    setSettingsOpen,
    config,
    setConfig,
    setConnections,
    connections,
  } = useAppStore();
  const [form, setForm] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"bridge" | "pet">("bridge");
  const [appVersion, setAppVersion] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [tunnelStatus, setTunnelStatus] = useState<Record<string, boolean>>({});
  const [tunnelBusy, setTunnelBusy] = useState<Record<string, boolean>>({});
  const [tunnelError, setTunnelError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (config && settingsOpen) {
      const safe = normalizeBridges(config);
      setForm(JSON.parse(JSON.stringify(safe)));
    }
  }, [config, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("—"));
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    void getSshTunnelStatus()
      .then((items) => {
        const next: Record<string, boolean> = {};
        for (const item of items) next[item.id] = item.running;
        setTunnelStatus(next);
      })
      .catch(() => undefined);
  }, [settingsOpen]);

  if (!form) return null;

  const APPEARANCE_ROWS: { key: keyof PetAppearance; label: string }[] = [
    { key: "idle", label: "空闲" },
    { key: "thinking", label: "思考" },
    { key: "talking", label: "说话" },
    { key: "happy", label: "开心" },
    { key: "error", label: "错误" },
  ];

  const setAppearance = (key: keyof PetAppearance, path: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as AppConfig;
      next.pet.appearance = {
        ...(next.pet.appearance ?? {}),
        [key]: path,
      };
      return next;
    });
  };

  const pickAppearance = async (key: keyof PetAppearance) => {
    const picked = await open({
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
        },
      ],
    });
    if (typeof picked === "string" && picked.length > 0) {
      setAppearance(key, picked);
    }
  };

  const update = (path: string, value: string | number | boolean) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split(".");
      let obj: Record<string, unknown> = next;
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]] as Record<string, unknown>;
      }
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const updateBridge = (
    index: number,
    field: keyof BridgeConfig,
    value: string | number | SshTunnelConfig
  ) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as AppConfig;
      const bridges = Array.isArray(next.bridges) ? next.bridges : [];
      if (!bridges[index]) return next;
      bridges[index][field] = value as never;
      return next;
    });
  };

  const updateTunnel = (
    index: number,
    field: keyof SshTunnelConfig,
    value: string | number | boolean
  ) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as AppConfig;
      const bridges = Array.isArray(next.bridges) ? next.bridges : [];
      const bridge = bridges[index];
      if (!bridge) return next;
      const tunnel = bridge.sshTunnel ?? defaultSshTunnel();
      bridge.sshTunnel = {
        ...tunnel,
        [field]: value as never,
      };
      return next;
    });
  };

  const toggleTunnel = async (bridgeId: string, running: boolean) => {
    setTunnelBusy((prev) => ({ ...prev, [bridgeId]: true }));
    setTunnelError((prev) => ({ ...prev, [bridgeId]: "" }));
    try {
      if (running) {
        await stopSshTunnel(bridgeId);
        setTunnelStatus((prev) => ({ ...prev, [bridgeId]: false }));
      } else {
        const bridge = (form?.bridges ?? []).find((b) => b.id === bridgeId);
        await startSshTunnel(bridgeId, bridge?.sshTunnel ?? defaultSshTunnel());
        setTunnelStatus((prev) => ({ ...prev, [bridgeId]: true }));
      }
    } catch (e) {
      console.error("toggle ssh tunnel failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      setTunnelError((prev) => ({ ...prev, [bridgeId]: msg || "启动隧道失败" }));
    } finally {
      setTunnelBusy((prev) => ({ ...prev, [bridgeId]: false }));
    }
  };

  const addBridge = () => {
    setForm((prev) => {
      if (!prev) return prev;
      const bridges = Array.isArray(prev.bridges) ? prev.bridges : [];
      return {
        ...prev,
        bridges: [...bridges, createBridge()],
      };
    });
  };

  const removeBridge = (id: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      const bridges = Array.isArray(prev.bridges) ? prev.bridges : [];
      return {
        ...prev,
        bridges: bridges.filter((b) => b.id !== id),
      };
    });
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await saveConfig(form);
      setConfig(form);
      const bridges = Array.isArray(form.bridges) ? form.bridges : [];
      setConnections(bridges);
      await setAlwaysOnTop(form.pet.alwaysOnTop);
      await setWindowOpacity(form.pet.chatWindowOpacity);

      const oldIds = Object.keys(connections);
      for (const id of oldIds) {
        await disconnectBridge(id).catch(() => undefined);
      }
      for (const bridge of bridges) {
        if (bridge.token.trim()) {
          await connectBridge(bridge.id).catch(console.error);
        }
      }
      setSettingsOpen(false);
    } catch (e) {
      console.error("save config failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    { key: "bridge" as const, label: "Bridge" },
    { key: "pet" as const, label: "宠物" },
  ];

  return (
    <AnimatePresence>
      {settingsOpen && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="fixed inset-0 flex flex-col bg-white/[0.98] backdrop-blur-sm rounded-2xl border border-gray-200 shadow-2xl overflow-hidden z-[70]"
          style={{ width: 480, height: 640 }}
        >
          {/* Title */}
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
            <span className="font-bold text-gray-800 text-sm">设置</span>
            <div className="flex-1" data-tauri-drag-region />
            <button
              onClick={() => setSettingsOpen(false)}
              className="text-gray-400 hover:text-gray-600 transition-colors text-lg leading-none"
            >
              ✕
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-100 px-4">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                  tab === t.key
                    ? "text-indigo-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {t.label}
                {tab === t.key && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 rounded-full"
                  />
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Bridge Tab */}
            {tab === "bridge" && (
              <section>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">
                  cc-connect Bridge
                </h3>
                <div className="space-y-4">
                  {(Array.isArray(form.bridges) ? form.bridges : []).map((bridge, index) => (
                    <div
                      key={bridge.id}
                      className="rounded-xl border border-gray-200 p-3 space-y-3"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          value={bridge.name}
                          onChange={(e) =>
                            updateBridge(index, "name", e.target.value)
                          }
                          className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                          placeholder="连接名称"
                        />
                        <button
                          type="button"
                          onClick={() => removeBridge(bridge.id)}
                          className="text-xs px-2 py-1 rounded text-red-500 hover:bg-red-50"
                        >
                          删除
                        </button>
                      </div>
                      <Field
                        label="Host"
                        value={bridge.host}
                        onChange={(v) => updateBridge(index, "host", v)}
                      />
                      <Field
                        label="Port"
                        value={String(bridge.port)}
                        onChange={(v) =>
                          updateBridge(index, "port", parseInt(v) || 9810)
                        }
                        type="number"
                      />
                      <Field
                        label="Token"
                        value={bridge.token}
                        onChange={(v) => updateBridge(index, "token", v)}
                        type="password"
                      />
                      <Field
                        label="Platform Name"
                        value={bridge.platformName}
                        onChange={(v) => updateBridge(index, "platformName", v)}
                      />
                      <Field
                        label="User ID"
                        value={bridge.userId}
                        onChange={(v) => updateBridge(index, "userId", v)}
                      />
                      <div className="rounded-lg border border-gray-100 p-2 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-gray-600">
                            SSH 跳板映射
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              updateTunnel(
                                index,
                                "enabled",
                                !(bridge.sshTunnel ?? defaultSshTunnel()).enabled
                              )
                            }
                            className={`relative w-10 h-5 rounded-full transition-colors ${
                              (bridge.sshTunnel ?? defaultSshTunnel()).enabled
                                ? "bg-indigo-500"
                                : "bg-gray-300"
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                                (bridge.sshTunnel ?? defaultSshTunnel()).enabled
                                  ? "translate-x-5"
                                  : ""
                              }`}
                            />
                          </button>
                        </div>
                        {(bridge.sshTunnel ?? defaultSshTunnel()).enabled && (
                          <div className="space-y-2">
                            <Field
                              label="Bastion Host"
                              value={(bridge.sshTunnel ?? defaultSshTunnel()).bastionHost}
                              onChange={(v) => updateTunnel(index, "bastionHost", v)}
                            />
                            <Field
                              label="Bastion Port"
                              value={String((bridge.sshTunnel ?? defaultSshTunnel()).bastionPort)}
                              onChange={(v) =>
                                updateTunnel(index, "bastionPort", parseInt(v) || 22)
                              }
                              type="number"
                            />
                            <Field
                              label="Bastion User"
                              value={(bridge.sshTunnel ?? defaultSshTunnel()).bastionUser}
                              onChange={(v) => updateTunnel(index, "bastionUser", v)}
                            />
                            <Field
                              label="Target Host"
                              value={(bridge.sshTunnel ?? defaultSshTunnel()).targetHost}
                              onChange={(v) => updateTunnel(index, "targetHost", v)}
                            />
                            <Field
                              label="Target Port"
                              value={String((bridge.sshTunnel ?? defaultSshTunnel()).targetPort)}
                              onChange={(v) =>
                                updateTunnel(index, "targetPort", parseInt(v) || 9810)
                              }
                              type="number"
                            />
                            <Field
                              label="Local Host"
                              value={(bridge.sshTunnel ?? defaultSshTunnel()).localHost}
                              onChange={(v) => updateTunnel(index, "localHost", v)}
                            />
                            <Field
                              label="Local Port"
                              value={String((bridge.sshTunnel ?? defaultSshTunnel()).localPort)}
                              onChange={(v) =>
                                updateTunnel(index, "localPort", parseInt(v) || 9810)
                              }
                              type="number"
                            />
                            <Field
                              label="Identity File"
                              value={(bridge.sshTunnel ?? defaultSshTunnel()).identityFile}
                              onChange={(v) => updateTunnel(index, "identityFile", v)}
                              placeholder="C:\\Users\\xxx\\.ssh\\id_ed25519"
                            />
                            <p className="text-[11px] text-gray-400 pl-[7rem]">
                              留空将使用系统默认 SSH 私钥（~/.ssh/id_ed25519 等）
                            </p>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-gray-600">严格校验主机指纹</span>
                              <button
                                type="button"
                                onClick={() =>
                                  updateTunnel(
                                    index,
                                    "strictHostKeyChecking",
                                    !(bridge.sshTunnel ?? defaultSshTunnel())
                                      .strictHostKeyChecking
                                  )
                                }
                                className={`relative w-10 h-5 rounded-full transition-colors ${
                                  (bridge.sshTunnel ?? defaultSshTunnel())
                                    .strictHostKeyChecking
                                    ? "bg-indigo-500"
                                    : "bg-gray-300"
                                }`}
                              >
                                <span
                                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                                    (bridge.sshTunnel ?? defaultSshTunnel())
                                      .strictHostKeyChecking
                                      ? "translate-x-5"
                                      : ""
                                  }`}
                                />
                              </button>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void toggleTunnel(
                                    bridge.id,
                                    Boolean(tunnelStatus[bridge.id])
                                  )
                                }
                                disabled={Boolean(tunnelBusy[bridge.id])}
                                className="text-xs px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                              >
                                {tunnelBusy[bridge.id]
                                  ? "处理中..."
                                  : tunnelStatus[bridge.id]
                                    ? "停止隧道"
                                    : "启动隧道"}
                              </button>
                              <span className="text-[11px] text-gray-500">
                                状态：{tunnelStatus[bridge.id] ? "运行中" : "未运行"}
                              </span>
                            </div>
                            {tunnelError[bridge.id] ? (
                              <p className="text-[11px] text-red-500">
                                错误：{tunnelError[bridge.id]}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addBridge}
                    className="text-xs px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
                  >
                    + 添加连接
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-2">
                  需要在 cc-connect 的 config.toml 中启用 [bridge] 并设置 port
                  和 token
                </p>
              </section>
            )}

            {/* Pet Tab */}
            {tab === "pet" && (
              <section>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">
                  宠物设置
                </h3>
                <div className="space-y-3">
                  <Field
                    label="宠物大小"
                    value={String(form.pet.size)}
                    onChange={(v) =>
                      update("pet.size", parseInt(v) || 120)
                    }
                    type="number"
                    suffix="px"
                  />

                  <div className="flex items-center justify-between">
                    <label className="text-sm text-gray-600">始终置顶</label>
                    <button
                      onClick={() =>
                        update("pet.alwaysOnTop", !form.pet.alwaysOnTop)
                      }
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        form.pet.alwaysOnTop ? "bg-indigo-500" : "bg-gray-300"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                          form.pet.alwaysOnTop ? "translate-x-5" : ""
                        }`}
                      />
                    </button>
                  </div>

                  <Field
                    label="隐藏/显示快捷键"
                    value={form.pet.toggleVisibilityShortcut || "Ctrl+Shift+H"}
                    onChange={(v) => update("pet.toggleVisibilityShortcut", v)}
                    placeholder="例如 Ctrl+Shift+H"
                  />

                  <Field
                    label="首包超时(ms)"
                    value={String(form.pet.firstTokenTimeoutMs ?? 0)}
                    onChange={(v) => update("pet.firstTokenTimeoutMs", Math.max(0, parseInt(v) || 0))}
                    type="number"
                  />

                  <Field
                    label="流式静默超时(ms)"
                    value={String(form.pet.streamIdleTimeoutMs ?? 0)}
                    onChange={(v) => update("pet.streamIdleTimeoutMs", Math.max(0, parseInt(v) || 0))}
                    type="number"
                  />

                  <p className="text-[11px] text-gray-400 pl-[7rem]">
                    默认 0 表示不设超时
                  </p>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm text-gray-600">
                        聊天窗口透明度
                      </label>
                      <span className="text-xs text-gray-400">
                        {Math.round(form.pet.chatWindowOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={100}
                      value={Math.round(form.pet.chatWindowOpacity * 100)}
                      onChange={(e) =>
                        update(
                          "pet.chatWindowOpacity",
                          parseInt(e.target.value) / 100
                        )
                      }
                      className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                  </div>

                  <div className="pt-3 border-t border-gray-100">
                    <h4 className="text-xs font-semibold text-gray-600 mb-2">
                      按状态形象（可选，留空为内置像素角色）
                    </h4>
                    <div className="space-y-2">
                      {APPEARANCE_ROWS.map((row) => (
                        <div
                          key={row.key}
                          className="flex flex-col gap-0.5 border border-gray-100 rounded-lg p-2"
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-600 w-20 shrink-0">
                              {row.label}
                            </span>
                            <button
                              type="button"
                              onClick={() => void pickAppearance(row.key)}
                              className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-700"
                            >
                              选择图片
                            </button>
                            <button
                              type="button"
                              onClick={() => setAppearance(row.key, "")}
                              className="text-xs px-2 py-1 rounded text-gray-500 hover:bg-gray-100"
                            >
                              清除
                            </button>
                          </div>
                          {form.pet.appearance?.[row.key] ? (
                            <p className="text-[10px] text-gray-400 truncate pl-0.5">
                              {form.pet.appearance[row.key]}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}

            <section>
              <div className="rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-3 space-y-2">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  关于
                </h3>
                <p className="text-sm text-gray-600">
                  当前版本{" "}
                  <span className="font-mono text-gray-800">
                    {appVersion || "…"}
                  </span>
                </p>
                <button
                  type="button"
                  disabled={checkingUpdate}
                  onClick={() => {
                    void (async () => {
                      setCheckingUpdate(true);
                      try {
                        await runManualUpdateCheckWithDialogs();
                      } finally {
                        setCheckingUpdate(false);
                      }
                    })();
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
                >
                  {checkingUpdate ? "检查中…" : "检查更新"}
                </button>
              </div>
            </section>
          </div>

          {/* Actions */}
          <div className="border-t border-gray-100 p-4 flex justify-end gap-3 shrink-0">
            <button
              onClick={() => setSettingsOpen(false)}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 rounded-lg transition-colors"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  suffix,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  suffix?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-sm text-gray-600 w-28 shrink-0 text-right">
        {label}
      </label>
      <div className="flex-1 relative">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-gray-400"
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
