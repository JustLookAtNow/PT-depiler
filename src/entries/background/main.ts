import { onMessage } from "@/messages.ts";
import { fixAllStoredUserInfo } from "./utils/fixer.ts";

import "./utils/base.ts";
import "./utils/cookies.ts";
import "./utils/offscreen.ts";
import "./utils/contextMenus.ts";
import "./utils/omnibox.ts";
import { createDailySiteCheckInJob, EJobType } from "./utils/alarms.ts";
import "./utils/webRequest.ts";

// 监听 点击图标 事件
chrome.action.onClicked.addListener(async () => {
  await chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  console.debug("[PTD] Installed!", details?.reason);
  if (details?.reason === "install") {
    await createDailySiteCheckInJob();
  }
  // 修复存储中的坏数据
  fixAllStoredUserInfo().catch();
});

onMessage("ping", async ({ data }) => {
  console.log("ping", data);
  return data ?? "pong";
});

// 恢复（重新注册）每日签到任务，防止 Service Worker 重载后丢失回调
// 保证后台脚本重载后仍存在签到任务，但避免重复日志
async function ensureDailySiteCheckInJob() {
  try {
    const alarm = await chrome.alarms.get(EJobType.DailySiteCheckIn);
    if (!alarm) {
      await createDailySiteCheckInJob();
    }
  } catch (e) {
    console.error("[PTD] Failed to ensure daily site check-in job:", e);
  }
}
// noinspection JSIgnoredPromiseFromCall
ensureDailySiteCheckInJob();
