// 回归：Alt+K 快捷键 → 打开弹窗（弹窗是可靠手势源，会自动开启字幕）。
// Chrome 的 command 事件不是 tabCapture 手势（SO 77213045），
// 直接 getMediaStreamId 必失败 → 旧实现"按了没反应"。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const flush = () => new Promise((r) => setImmediate(r));

function makeCtx({ openPopupFails = false } = {}) {
  const calls = { openPopup: 0, getMediaStreamId: 0, sidePanelOpen: 0 };
  let commandHandler = null;
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
        session: { get: async () => ({}), set: async () => undefined }
      },
      tabs: {
        query: async () => [{ id: 1, windowId: 7 }], get: async (id) => ({ id, windowId: 7 }),
        onRemoved: { addListener: () => undefined }, onUpdated: { addListener: () => undefined }, onActivated: { addListener: () => undefined }
      },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, sendMessage: async () => undefined
      },
      contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: (fn) => { commandHandler = fn; } } },
      sidePanel: { open: async () => { calls.sidePanelOpen += 1; }, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
      action: {
        openPopup: async () => { calls.openPopup += 1; if (openPopupFails) throw new Error("not supported"); },
        setPopup: async () => undefined, setBadgeText: async () => undefined
      },
      tabCapture: { getMediaStreamId: async () => { calls.getMediaStreamId += 1; return "s"; } },
      alarms: { onAlarm: { addListener: () => undefined } },
      scripting: { executeScript: async () => [] },
      webNavigation: undefined
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx, { filename: "background.js" });
  return { ctx, commandHandler: () => commandHandler, calls };
}

(async () => {
  {
    // Alt+K → 打开弹窗（不再直接 getMediaStreamId）
    const h = makeCtx();
    await h.commandHandler()("capture-tab");
    await flush();
    check(h.calls.openPopup === 1, `Alt+K 调用 openPopup（实际 ${h.calls.openPopup}）`);
    check(h.calls.getMediaStreamId === 0, "Alt+K 不再直接 getMediaStreamId（无手势必失败）");
    console.log("T1 Alt+K 打开弹窗 PASS");
  }
  {
    // 老 Chrome 不支持 openPopup → 退回开侧边栏，且仍不直接 getMediaStreamId
    const h = makeCtx({ openPopupFails: true });
    await h.commandHandler()("capture-tab");
    await flush();
    check(h.calls.sidePanelOpen >= 1, "openPopup 失败时退回开侧边栏");
    check(h.calls.getMediaStreamId === 0, "失败路径也不直接 getMediaStreamId");
    console.log("T2 openPopup 失败回退 PASS");
  }
  console.log(fail === 0 ? "command 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
