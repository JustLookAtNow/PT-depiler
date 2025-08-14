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
  RetryCheckIn = "retryCheckIn",
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

// 存储失败站点的重试信息
const retryCheckInMap = new Map<TSiteID, number>();

// 重试签到函数
async function retryCheckIn(siteId: TSiteID) {
  const retryCount = retryCheckInMap.get(siteId) || 0;

  if (retryCount >= 3) {
    // 已达到最大重试次数，从重试列表中移除
    retryCheckInMap.delete(siteId);
    sendMessage("logger", {
      msg: `Site ${siteId} check-in failed after 3 retries, giving up.`,
      level: "error",
    }).catch();
    return;
  }

  try {
    const siteConfig = await sendMessage("getSiteUserConfig", { siteId });
    if (!siteConfig.isOffline) {
      try {
        const checkInResult = await sendMessage("attendance", siteId);
        sendMessage("logger", {
          msg: `Retry check-in success for ${siteId}: ${checkInResult}`,
        }).catch();
        // 成功后从重试列表中移除
        retryCheckInMap.delete(siteId);
      } catch (e) {
        // 更新重试次数
        retryCheckInMap.set(siteId, retryCount + 1);
        sendMessage("logger", {
          msg: `Retry check-in failed for site ${siteId}, attempt ${retryCount + 1}/3`,
          level: "error",
        }).catch();

        // 安排下一次重试（一小时后）
        await jobs.scheduleJob({
          id: `${EJobType.RetryCheckIn}-${siteId}-${retryCount + 1}`,
          type: "once",
          date: Date.now() + 60 * 60 * 1000, // 1小时后
          execute: async () => {
            await retryCheckIn(siteId);
          },
        });
      }
    }
  } catch (e) {
    sendMessage("logger", {
      msg: `Error getting site config for ${siteId} during retry`,
      level: "error",
    }).catch();
  }
}

// 站点签到函数
async function doSiteCheckIn() {
  const curDate = new Date();
  const curDateFormat = format(curDate, "yyyy-MM-dd HH:mm:ss");
  sendMessage("logger", {
    msg: `Starting daily site check-in at ${curDateFormat}`,
    level: "info",
  }).catch();

  try {
    let metadataStore = (await extStorage.getItem("metadata"))!;

    // 遍历 metadataStore 中添加的站点
    const checkInPromises = [];
    const successResults: { siteId: TSiteID; message: string }[] = [];
    const failCheckInSites: TSiteID[] = [];

    // 记录站点数量
    const siteCount = Object.keys(metadataStore.sites).length;
    sendMessage("logger", {
      msg: `Found ${siteCount} sites to check-in`,
      level: "info",
    }).catch();

    for (const siteId of Object.keys(metadataStore.sites)) {
      checkInPromises.push(
        new Promise(async (resolve, reject) => {
          try {
            const siteConfig = await sendMessage("getSiteUserConfig", { siteId });
            if (!siteConfig.isOffline) {
              try {
                const checkInResult = await sendMessage("attendance", siteId);
                successResults.push({ siteId, message: checkInResult });
                sendMessage("logger", {
                  msg: `Check-in result for ${siteId}: ${checkInResult}`,
                  level: "info",
                }).catch();
                resolve(siteId);
              } catch (e) {
                failCheckInSites.push(siteId);
                sendMessage("logger", {
                  msg: `Failed to check-in for site ${siteId}: ${e}`,
                  level: "error",
                }).catch();
                reject(siteId);
              }
            } else {
              sendMessage("logger", {
                msg: `Site ${siteId} is offline, skipping check-in`,
                level: "info",
              }).catch();
              resolve(siteId);
            }
          } catch (e) {
            sendMessage("logger", {
              msg: `Error getting site config for ${siteId}: ${e}`,
              level: "error",
            }).catch();
            reject(siteId);
          }
        }),
      );
    }

    // 等待所有签到操作完成
    await Promise.allSettled(checkInPromises);
    sendMessage("logger", {
      msg: `Daily site check-in finished, ${checkInPromises.length} sites processed, ${successResults.length} succeeded, ${failCheckInSites.length} failed.`,
      level: "info",
      data: { failCheckInSites, successResults },
    }).catch();

    // 为失败的站点安排重试
    if (failCheckInSites.length > 0) {
      sendMessage("logger", {
        msg: `Scheduling retry for ${failCheckInSites.length} failed sites in 1 hour`,
        level: "info",
      }).catch();

      for (const siteId of failCheckInSites) {
        // 初始化重试计数
        retryCheckInMap.set(siteId, 0);

        // 安排一小时后的第一次重试
        await jobs.scheduleJob({
          id: `${EJobType.RetryCheckIn}-${siteId}-0`,
          type: "once",
          date: Date.now() + 60 * 60 * 1000, // 1小时后
          execute: async () => {
            await retryCheckIn(siteId);
          },
        });
      }
    }
  } catch (error) {
    sendMessage("logger", {
      msg: `Error during site check-in: ${error}`,
      level: "error",
    }).catch();
  }
}

