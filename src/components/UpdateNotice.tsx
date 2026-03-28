import { motion } from "framer-motion";
import { open } from "@tauri-apps/plugin-shell";

const DISMISS_KEY = "cc-pet-update-dismissed-version";

export function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function dismissUpdateVersion(version: string) {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* ignore */
  }
}

type Props = {
  latestVersion: string;
  releaseUrl: string;
  onDismiss: () => void;
};

export function UpdateNotice({ latestVersion, releaseUrl, onDismiss }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed top-0 left-0 right-0 z-[60] flex items-center justify-center gap-2 px-2 py-1.5 bg-amber-50/95 border-b border-amber-200/80 text-xs text-amber-900 shadow-sm pointer-events-auto"
    >
      <span className="font-medium shrink-0">新版本 {latestVersion} 已发布</span>
      <button
        type="button"
        onClick={() => void open(releaseUrl)}
        className="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700 transition-colors shrink-0"
      >
        前往下载
      </button>
      <button
        type="button"
        onClick={() => {
          dismissUpdateVersion(latestVersion);
          onDismiss();
        }}
        className="text-amber-700/80 hover:text-amber-900 px-1 shrink-0"
      >
        稍后
      </button>
    </motion.div>
  );
}
