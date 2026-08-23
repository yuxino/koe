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
    let r = await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope", jobId: "job-1", mediaEpoch: 3 }).then(r => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === true, "first start ok");
    check(tabCalls === 1, "getUserMedia called once for first start");
    run(`emitSeq = 41`);
    await run(`stopRecognitionOnly()`);
    check(run(`Boolean(stream)`) === true, "stream kept after recognition-only stop");
    check(run(`Boolean(monitorAudio)`) === true, "monitor kept after recognition-only stop");
    r = await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope", jobId: "job-1", mediaEpoch: 3 }).then(r => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === true, "restart ok");
    check(tabCalls === 1, "getUserMedia NOT called again (stream reused)");
    check(run(`emitSeq`) === 41, "same job reconnect preserves the monotonic subtitle sequence");
    run(`emitSeq = 42`);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope", jobId: "job-1", mediaEpoch: 4 })`);
    await flush();
    check(run(`emitSeq`) === 0, "a new media epoch resets the subtitle sequence");
    run(`emitSeq = 7`);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope", jobId: "job-2", mediaEpoch: 0 })`);
    await flush();
    check(run(`emitSeq`) === 0, "a genuinely new job resets the subtitle sequence");
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
    let calls = 0;
    let stopped = 0;
    const h = makeOffCtx({ tabGetUserMedia: async () => {
      calls += 1;
      return { getTracks: () => [{ stop() { stopped += 1; } }] };
    } });
    const run = (code) => vm.runInContext(code, h.ctx);
    run(`captureSource = "tab"; captureEngine = "dashscope"; currentStreamSource = ""; stream = null; monitorAudio = null;`);
    await run(`startCapture({ streamId: "tab-a", translate: false, apiKey: "k", source: "tab", engine: "dashscope" })`);
    await flush();
    await run(`startCapture({ streamId: "tab-b", translate: false, apiKey: "k", source: "tab", engine: "dashscope" })`);
    await flush();
    check(calls === 2, `different tab stream id reacquires media (${calls})`);
    check(stopped >= 1, "different tab stream id releases previous media");
    console.log("T3 different tab stream identity PASS");
  }
  {
    const h = makeOffCtx({ tabGetUserMedia: async () => { throw new Error("Cannot capture a tab with an active stream"); } });
    const run = (code) => vm.runInContext(code, h.ctx);
    run(`captureSource = "tab"; captureEngine = "dashscope"; currentStreamSource = ""; stream = null; monitorAudio = null;`);
    const r = await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).then(r => ({ok:true})).catch(e => ({ok:false,error:e.message}))`);
    await flush();
    check(r.ok === false && /刷新视频页面/.test(r.error), "clear guidance when still occupied");
    console.log("T4 persistent-occupancy guidance PASS");
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
    console.log("T5 source switch PASS");
  }
  {
    // 旧连接晚于新连接触发 open 时，只能关闭自己，不能向仍 CONNECTING 的新 socket 发消息。
    const h = makeOffCtx({ tabGetUserMedia: async () => fakeTabStream() });
    const run = (code) => vm.runInContext(code, h.ctx);
    const sockets = [];
    let invalidSends = 0;
    h.ctx.WebSocket = function () {
      const self = this;
      sockets.push(this);
      this.readyState = 0;
      this.binaryType = "";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.send = (payload) => {
        if (this.readyState !== 1) {
          invalidSends += 1;
          throw new Error("send while connecting");
        }
        const parsed = JSON.parse(payload);
        if (parsed.header?.action === "run-task") {
          realSetTimeout(() => self.onmessage?.({
            data: JSON.stringify({ header: { event: "task-started", task_id: parsed.header.task_id }, payload: {} })
          }), 0);
        }
      };
      this.close = () => { this.readyState = 3; };
    };
    h.ctx.WebSocket.OPEN = 1;
    run(`stopping = false; captureEngine = "dashscope"; captureClockStartedAt = 0;`);
    const first = run(`connectRealtime()`);
    const second = run(`connectRealtime()`);
    check(sockets.length === 2, "two overlapping sockets created");
    sockets[0].readyState = 1;
    sockets[0].onopen();
    sockets[1].readyState = 1;
    sockets[1].onopen();
    await Promise.all([first, second]);
    check(invalidSends === 0, "superseded socket never sends through the connecting replacement");
    console.log("T6 overlapping WebSocket open race PASS");
  }
  console.log(fail === 0 ? "ALL stream-reuse suites PASS" : `FAILURES: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
