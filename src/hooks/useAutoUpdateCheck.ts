import { useCallback, useEffect, useState } from "react";
import { checkForUpdates } from "@/lib/commands";
import { readDismissedVersion } from "@/components/UpdateNotice";

/** 首次启动后延迟，避免与 Bridge 连接等抢网络 */
const START_DELAY_MS = 8_000;
/** 周期性探测间隔 */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

export function useAutoUpdateCheck() {
  const [notice, setNotice] = useState<{
    latestVersion: string;
    releaseUrl: string;
  } | null>(null);

  const run = useCallback(async () => {
    if (import.meta.env.DEV) return;
    try {
      const r = await checkForUpdates();
      if (!r.updateAvailable) return;
      if (readDismissedVersion() === r.latestVersion) return;
      setNotice({ latestVersion: r.latestVersion, releaseUrl: r.releaseUrl });
    } catch {
      /* 忽略网络错误 */
    }
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    const t1 = window.setTimeout(run, START_DELAY_MS);
    const t2 = window.setInterval(run, INTERVAL_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearInterval(t2);
    };
  }, [run]);

  return { notice, clearNotice: () => setNotice(null) };
}
