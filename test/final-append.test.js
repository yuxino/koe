// 回归：
// T1 final appended 不重复上屏 —— 已上屏 "Oh shit, she's coming." 后，
// final 整段到达，只补发新增后缀（日志里 seq=29 → seq=31 整段重复的实锤场景）。
// T2 并发 appendLog 不丢日志 —— 多条 KOE_LOG 同时到达时串行写入，一条不丢。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const flush = () => new Promise((r) => setImmediate(r));

function makeOffCtx() {
  const sent = [];
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, Uint8Array, DataView, Float32Array,
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    setTimeout: (fn, d) => { setTimeout(fn, Math.min(Number(d) || 0, 20)); return 0; },
    clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: async () => ({ ok: true, json: async () => ({ output: { choices: [{ message: { content: "" } }] } }) }),
    WebSocket: function () {
      const self = this;
      this.readyState = 1; this.binaryType = "";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.send = () => undefined;
      this.close = () => { this.readyState = 3; };
      setTimeout(() => { if (self.onopen) self.onopen(); }, 0);
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    Audio: function () { this.srcObject = null; this.play = () => Promise.resolve(); this.pause = () => undefined; },
    AudioContext: function () {
      this.state = "running"; this.sampleRate = 16000; this.destination = {};
      this.resume = async () => undefined; this.close = async () => undefined;
      this.createMediaStreamSource = () => ({ connect() {}, channelCount: 1, channelCountMode: "", channelInterpretation: "" });
      this.createScriptProcessor = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
      this.createGain = () => ({ gain: { value: 0 }, connect() {} });
    },
    chrome: {
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return Promise.resolve({ ok: true }); },
        getURL: (p) => `chrome-extension://koe/${p}`
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8"), ctx, { filename: "offscreen.js" });
  return { ctx, sent };
}

(async () => {
  {
    // T1：先上屏客户端块，final 整段到达 → 只补发新增后缀
    const h = makeOffCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 客户端强切上屏 "Oh shit, she's coming."
    run(`handleServerDraft("Oh shit, she's coming. Yeah. Yeah. No, you wait, see you later.")`);
    await run(`(() => { const c = commitPendingDraft({ forceLongIncomplete: true }); if (c) emitCommittedUnit(c); return c; })()`);
    await flush();
    const before = h.sent.filter((m) => m.type === "CAPTURE_LINES").length;
    check(before === 1, `客户端块先上屏（实际 ${before} 块）`);
    // 服务端 final 整段到达（含已上屏部分 + 更多）
    run(`handleServerFinal("Oh shit, she's coming. Yeah. Yeah. No, you wait, see you later. Okay. Okay. Bye.")`);
    await flush();
    const units = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    // 只补发新增后缀，不再重复整段
    check(units.length === 2, `final 只补发新增（实际 ${units.length} 块）`);
    const added = units[units.length - 1];
    check(
      !added.includes("Oh shit, she's coming"),
      `补发内容不含已上屏部分（实际 ${JSON.stringify(added)}）`
    );
    check(added.includes("see you later"), `补发的是新增后缀（实际 ${JSON.stringify(added)}）`);
    console.log("T1 final appended 只补发新增 PASS");
  }
  {
    // T2：并发 appendLog 不丢日志
    const store = { koeLogs: [] };
    const ctx = {
      console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
      setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
      chrome: {
        storage: {
          local: {
            get: async (k) => { const out = {}; for (const key of [].concat(k)) out[key] = store[key]; return out; },
            set: async (obj) => { Object.assign(store, obj); }
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
    // 不等待、同时触发 20 条日志
    for (let i = 1; i <= 20; i += 1) {
      vm.runInContext(`appendLog({ event: "evt-${i}", detail: "d-${i}", ts: ${i} })`, ctx);
    }
    await flush();
    await flush();
    const got = await vm.runInContext(`getLogs()`, ctx);
    check(got.logs.length === 20, `并发 20 条日志全保留（实际 ${got.logs.length}）`);
    check(got.logs[0].event === "evt-1" && got.logs[19].event === "evt-20", "并发日志顺序完整");
    console.log("T2 并发 appendLog 不丢日志 PASS");
  }
  console.log(fail === 0 ? "final-append/log-race 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
