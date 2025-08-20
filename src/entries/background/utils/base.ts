import { stringify } from "urlencode";
import { onMessage } from "@/messages.ts";
import { extStorage } from "@/storage.ts";

export function openOptionsPage(url?: string | { path: string; query?: Record<string, any> }) {
  if (url && typeof url !== "string") {
    url = url.path + (url.query ? "?" + stringify(url.query) : "");
  }
  url ??= "/";

  chrome.tabs.create({ url: "/src/entries/options/index.html#" + url }).catch();
}

onMessage("openOptionsPage", async ({ data: url }) => {
  openOptionsPage(url);
});

onMessage("openTab", async ({ data }) => {
  const { url, waitForMs } = data || {};
  if (!url) return;
  const tab = await chrome.tabs.create({ url });
  if (waitForMs && waitForMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitForMs));
    try {
      if (tab?.id != null) {
        await chrome.tabs.remove(tab.id);
      }
    } catch (e) {
      // ignore errors if tab already closed or id invalid
    }
  }
});

onMessage("downloadFile", async ({ data: downloadOptions }) => {
  return await chrome.downloads.download(downloadOptions);
});

// @ts-ignore
onMessage("getExtStorage", async ({ data: key }) => {
  return await extStorage.getItem(key);
});

onMessage("setExtStorage", async ({ data: { key, value } }) => {
  await extStorage.setItem(key, value);
});
