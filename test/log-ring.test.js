// 回归：KOE_LOG 存环形缓冲（600 条上限），GET_LOGS 原样取回。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };

function makeCtx() {
  let store = { koeLogs: [] };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: {
          get: async (k) => { const out = {}; for (const key of [].concat(k)) out[key] = store[key]; return out; },
          set: async (obj) => { Object.assign(store, obj); },
          clear: async () => { store = {}; }
        },
        session: { get: async () => ({}), set: async () => undefined }
      },
      tabs: {
        query: async () => [], get: async () => ({}),
        onRemoved: { addListener: () => undefined }, onUpdated: { addListener: () => undefined }, onActivated: { addListener: () => undefined }
      },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, sendMessage: async () => undefined
      },
      contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: () => undefined } },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
      action: { setPopup: async () => undefined, setBadgeText: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "s" },
      alarms: { onAlarm: { addListener: () => undefined } },
      scripting: { executeScript: async () => [] },
      webNavigation: undefined
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx, { filename: "background.js" });
  return ctx;
}

(async () => {
  const ctx = makeCtx();
  // 写入 5 条，取回应一致且有序
  for (let i = 1; i <= 5; i += 1) {
    await vm.runInContext(`appendLog({ event: "evt-${i}", detail: "d-${i}", ts: ${1000 + i} })`, ctx);
  }
  const got = await vm.runInContext(`getLogs()`, ctx);
  check(got.logs.length === 5, "5 条日志可取出");
  check(got.logs[0].event === "evt-1" && got.logs[4].event === "evt-5", "日志顺序保持");
  check(got.logs[2].detail === "d-3", "日志内容完整");
  // 超出上限截断：写 605 条 → 只剩 600 条，最早的 5 条被挤出
  for (let i = 6; i <= 605; i += 1) {
    await vm.runInContext(`appendLog({ event: "bulk-${i}", detail: "", ts: ${i} })`, ctx);
  }
  const after = await vm.runInContext(`getLogs()`, ctx);
  check(after.logs.length === 600, `环形缓冲上限 600（实际 ${after.logs.length}）`);
  check(after.logs[0].event === "bulk-6", "最早 5 条被挤出，新日志在最前");
  console.log(fail === 0 ? "log-ring 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
