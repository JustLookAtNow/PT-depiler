import { format } from "date-fns";
import { defineJobScheduler } from "@webext-core/job-scheduler";
import { EResultParseStatus, type TSiteID } from "@ptd/site/types/base.ts";

import { extStorage } from "@/storage.ts";
import { IDownloadTorrentToClientOption, IDownloadTorrentToLocalFile, onMessage, sendMessage } from "@/messages.ts";

import { setupOffscreenDocument } from "./offscreen.ts";

export enum EJobType {
  FlushUserInfo = "flushUserInfo",
  ReDownloadTorrentToDownloader = "reDownloadTorrentToDownloader",
  ReDownloadTorrentToLocalFile = "reDownloadTorrentToLocalFile",
  DailySiteCheckIn = "dailySiteCheckIn",
}

const jobs = defineJobScheduler();

export async function createFlushUserInfoJob() {
  await setupOffscreenDocument();
  const configStore = (await extStorage.getItem("config"))!;

  // 获取自动刷新参数
  const {
    enabled = false,
    interval = 1,
    retry: { max: retryMax = 0, interval: retryInterval = 5 } = {},
  } = configStore?.userInfo?.autoReflush ?? {};

  function autoFlushUserInfo(retryIndex: number = 0) {
    return async () => {
      const curDate = new Date();
      const curDateFormat = format(curDate, "yyyy-MM-dd");
      sendMessage("logger", {
        msg: `Auto-refreshing user information at ${curDateFormat}${retryIndex > 0 ? `(Retry #${retryIndex})` : ""}`,
      }).catch();

      let metadataStore = (await extStorage.getItem("metadata"))!;

      // 遍历 metadataStore 中添加的站点
      const flushPromises = [];
      const failFlushSites: TSiteID[] = [];
      for (const siteId of Object.keys(metadataStore.sites)) {
        flushPromises.push(
          new Promise(async (resolve, reject) => {
            try {
              const siteConfig = await sendMessage("getSiteUserConfig", { siteId });
              if (!siteConfig.isOffline && siteConfig.allowQueryUserInfo) {
                // 检查当天的记录是否存在
                const thisSiteUserInfo = await sendMessage("getSiteUserInfo", siteId);
                if (typeof thisSiteUserInfo[curDateFormat] === "undefined") {
                  const userInfoResult = await sendMessage("getSiteUserInfoResult", siteId);
                  if (userInfoResult.status !== EResultParseStatus.success) {
                    failFlushSites.push(siteId);
                    reject(siteId); // 仅有刷新失败的时候才reject
                  }
                }
              }
              resolve(siteId); // 其他状态（刷新成功、已有当天记录、不设置刷新）均视为resolve
            } catch (e) {
              reject(siteId); // 如果获取站点配置失败，则reject
            }
          }),
        );
      }

      // 等待所有刷新操作完成
      await Promise.allSettled(flushPromises);
      sendMessage("logger", {
        msg: `Auto-refreshing user information finished, ${flushPromises.length} sites processed, ${failFlushSites.length} failed.`,
        data: { failFlushSites },
      }).catch();

      // 将刷新时间存入 metadataStore
      metadataStore = (await extStorage.getItem("metadata"))!;
      metadataStore.lastUserInfoAutoFlushAt = curDate.getTime();
      await extStorage.setItem("metadata", metadataStore);

      // 如果本次有失败的刷新操作，则设置重试
      if (failFlushSites.length > 0 && retryIndex < retryMax) {
        sendMessage("logger", {
          msg: `Retrying auto-refresh for ${failFlushSites.length} failed sites in ${retryInterval} minutes (Retry #${retryIndex + 1})`,
        }).catch();
        await jobs.scheduleJob({
          id: EJobType.FlushUserInfo + "-Retry-" + retryIndex,
          type: "once",
          date: +curDate + retryInterval * 60 * 1000, // retryInterval in minutes
          execute: autoFlushUserInfo(retryIndex + 1),
        });
      }
    };
  }

  if (enabled) {
    await jobs.scheduleJob({
      id: EJobType.FlushUserInfo,
      type: "interval",
      duration: 1000 * 60 * 60 * interval, // interval in hours
      immediate: true,
      execute: autoFlushUserInfo(),
    });
  }
}

export async function cleanupFlushUserInfoJob() {
  // @webext-core/job-scheduler 没有提供已添加的任务列表的 API，我们只能通过 chrome.alarms API 来获取
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    if (alarm.name.startsWith(EJobType.FlushUserInfo)) {
      await jobs.removeJob(alarm.name);
    }
  }
  sendMessage("logger", { msg: "All flush user info jobs have been cleaned up." }).catch();
}

onMessage("cleanupFlushUserInfoJob", async () => await cleanupFlushUserInfoJob());

export async function setFlushUserInfoJob() {
  await cleanupFlushUserInfoJob();
  await createFlushUserInfoJob();
  sendMessage("logger", { msg: `Flush user info job has been set successfully.` }).catch();
}

onMessage("setFlushUserInfoJob", async () => await setFlushUserInfoJob());

// noinspection JSIgnoredPromiseFromCall
createFlushUserInfoJob();

