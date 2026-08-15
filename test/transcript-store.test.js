// 回归：字幕记录持久化 —— recordTranscript 记录、getTranscript 取回、
// 上限 300 行截断（侧边栏每 tab 一实例，切 tab 后新实例靠它恢复历史）。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx() {
  let sessionStore = {};
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
        session: {
          get: async (k) => { const out = {}; for (const key of [].concat(k)) out[key] = sessionStore[key]; return out; },
          set: async (obj) => { Object.assign(sessionStore, obj); }
        }
      },
      tabs: {
        query: async () => [], get: async (id) => ({ id, windowId: 7 }),
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
  // 记录 3 条（原文 + 译文混合）
  vm.runInContext(`recordTranscript({ seq: 1, text: "Hello" })`, ctx);
  vm.runInContext(`recordTranscript({ seq: 2, translated: "你好" })`, ctx);
  vm.runInContext(`recordTranscript({ seq: 3, text: "World" })`, ctx);
  await settle();
  const got = await vm.runInContext(`getTranscript()`, ctx);
  check(got.rows.length === 3, `3 条记录可取回（实际 ${got.rows.length}）`);
  check(got.rows[0].seq === 1 && got.rows[0].text === "Hello", "原文行记录正确");
  check(got.rows[1].seq === 2 && got.rows[1].translated === "你好", "译文行记录正确");
  // 上限 300 截断
  for (let i = 4; i <= 305; i += 1) {
    vm.runInContext(`recordTranscript({ seq: ${i}, text: "line-${i}" })`, ctx);
  }
  await settle();
  const capped = await vm.runInContext(`getTranscript()`, ctx);
  check(capped.rows.length === 300, `上限 300 截断（实际 ${capped.rows.length}）`);
  check(capped.rows[0].seq === 6, "最早 3 条被挤出，新记录在最前");
  console.log(fail === 0 ? "transcript-store 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
