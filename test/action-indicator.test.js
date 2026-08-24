const fs = require("fs");
const vm = require("vm");

let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};

function makeContext() {
  const badgeTexts = [];
  const badgeColors = [];
  const badgeTextColors = [];
  const titles = [];
  const sessionStore = {};
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
        session: {
          get: async (keys) => {
            const result = {};
            for (const key of [].concat(keys)) result[key] = sessionStore[key];
            return result;
          },
          set: async (values) => Object.assign(sessionStore, JSON.parse(JSON.stringify(values)))
        }
      },
      runtime: {
        id: "test-extension-id",
        lastError: null,
        onMessage: { addListener: () => undefined },
        onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        sendMessage: async () => ({ ok: true }),
        getURL: (path) => `chrome-extension://test/${path}`
      },
      alarms: { create: async () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        query: async () => [],
        sendMessage: async () => undefined,
        onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
        onActivated: { addListener: () => undefined }
      },
      contextMenus: {
        create: () => undefined,
        remove: (_id, callback) => callback?.(),
        onClicked: { addListener: () => undefined }
      },
      commands: { onCommand: { addListener: () => undefined } },
      action: {
        openPopup: async () => undefined,
        setBadgeText: async (details) => badgeTexts.push({ ...details }),
        setBadgeBackgroundColor: async (details) => badgeColors.push({ ...details }),
        setBadgeTextColor: async (details) => badgeTextColors.push({ ...details }),
        setTitle: async (details) => titles.push({ ...details })
      },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream" },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined },
      webRequest: { onBeforeRequest: { addListener: () => undefined } }
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return { ctx, badgeTexts, badgeColors, badgeTextColors, titles };
}

(async () => {
  const h = makeContext();
  const run = (source) => vm.runInContext(source, h.ctx);
  await run(`bootPromise`);
  h.badgeTexts.length = 0;
  h.badgeColors.length = 0;
  h.badgeTextColors.length = 0;
  h.titles.length = 0;

  const starting = run(`actionIndicatorForState({ captureStarted: true, status: "starting", stageDetail: "正在定位视频媒体…" })`);
  check(starting.text === "··" && starting.title.includes("正在定位视频媒体"),
    "starting state maps to a visible preparing badge and detailed title");

  const live = run(`actionIndicatorForState({ captureStarted: true, status: "live", engine: "local" })`);
  check(live.text === "ON" && live.title.includes("本地精准字幕运行中"),
    "live local state maps to the ON badge");

  const error = run(`actionIndicatorForState({ captureStarted: false, status: "error", stageDetail: "Helper 已断开" })`);
  check(error.text === "!" && error.title.includes("Helper 已断开"),
    "error state maps to the attention badge and error detail");

  const idle = run(`actionIndicatorForState({ captureStarted: false, status: "idle", userStopped: true })`);
  check(idle.text === "" && idle.title === "Koe", "idle state clears the toolbar badge");

  run(`tabStates.set(1, {
    tabId: 1, jobId: "offline-1", captureStarted: true, status: "starting",
    engine: "local", stageDetail: "正在准备首批字幕…", startedAt: 1
  }); captureTabId = 1;`);
  await run(`persistStates()`);
  check(h.badgeTexts.at(-1)?.text === "··" && h.titles.at(-1)?.title.includes("正在准备首批字幕"),
    "persisting a starting session updates the global toolbar indicator");

  run(`tabStates.get(1).status = "live"; tabStates.get(1).stageDetail = "本地精准字幕已就绪";`);
  await run(`persistStates()`);
  check(h.badgeTexts.at(-1)?.text === "ON" && !Object.hasOwn(h.badgeTexts.at(-1), "tabId"),
    "running state shows a global ON badge independent of the active tab");

  run(`tabStates.get(1).captureStarted = false; tabStates.get(1).status = "error";
    tabStates.get(1).stageDetail = "本地字幕处理失败"; captureTabId = null;`);
  await run(`persistStates()`);
  check(h.badgeTexts.at(-1)?.text === "!" && h.badgeColors.at(-1)?.color,
    "failed state shows a colored attention badge");

  run(`tabStates.get(1).status = "idle"; tabStates.get(1).userStopped = true;`);
  await run(`persistStates()`);
  check(h.badgeTexts.at(-1)?.text === "" && h.titles.at(-1)?.title === "Koe",
    "stopping the latest session clears the badge and restores the default title");

  check(h.badgeTextColors.some((entry) => entry.color === "#FFFFFF"),
    "visible badges force readable white text when the browser supports it");

  console.log(fail === 0 ? "action indicator regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
