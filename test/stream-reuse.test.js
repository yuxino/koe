const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const flush = () => new Promise(r => setImmediate(r));
const realSetTimeout = setTimeout;

function makeOffCtx({ tabGetUserMedia }) {
  const sent = [];
  let runtimeListener = null;
  const ctx = {
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    chrome: { runtime: { onMessage: { addListener: (listener) => { runtimeListener = listener; } }, sendMessage: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return Promise.resolve({ ok: true }); }, getURL: (p) => `chrome-extension://koe/${p}` } },
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
  const dispatch = (message) => new Promise((resolve, reject) => {
    if (!runtimeListener) {
      reject(new Error("offscreen runtime listener was not registered"));
      return;
    }
    try {
      const asyncResponse = runtimeListener(message, {}, resolve);
      if (asyncResponse !== true) resolve(undefined);
    } catch (error) {
      reject(error);
    }
  });
  return { ctx, sent, dispatch };
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
  {
    // 用户在 getUserMedia 仍等待时点停止：迟到的流不能继续启动 PCM/WebSocket。
    let releaseMedia;
    let stopped = 0;
    const h = makeOffCtx({
      tabGetUserMedia: () => new Promise((resolve) => {
        releaseMedia = () => resolve({ getTracks: () => [{ stop() { stopped += 1; } }] });
      })
    });
    const run = (code) => vm.runInContext(code, h.ctx);
    const pending = run(`startCapture({
      streamId: "slow", translate: false, apiKey: "k", source: "tab", engine: "dashscope",
      jobId: "slow-job", mediaEpoch: 0
    }).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: error.message }))`);
    await flush();
    await run(`stopCapture()`);
    releaseMedia();
    const result = await pending;
    await flush();
    check(result.ok === false && result.error === "capture_start_cancelled",
      "stop invalidates an in-flight capture start operation");
    check(run(`stream === null && socket === null && stopping === true`) === true && stopped >= 1,
      "the late media stream is released and no recognizer restarts after stop");
    console.log("T7 stop-during-start race PASS");
  }
  {
    // A 的授权仍在等待时切到 B：B 不能复用 A 的启动 Promise 或迟到的音频流。
    // B 成为最新目标后，来自 A 的 STOP/RESET 也不能再改变 B 的会话。
    let releaseFirstMedia;
    let stoppedA = 0;
    let stoppedB = 0;
    const requestedStreamIds = [];
    const h = makeOffCtx({
      tabGetUserMedia: (constraints) => {
        const streamId = String(constraints?.audio?.mandatory?.chromeMediaSourceId || "");
        requestedStreamIds.push(streamId);
        if (streamId === "stream-a") {
          return new Promise((resolve) => {
            releaseFirstMedia = () => resolve({
              label: "A",
              getTracks: () => [{ stop() { stoppedA += 1; } }]
            });
          });
        }
        return Promise.resolve({
          label: "B",
          getTracks: () => [{ stop() { stoppedB += 1; } }]
        });
      }
    });
    const run = (code) => vm.runInContext(code, h.ctx);
    const startA = run(`startCapture({
      streamId: "stream-a", translate: false, apiKey: "k", source: "tab", engine: "dashscope",
      tabId: 101, jobId: "job-a", mediaEpoch: 3
    }).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: error.message }))`);
    await flush();
    const startB = run(`startCapture({
      streamId: "stream-b", translate: false, apiKey: "k", source: "tab", engine: "dashscope",
      tabId: 202, jobId: "job-b", mediaEpoch: 9
    }).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: error.message }))`);
    await flush();
    releaseFirstMedia();
    const [resultA, resultB] = await Promise.all([startA, startB]);
    await flush();

    check(resultA.ok === false && resultA.error === "capture_start_cancelled",
      "superseded A start is cancelled instead of reported as B success");
    check(resultB.ok === true, `latest B start succeeds (${resultB.error || ""})`);
    check(requestedStreamIds.join(",") === "stream-a,stream-b",
      `latest B acquires its own stream (${requestedStreamIds.join(",")})`);
    check(run(`captureTabId === 202 && captureJobId === "job-b" && captureMediaEpoch === 9
      && currentStreamId === "stream-b" && stream?.label === "B"`) === true,
      "B tab/job/epoch/stream identity is active");
    check(stoppedA >= 1 && stoppedB === 0, "late A media is released without stopping B");

    const staleReset = await h.dispatch({
      type: "CAPTURE_RESET",
      tabId: 101,
      jobId: "job-a",
      mediaEpoch: 3,
      translate: true,
      source: "mic",
      engine: "local"
    });
    await flush();
    check(staleReset?.ok === true && staleReset?.ignored === true,
      "late RESET(A) is acknowledged as stale");
    check(run(`captureTabId === 202 && captureJobId === "job-b" && captureMediaEpoch === 9
      && captureSource === "tab" && captureEngine === "dashscope" && captureTranslate === false
      && currentStreamId === "stream-b" && stream?.label === "B"`) === true,
      "late RESET(A) cannot mutate B");

    const staleStop = await h.dispatch({
      type: "CAPTURE_STOP",
      tabId: 101,
      jobId: "job-a",
      mediaEpoch: 3
    });
    await flush();
    check(staleStop?.ok === true && staleStop?.ignored === true,
      "late STOP(A) is acknowledged as stale");
    check(run(`stream?.label === "B" && currentStreamId === "stream-b" && stopping === false`) === true
      && stoppedB === 0,
      "late STOP(A) cannot stop B");

    const forcedStop = await h.dispatch({ type: "CAPTURE_STOP", force: true });
    await flush();
    check(forcedStop?.ok === true && run(`stream === null && stopping === true`) === true && stoppedB >= 1,
      "explicit force stop still releases the active capture");
    console.log("T8 latest-tab-wins handoff PASS");
  }
  {
    // STOP(A) 已通过身份校验但仍在异步清理时，START(B) 必须等清理完成；
    // 否则 A 的 releaseStream 会把刚拿到的 B 流一起释放。
    let stoppedA = 0;
    let stoppedB = 0;
    const requestedStreamIds = [];
    const h = makeOffCtx({
      tabGetUserMedia: async (constraints) => {
        const streamId = String(constraints?.audio?.mandatory?.chromeMediaSourceId || "");
        requestedStreamIds.push(streamId);
        return {
          label: streamId === "stream-b" ? "B" : "A",
          getTracks: () => [{
            readyState: "live",
            stop() {
              if (streamId === "stream-b") stoppedB += 1;
              else stoppedA += 1;
            }
          }]
        };
      }
    });
    const run = (code) => vm.runInContext(code, h.ctx);
    const startedA = await h.dispatch({
      type: "CAPTURE_START", streamId: "stream-a", translate: false, apiKey: "k",
      source: "tab", engine: "local", tabId: 301, jobId: "job-a", mediaEpoch: 1
    });
    check(startedA?.ok === true, "barrier setup starts A");

    run(`
      globalThis.__releaseStopPcm = null;
      globalThis.__stopPcmGate = new Promise((resolve) => { globalThis.__releaseStopPcm = resolve; });
      globalThis.__realStopPcmCapture = stopPcmCapture;
      stopPcmCapture = async () => {
        await globalThis.__stopPcmGate;
        return globalThis.__realStopPcmCapture();
      };
    `);
    const stopA = h.dispatch({
      type: "CAPTURE_STOP", tabId: 301, jobId: "job-a", mediaEpoch: 1
    });
    await flush();
    const startB = h.dispatch({
      type: "CAPTURE_START", streamId: "stream-b", translate: false, apiKey: "k",
      source: "tab", engine: "dashscope", tabId: 302, jobId: "job-b", mediaEpoch: 2
    });
    await flush();
    check(requestedStreamIds.join(",") === "stream-a",
      "B waits behind the in-progress STOP(A) cleanup barrier");
    const pendingStatus = await h.dispatch({ type: "CAPTURE_STATUS" });
    check(pendingStatus?.active === true && pendingStatus.tabId === 302
        && pendingStatus.jobId === "job-b" && pendingStatus.mediaEpoch === 2
        && pendingStatus.engine === "dashscope" && pendingStatus.source === "tab",
      "pending capture status reports B identity and B mode as one coherent snapshot");
    run(`globalThis.__releaseStopPcm()`);
    const [stoppedResult, startedB] = await Promise.all([stopA, startB]);
    await flush();
    check(stoppedResult?.ok === true && startedB?.ok === true,
      "STOP(A) and queued START(B) both complete successfully");
    check(run(`captureTabId === 302 && captureJobId === "job-b" && captureMediaEpoch === 2
      && stream?.label === "B" && currentStreamId === "stream-b"`) === true,
      "B remains the active identity after A cleanup finishes");
    check(stoppedA >= 1 && stoppedB === 0,
      "A cleanup releases only A and never releases B");

    const status = await h.dispatch({ type: "CAPTURE_STATUS" });
    check(status?.active === true && status.tabId === 302 && status.jobId === "job-b"
        && status.mediaEpoch === 2 && status.engine === "dashscope",
      "capture status reports the authoritative active offscreen identity");
    await h.dispatch({ type: "CAPTURE_STOP", force: true });
    console.log("T9 stop-start cleanup barrier PASS");
  }
  {
    // 两次策略 RESET 都卡在重连等待窗口时，旧 RESET 不能稍后再打开一条
    // 已无人管理的 WebSocket；最终只能有最新 epoch / 策略对应的连接。
    const h = makeOffCtx({ tabGetUserMedia: async () => fakeTabStream() });
    const run = (code) => vm.runInContext(code, h.ctx);
    const resetSleeps = [];
    const sockets = [];
    h.ctx.setTimeout = (fn, delay) => {
      if (Number(delay) === 250) resetSleeps.push(fn);
      return resetSleeps.length + 100;
    };
    h.ctx.clearTimeout = () => undefined;
    h.ctx.WebSocket = function () {
      this.readyState = 0;
      this.binaryType = "";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.send = (payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.header?.action === "run-task") {
          this.onmessage?.({
            data: JSON.stringify({
              header: { event: "task-started", task_id: parsed.header.task_id }, payload: {}
            })
          });
        }
      };
      this.close = () => { this.readyState = 3; };
      sockets.push(this);
    };
    h.ctx.WebSocket.OPEN = 1;
    run(`
      stream = { getTracks: () => [{ stop() {} }] };
      stopping = false;
      captureTabId = 77;
      captureJobId = "policy-job";
      captureMediaEpoch = 1;
      captureEngine = "dashscope";
    `);

    const first = h.dispatch({
      type: "CAPTURE_RESET", tabId: 77, jobId: "policy-job", mediaEpoch: 2,
      translate: true, skipSameLanguage: false, preferredLanguage: "en-US",
      source: "tab", engine: "dashscope"
    });
    const second = h.dispatch({
      type: "CAPTURE_RESET", tabId: 77, jobId: "policy-job", mediaEpoch: 3,
      translate: true, skipSameLanguage: true, preferredLanguage: "ja-JP",
      source: "tab", engine: "dashscope"
    });
    check(resetSleeps.length === 2, "rapid policy resets enter independently controlled reconnect waits");

    resetSleeps[0]?.();
    await flush();
    if (sockets[0]) {
      sockets[0].readyState = 1;
      sockets[0].onopen?.();
      await flush();
    }
    resetSleeps[1]?.();
    await flush();
    const latestSocket = sockets.at(-1);
    if (latestSocket && latestSocket.readyState !== 3) {
      latestSocket.readyState = 1;
      latestSocket.onopen?.();
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await flush();

    const openSockets = sockets.filter((entry) => entry.readyState !== 3);
    h.ctx.__latestResetSocket = latestSocket;
    check(firstResult?.ok === true && secondResult?.ok === true,
      "rapid policy resets are both acknowledged without surfacing cancellation noise");
    check(sockets.length === 1 && openSockets.length === 1,
      `only the latest reset creates one live WebSocket (created=${sockets.length}, open=${openSockets.length})`);
    check(run(`socket === __latestResetSocket
      && captureMediaEpoch === 3
      && captureSkipSameLanguage === true
      && capturePreferredLanguage === "ja-JP"`) === true,
      "the surviving socket belongs to the latest epoch and same-language policy");
    console.log("T10 rapid policy reset latest-wins PASS");
  }
  console.log(fail === 0 ? "ALL stream-reuse suites PASS" : `FAILURES: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