// 创建站点签到定时任务
export async function createDailySiteCheckInJob() {
  await setupOffscreenDocument();
  // 先清理已存在的同名任务，防止重复调度
  await cleanupDailySiteCheckInJob();

  async function doSiteCheckIn() {
    const curDate = new Date();
    const curDateFormat = format(curDate, "yyyy-MM-dd");
    sendMessage("logger", {
      msg: `Daily site check-in at ${curDateFormat}`,
    }).catch();

    let metadataStore = (await extStorage.getItem("metadata"))!;

    // 遍历 metadataStore 中添加的站点
    const checkInPromises = [];
    const successResults: { siteId: TSiteID; message: string }[] = [];
    const failCheckInSites: TSiteID[] = [];
    for (const siteId of Object.keys(metadataStore.sites)) {
      checkInPromises.push(
        new Promise(async (resolve, reject) => {
          try {
            const siteConfig = await sendMessage("getSiteUserConfig", { siteId });
            if (!siteConfig.isOffline) {
              try {
                const checkInResult = await sendMessage("attendance", siteId);
                sendMessage("logger", {
                  msg: `Check-in result for ${siteId}: ${checkInResult}`,
                }).catch();
              } catch (e) {
                failCheckInSites.push(siteId);
                sendMessage("logger", {
                  msg: `Failed to check-in for site ${siteId}`,
                  level: "error",
                }).catch();
                reject(siteId);
              }
            }
            resolve(siteId);
          } catch (e) {
            reject(siteId);
          }
        }),
      );
    }

    // 等待所有签到操作完成
    await Promise.allSettled(checkInPromises);
    sendMessage("logger", {
      msg: `Daily site check-in finished, ${checkInPromises.length} sites processed, ${failCheckInSites.length} failed.`,
      data: { failCheckInSites, successResults },
    }).catch();
  }

  // 设置每天8:30执行签到
  const now = new Date();
  const checkInTime = new Date(now);
  checkInTime.setHours(8, 30, 0, 0);

  // 如果当前时间已经过了今天的签到时间，则设置为明天
  if (now > checkInTime) {
    checkInTime.setDate(checkInTime.getDate() + 1);
  }

  await jobs.scheduleJob({
    id: EJobType.DailySiteCheckIn,
    type: "once",
    date: checkInTime.getTime(), // 指定首次执行时间
    execute: async () => {
      await doSiteCheckIn();
      // 安排下一次签到（24 小时后，同一时间）
      await jobs.scheduleJob({
        id: EJobType.DailySiteCheckIn,
        type: "once",
        date: Date.now() + 24 * 60 * 60 * 1000,
        execute: async () => {
          // 递归触发下一次
          await doSiteCheckIn();
        },
      });
    },
  });

  sendMessage("logger", {
    msg: `Daily site check-in job has been scheduled at ${format(checkInTime, "yyyy-MM-dd HH:mm:ss")}`,
  }).catch();
}

export async function cleanupDailySiteCheckInJob() {
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    if (alarm.name.startsWith(EJobType.DailySiteCheckIn)) {
      await jobs.removeJob(alarm.name);
    }
  }
  sendMessage("logger", { msg: "All daily site check-in jobs have been cleaned up." }).catch();
}

export async function setDailySiteCheckInJob() {
  await cleanupDailySiteCheckInJob();
  await createDailySiteCheckInJob();
  sendMessage("logger", { msg: `Daily site check-in job has been set successfully.` }).catch();
}

onMessage("setDailySiteCheckInJob", async () => await setDailySiteCheckInJob());
onMessage("cleanupDailySiteCheckInJob", async () => await cleanupDailySiteCheckInJob());

// 初始化时启动签到定时任务
// noinspection JSIgnoredPromiseFromCall
createDailySiteCheckInJob();

function doReDownloadTorrentToDownloader(option: IDownloadTorrentToClientOption) {
  return async () => {
    await setupOffscreenDocument();
    // 按照相同的方式重新下载种子到下载器
    await sendMessage("downloadTorrentToDownloader", option);
  };
}

onMessage("reDownloadTorrentToDownloader", async ({ data }) => {
  jobs
    .scheduleJob({
      id: EJobType.ReDownloadTorrentToDownloader + "-" + data.downloadId!,
      type: "once",
      date: Date.now() + 1000 * 30, // 0.5 minute later
      execute: doReDownloadTorrentToDownloader(data),
    })
    .catch(() => {
      sendMessage("setDownloadHistoryStatus", { downloadId: data.downloadId!, status: "failed" }).catch();
    });
});

function doReDownloadTorrentToLocalFile(option: IDownloadTorrentToLocalFile) {
  return async () => {
    await setupOffscreenDocument();
    await sendMessage("downloadTorrentToLocalFile", option);
  };
}

onMessage("reDownloadTorrentToLocalFile", async ({ data }) => {
  jobs
    .scheduleJob({
      id: EJobType.ReDownloadTorrentToLocalFile + "-" + data.downloadId!,
      type: "once",
      date: Date.now() + 1000 * 30, // 0.5 minute later
      execute: doReDownloadTorrentToLocalFile(data),
    })
    .catch(() => {
      sendMessage("setDownloadHistoryStatus", { downloadId: data.downloadId!, status: "failed" }).catch();
    });
});
