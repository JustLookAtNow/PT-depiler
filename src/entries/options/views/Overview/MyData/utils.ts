import { shallowReactive } from "vue";
import { definitionList, fixRatio, ISiteMetadata, IUserInfo, NO_IMAGE, TSiteID } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { isValid } from "date-fns";
import { deepToRaw } from "@/options/utils.ts";

const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

// 对 siteUserInfoData 进行一些预处理（不涉及渲染格式）
export function fixUserInfo<T extends IUserInfo = IUserInfo>(userInfo: Partial<T>): Required<T> {
  userInfo = deepToRaw(userInfo);
  userInfo.ratio = fixRatio(userInfo);
  userInfo.trueRatio = fixRatio(userInfo, "trueRatio");
  userInfo.messageCount ??= 0;

  if (typeof userInfo.joinTime !== "number") {
    if (isValid(new Date(userInfo.joinTime!))) {
      userInfo.joinTime = new Date(userInfo.joinTime!).getTime();
    }
  }

  return userInfo as Required<T>;
}

export function realFormatRatio(ratio: number): string | "∞" | "" {
  if (ratio > 10000 || ratio === -1 || ratio === Infinity || ratio === null) {
    return "∞";
  }

  if (isNaN(ratio) || ratio === -Infinity) {
    return "-";
  }

  return ratio.toFixed(2);
}

export function formatRatio(
  userInfo: Partial<IUserInfo>,
  ratioKey: "ratio" | "trueRatio" = "ratio",
): string | "∞" | "" {
  let ratio = userInfo[ratioKey] ?? -1;
  return realFormatRatio(ratio);
}

export function attendanceSite(sites: TSiteID[]) {
  const runtimeStore = useRuntimeStore();
  for (const site of sites) {
    sendMessage("attendance", site)
      .then((message) => {
        runtimeStore.showSnakebar(`站点 [${site}] 签到成功: ${message}`, { color: "success" });
      })
      .catch((e) => {
        runtimeStore.showSnakebar(`站点 [${site}] 签到失败`, { color: "error" });
        console.error(e);
      });
  }
}

export function flushSiteLastUserInfo(sites: TSiteID[]) {
  const runtimeStore = useRuntimeStore();
  for (const site of sites) {
    runtimeStore.userInfo.flushPlan[site] = true;

    sendMessage("getSiteUserInfoResult", site)
      .catch((e) => {
        // 首先检查是否还在刷新，如果没有，则说明队列已经取消了，此时不报错
        if (!runtimeStore.userInfo.flushPlan[site]) {
          runtimeStore.showSnakebar(`获取站点 [${site}] 用户信息失败`, { color: "error" });
          console.error(e);
        }
      })
      .finally(() => {
        runtimeStore.userInfo.flushPlan[site] = false;
      });
  }
}

export async function cancelFlushSiteLastUserInfo() {
  for (const runtimeStoreKey in runtimeStore.userInfo.flushPlan) {
    runtimeStore.userInfo.flushPlan[runtimeStoreKey] = false;
  }

  await sendMessage("cancelUserInfoQueue", undefined);

  runtimeStore.showSnakebar(`用户信息刷新队列已取消`, { color: "error" });
}

export interface ITimelineSiteMetadata extends Pick<ISiteMetadata, "id"> {
  siteName: string; // 解析后的站点名称
  hasUserInfo: boolean; // 是否有用户配置
  faviconSrc: string;
  faviconElement: HTMLImageElement; // 站点的图片
}

export type TOptionSiteMetadatas = Record<TSiteID, ITimelineSiteMetadata>;

export const allAddedSiteMetadata = shallowReactive<TOptionSiteMetadatas>({});

export async function loadAllAddedSiteMetadata(sites?: string[]): Promise<TOptionSiteMetadatas> {
  const loadSites = sites ?? definitionList;

  await Promise.allSettled(
    loadSites.map((siteId) => {
      return new Promise<void>(async (resolve) => {
        if (!allAddedSiteMetadata[siteId]) {
          const siteMetadata = await metadataStore.getSiteMetadata(siteId);
          const siteFaviconUrl = await sendMessage("getSiteFavicon", { site: siteId });

          // 加载站点图标
          const siteFavicon = new Image();
          siteFavicon.src = siteFaviconUrl;
          siteFavicon.decode().catch(() => {
            siteFavicon.src = NO_IMAGE;
            siteFavicon.decode();
          });

          (allAddedSiteMetadata as TOptionSiteMetadatas)[siteId] = {
            id: siteId,
            siteName: await metadataStore.getSiteName(siteId),
            hasUserInfo: Object.hasOwn(siteMetadata, "userInfo"),
            faviconSrc: siteFaviconUrl,
            faviconElement: siteFavicon,
          };
        }

        resolve();
      });
    }),
  );

  return allAddedSiteMetadata;
}

// 重置签到任务函数
export async function resetDailySiteCheckInJob() {
  const runtimeStore = useRuntimeStore();
  try {
    // 先清理现有的签到任务
    await sendMessage("cleanupDailySiteCheckInJob", undefined);
    // 然后重新设置签到任务
    await sendMessage("setDailySiteCheckInJob", undefined);
    runtimeStore.showSnakebar("签到任务已重置成功", { color: "success" });
  } catch (error) {
    console.error("重置签到任务失败", error);
    runtimeStore.showSnakebar("重置签到任务失败", { color: "error" });
  }
}