// 创建站点签到定时任务
export async function createDailySiteCheckInJob() {
  await setupOffscreenDocument();

  // 设置每天8:30执行签到
  const now = new Date();
  const checkInTime = new Date(now);
  checkInTime.setHours(8, 30, 0, 0);

  // 检查是否已经错过了今天的签到时间
  const missedToday = now > checkInTime;

  // 安排下一次签到的函数
  async function scheduleNextCheckIn() {
    // 安排下一次签到（24 小时后，同一时间）
    const nextCheckInTime = new Date();
    nextCheckInTime.setDate(nextCheckInTime.getDate() + 1);
    nextCheckInTime.setHours(8, 30, 0, 0);

    sendMessage("logger", {
      msg: `Scheduling next check-in at ${format(nextCheckInTime, "yyyy-MM-dd HH:mm:ss")}`,
      level: "info",
    }).catch();

    await jobs.scheduleJob({
      id: EJobType.DailySiteCheckIn,
      type: "once",
      date: nextCheckInTime.getTime(),
      execute: async () => {
        sendMessage("logger", {
          msg: `Executing scheduled check-in job`,
          level: "info",
        }).catch();
        await doSiteCheckIn();
        await scheduleNextCheckIn(); // 递归调度下一次
      },
    });
  }

  // 若已存在同名任务，检查是否需要立即执行
  const existingAlarm = await chrome.alarms.get(EJobType.DailySiteCheckIn);
  if (existingAlarm) {
    // 即使任务已存在，如果错过了今天的签到时间，也立即执行一次
    if (missedToday) {
      sendMessage("logger", {
        msg: `Daily site check-in job exists but missed today's check-in time (${format(checkInTime, "HH:mm:ss")}), executing immediately at ${format(now, "yyyy-MM-dd HH:mm:ss")}`,
        level: "info",
      }).catch();

      // 立即执行签到
      setTimeout(async () => {
        try {
          await doSiteCheckIn();
          sendMessage("logger", {
            msg: `Immediate check-in completed successfully`,
            level: "info",
          }).catch();
        } catch (error) {
          sendMessage("logger", {
            msg: `Error during immediate check-in: ${error}`,
            level: "error",
          }).catch();
        }
      }, 1000); // 延迟1秒执行，确保其他初始化完成
    } else {
      sendMessage("logger", {
        msg: `Daily site check-in job already exists, skipping creation`,
        level: "info",
      }).catch();
    }
    return;
  }

  sendMessage("logger", {
    msg: `Creating daily site check-in job`,
    level: "info",
  }).catch();

  if (missedToday) {
    // 如果错过了今天的签到时间，立即执行一次签到
    sendMessage("logger", {
      msg: `Missed today's check-in time (${format(checkInTime, "HH:mm:ss")}), executing immediately at ${format(now, "yyyy-MM-dd HH:mm:ss")}`,
      level: "info",
    }).catch();

    // 立即执行签到
    setTimeout(async () => {
      try {
        await doSiteCheckIn();
        // 执行完成后，安排明天的任务
        await scheduleNextCheckIn();
      } catch (error) {
        sendMessage("logger", {
          msg: `Error during immediate check-in: ${error}`,
          level: "error",
        }).catch();
      }
    }, 1000); // 延迟1秒执行，确保其他初始化完成

    // 设置明天的签到时间
    checkInTime.setDate(checkInTime.getDate() + 1);
  }

  sendMessage("logger", {
    msg: `Setting up initial check-in job for ${format(checkInTime, "yyyy-MM-dd HH:mm:ss")}`,
    level: "info",
  }).catch();

  await jobs.scheduleJob({
    id: EJobType.DailySiteCheckIn,
    type: "once",
    date: checkInTime.getTime(), // 指定首次执行时间
    execute: async () => {
      sendMessage("logger", {
        msg: `Executing initial check-in job`,
        level: "info",
      }).catch();
      await doSiteCheckIn();
      await scheduleNextCheckIn(); // 执行完成后调度下一次
    },
  });

  sendMessage("logger", {
    msg: `Daily site check-in job has been scheduled at ${format(checkInTime, "yyyy-MM-dd HH:mm:ss")}`,
  }).catch();
}

export async function cleanupDailySiteCheckInJob() {
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    if (alarm.name.startsWith(EJobType.DailySiteCheckIn) || alarm.name.startsWith(EJobType.RetryCheckIn)) {
      await jobs.removeJob(alarm.name);
    }
  }
  sendMessage("logger", { msg: "All daily site check-in jobs and retry jobs have been cleaned up." }).catch();
}

export async function setDailySiteCheckInJob() {
  await cleanupDailySiteCheckInJob();
  await createDailySiteCheckInJob();
  sendMessage("logger", { msg: `Daily site check-in job has been set successfully.` }).catch();
}

onMessage("setDailySiteCheckInJob", async () => await setDailySiteCheckInJob());
onMessage("cleanupDailySiteCheckInJob", async () => await cleanupDailySiteCheckInJob());

// 初始化时启动签到定时任务（带存在性检查，不会重复创建）
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
