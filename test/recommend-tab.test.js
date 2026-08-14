// 回归：recommendCaptureTab 决策 —— 本页在播→本页；本页没播→跟随发声标签页；
// 没有→null；mic 模式→当前页。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };

function makeCtx({ storage = {}, discoverResult = null, audibleTabs = [], activeTab = { id: 1 } }) {
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: { local: { get: async (k) => {
        const out = {};
        for (const key of [].concat(k)) out[key] = storage[key];
        return out;
      } } },
      tabs: {
        query: async (q) => (q.audible ? audibleTabs : [activeTab]),
        get: async (id) => ({ id, windowId: 7 }),
        onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
        onActivated: { addListener: () => undefined }
      },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, sendMessage: async () => undefined },
      contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: () => undefined } },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
      action: { setPopup: async () => undefined, setBadgeText: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "s" },
      alarms: { onAlarm: { addListener: () => undefined } },
      scripting: { executeScript: async () => [], },
      webNavigation: undefined
    },
    fetch: async () => ({ ok: true })
  };
  // discoverVideoSource 需要 listVideos → scripting.executeScript；按场景注入视频列表
  ctx.chrome.scripting.executeScript = async () => [];
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(src, ctx, { filename: "background.js" });
  return ctx;
}

(async () => {
  {
    // 本页在播主视频 → 推荐本页
    const ctx = makeCtx({});
    ctx.chrome.scripting.executeScript = async () => ([{
      frameId: 0,
      result: [{ sourceUrl: "https://cdn.example/v.mp4", playing: true, muted: false }]
    }]);
    const r = await vm.runInContext(`recommendCaptureTab(1)`, ctx);
    check(r.tabId === 1, "本页在播 → 推荐本页");
  }
  {
    // 本页没视频，其他标签页发声 → 跟随发声页
    const ctx = makeCtx({ audibleTabs: [{ id: 5 }, { id: 6 }] });
    ctx.chrome.scripting.executeScript = async () => ([{ frameId: 0, result: [] }]);
    const r = await vm.runInContext(`recommendCaptureTab(1)`, ctx);
    check(r.tabId === 5, "本页无视频 → 跟随发声标签页 5");
  }
  {
    // 都没有 → null
    const ctx = makeCtx({ audibleTabs: [] });
    ctx.chrome.scripting.executeScript = async () => ([{ frameId: 0, result: [] }]);
    const r = await vm.runInContext(`recommendCaptureTab(1)`, ctx);
    check(r.tabId === null, "无来源 → null");
  }
  {
    // mic 模式 → 当前页
    const ctx = makeCtx({ storage: { koeCaptureSource: "mic" } });
    ctx.chrome.scripting.executeScript = async () => ([{ frameId: 0, result: [] }]);
    const r = await vm.runInContext(`recommendCaptureTab(3)`, ctx);
    check(r.tabId === 3, "mic 模式 → 当前页");
  }
  console.log(fail === 0 ? "recommend-tab 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
