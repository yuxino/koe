// 回归：点停止必须无条件通知 offscreen 停止——
// SW 休眠恢复后 state.captureStarted=false，但 offscreen 采集页可能还在跑
// （独立文档不受 SW 生命周期影响）。stopCaptureForTab 不能因 captureStarted=false 跳过停止。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const flush = () => new Promise((r) => setImmediate(r));

function makeCtx({ captureStarted = false } = {}) {
  const sent = [];
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
        session: { get: async () => ({}), set: async () => undefined }
      },
      tabs: {
        query: async () => [], get: async (id) => ({ id, windowId: 7 }),
        onRemoved: { addListener: () => undefined }, onUpdated: { addListener: () => undefined }, onActivated: { addListener: () => undefined }
      },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        sendMessage: async (m) => { sent.push(JSON.parse(JSON.stringify(m))); return { ok: true }; }
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
  // 注入状态：模拟 SW 休眠恢复后的会话（captureStarted=false 但 offscreen 可能还在跑）
  vm.runInContext(`tabStates.set(1, { tabId: 1, captureStarted: ${captureStarted}, status: "idle", captureNeedsGesture: true, userStopped: false }); captureTabId = 1;`, ctx);
  return { ctx, sent };
}

(async () => {
  {
    // 场景：captureStarted=true 正常停止
    const h = makeCtx({ captureStarted: true });
    await vm.runInContext(`stopCaptureForTab(1)`, h.ctx);
    await flush();
    check(h.sent.some((m) => m.type === "CAPTURE_STOP"), "captureStarted=true 时发 CAPTURE_STOP");
    console.log("T1 正常停止发 CAPTURE_STOP PASS");
  }
  {
    // 场景：captureStarted=false（SW 休眠恢复）也必须发 CAPTURE_STOP
    const h = makeCtx({ captureStarted: false });
    await vm.runInContext(`stopCaptureForTab(1)`, h.ctx);
    await flush();
    check(h.sent.some((m) => m.type === "CAPTURE_STOP"),
      `captureStarted=false 也必须发 CAPTURE_STOP（实际 ${JSON.stringify(h.sent.map((m) => m.type))}）`);
    const after = await vm.runInContext(`({ userStopped: tabStates.get(1).userStopped, captureTabId })`, h.ctx);
    check(after.userStopped === true, "停止后 userStopped=true");
    check(after.captureTabId === null, "停止后 captureTabId 清空");
    console.log("T2 SW 恢复场景停止仍彻底 PASS");
  }
  {
    // 场景：restoreStates（koe-restore 闹钟每 30 秒调用）绝不能发 CAPTURE_STOP——
    // 否则正在运行的识别会话每 30 秒被杀一次（日志里 stop full 每 30 秒、
    // "切 tab 丢字幕/卡住"的根源）。
    const h = makeCtx();
    const before = h.sent.length;
    await vm.runInContext(`restoreStates()`, h.ctx);
    await flush();
    check(!h.sent.some((m) => m.type === "CAPTURE_STOP"),
      `restoreStates 不发 CAPTURE_STOP（实际 ${JSON.stringify(h.sent.slice(before).map((m) => m.type))}）`);
    console.log("T3 restoreStates 不再杀会话 PASS");
  }
  console.log(fail === 0 ? "stop-always 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
