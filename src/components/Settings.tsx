import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "@/lib/store";
import {
  connectBridge,
  disconnectBridge,
  saveConfig,
  setAlwaysOnTop,
  setWindowOpacity,
} from "@/lib/commands";
import type { AppConfig, PetAppearance } from "@/lib/types";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { runManualUpdateCheckWithDialogs } from "@/lib/manualUpdateCheck";

export function Settings() {
  const { settingsOpen, setSettingsOpen, config, setConfig } = useAppStore();
  const [form, setForm] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"bridge" | "pet">("bridge");
  const [appVersion, setAppVersion] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    if (config && settingsOpen) {
      setForm(JSON.parse(JSON.stringify(config)));
    }
  }, [config, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("—"));
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

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await saveConfig(form);
      setConfig(form);
      await setAlwaysOnTop(form.pet.alwaysOnTop);
      await setWindowOpacity(form.pet.chatWindowOpacity);
      // Reload bridge connection immediately after settings change.
      await disconnectBridge().catch(() => undefined);
      if (form.bridge.token.trim()) {
        await connectBridge().catch(console.error);
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
          className="fixed inset-0 flex flex-col bg-white/[0.98] backdrop-blur-sm rounded-2xl border border-gray-200 shadow-2xl overflow-hidden z-50"
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

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Bridge Tab */}
            {tab === "bridge" && (
              <section>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">
                  cc-connect Bridge
                </h3>
                <div className="space-y-3">
                  <Field
                    label="Host"
                    value={form.bridge.host}
                    onChange={(v) => update("bridge.host", v)}
                  />
                  <Field
                    label="Port"
                    value={String(form.bridge.port)}
                    onChange={(v) =>
                      update("bridge.port", parseInt(v) || 9810)
                    }
                    type="number"
                  />
                  <Field
                    label="Token"
                    value={form.bridge.token}
                    onChange={(v) => update("bridge.token", v)}
                    type="password"
                  />
                  <Field
                    label="Platform Name"
                    value={form.bridge.platformName}
                    onChange={(v) => update("bridge.platformName", v)}
                  />
                  <Field
                    label="User ID"
                    value={form.bridge.userId}
                    onChange={(v) => update("bridge.userId", v)}
                  />
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
          </div>

          <div className="border-t border-gray-100 px-5 py-3 space-y-2 shrink-0 bg-gray-50/50">
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
