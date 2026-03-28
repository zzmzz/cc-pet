import { message, ask } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { checkForUpdates } from "./commands";

/** 手动检查更新：系统对话框提示结果，若有新版本可打开 Release 页 */
export async function runManualUpdateCheckWithDialogs(): Promise<void> {
  try {
    const r = await checkForUpdates();
    if (r.updateAvailable) {
      const ok = await ask(
        `发现新版本 ${r.latestVersion}，是否打开下载页面？`,
        { title: "检查更新", kind: "info" }
      );
      if (ok) {
        await openUrl(r.releaseUrl);
      }
    } else {
      await message(`当前已是最新版本（${r.latestVersion}）。`, {
        title: "检查更新",
        kind: "info",
      });
    }
  } catch {
    await message("检查失败，请确认网络连接后重试。", {
      title: "检查更新",
      kind: "error",
    });
  }
}
