const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const flush = () => new Promise(r => setImmediate(r));
const realSetTimeout = setTimeout;

function makeOffCtx({ tabGetUserMedia }) {
  const sent = [];
  const ctx = {
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    chrome: { runtime: { onMessage: { addListener: () => undefined }, sendMessage: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return Promise.resolve({ ok: true }); }, getURL: (p) => `chrome-extension://koe/${p}` } },
    document: { body: { appendChild: () => undefined }, createElement: () => ({ style: {}, src: "", contentWindow: { postMessage: () => undefined } }) },
    WebSocket: function () {
      const self = this;
      this.readyState = 1;
      this.binaryType = "";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.send = (payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.header && parsed.header.action === "run-task") {
          realSetTimeout(() => {
            if (self.onmessage) {
              self.onmessage({ data: JSON.stringify({ header: { event: "task-started", task_id: parsed.header.task_id }, payload: {} }) });
            }
          }, 0);
        }
      };
      this.close = () => { this.readyState = 3; };
      realSetTimeout(() => { if (self.onopen) self.onopen(); }, 0);
    },
    Audio: function () { this.srcObject = null; this.play = () => Promise.resolve(); this.pause = () => undefined; },
    navigator: { mediaDevices: { getUserMedia: tabGetUserMedia } },
    AudioContext: function () {
      this.state = "running"; this.sampleRate = 16000; this.destination = {};
      this.resume = async () => undefined; this.close = async () => undefined;
      this.createMediaStreamSource = () => ({ connect() {}, channelCount: 1, channelCountMode: "", channelInterpretation: "" });
      this.createScriptProcessor = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
      this.createGain = () => ({ gain: { value: 0 }, connect() {} });
    },
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: (url, options) => Promise.resolve({ ok: true, json: async () => {
      const body = JSON.parse(options.body);
      const text = body.input.messages.find(m => m.role === "user")?.content || "";
      return { output: { choices: [{ message: { content: `译:${text}` } }] } };
    }}),
    setTimeout: (fn, d) => { realSetTimeout(fn, Math.min(Number(d) || 0, 25)); return 0; }, clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0, clearInterval: () => undefined,
    Date, console, JSON, String, Number, Boolean, Promise, Math, Uint8Array, DataView, Float32Array
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("offscreen.js", "utf8"), ctx);
  return { ctx, sent };
}

const fakeTabStream = () => ({ getTracks: () => [{ stop() {} }] });

(async () => {
  {
    let tabCalls = 0;
    const h = makeOffCtx({ tabGetUserMedia: async () => { tabCalls += 1; return fakeTabStream(); } });
    const run = (code) => vm.runInContext(code, h.ctx);
    run(`captureSource = "tab"; captureEngine = "dashscope"; currentStreamSource = ""; stream = null;`);
    let r = await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).then(r => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === true, "first start ok");
    check(tabCalls === 1, "getUserMedia called once for first start");
    await run(`stopRecognitionOnly()`);
    check(run(`Boolean(stream)`) === true, "stream kept after recognition-only stop");
    check(run(`Boolean(monitorAudio)`) === true, "monitor kept after recognition-only stop");
    r = await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).then(r => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === true, "restart ok");
    check(tabCalls === 1, "getUserMedia NOT called again (stream reused)");
    console.log("T1 stream reuse PASS");
  }
  {
    let calls = 0;
    const h = makeOffCtx({ tabGetUserMedia: async () => { calls += 1; if (calls === 1) throw new Error("Cannot capture a tab with an active stream"); return fakeTabStream(); } });
    const run = (code) => vm.runInContext(code, h.ctx);
    run(`captureSource = "tab"; captureEngine = "dashscope"; currentStreamSource = ""; stream = null; monitorAudio = null;`);
    const r = await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).then(r => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === true, "retry after active-stream error succeeded");
    check(calls === 2, "exactly one retry");
    console.log("T2 active-stream retry PASS");
  }
  {
    const h = makeOffCtx({ tabGetUserMedia: async () => { throw new Error("Cannot capture a tab with an active stream"); } });
    const run = (code) => vm.runInContext(code, h.ctx);
    run(`captureSource = "tab"; captureEngine = "dashscope"; currentStreamSource = ""; stream = null; monitorAudio = null;`);
    const r = await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).then(r => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === false && /刷新视频页面/.test(r.error), "clear guidance when still occupied");
    console.log("T3 persistent-occupancy guidance PASS");
  }
  {
    let micCalls = 0;
    const h = makeOffCtx({ tabGetUserMedia: async () => fakeTabStream() });
    const run = (code) => vm.runInContext(code, h.ctx);
    run(`
globalThis.__micCalls = 0;
navigator.mediaDevices.getUserMedia = async (c) => {
  if (c.audio && c.audio.mandatory && c.audio.mandatory.chromeMediaSourceId !== undefined) return { getTracks: () => [{ stop() {} }] };
  globalThis.__micCalls += 1;
  return { getTracks: () => [{ stop() {} }] };
};
captureSource = "tab"; captureEngine = "dashscope"; currentStreamSource = ""; stream = null; monitorAudio = null;
`);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({error:e.message}))`);
    await flush();
    const r = await run(`startCapture({ streamId: "", translate: false, apiKey: "k", source: "mic", engine: "dashscope" }).then(() => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === true, `mic start ok (${r.error || ""})`);
    check(run(`currentStreamSource`) === "mic", "source switched to mic");
    check(run(`globalThis.__micCalls`) >= 1, "mic stream acquired after source switch");
    console.log("T4 source switch PASS");
  }
  console.log(fail === 0 ? "ALL stream-reuse suites PASS" : `FAILURES: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
