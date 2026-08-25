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
    vm.runInContext(`
      tabStates.get(1).issueKind = "error";
      tabStates.get(1).issueCode = "capture_failed";
    `, h.ctx);
    await vm.runInContext(`stopCaptureForTab(1)`, h.ctx);
    await flush();
    check(h.sent.some((m) => m.type === "CAPTURE_STOP"),
      `captureStarted=false 也必须发 CAPTURE_STOP（实际 ${JSON.stringify(h.sent.map((m) => m.type))}）`);
    const after = await vm.runInContext(`({
      userStopped: tabStates.get(1).userStopped,
      issueKind: tabStates.get(1).issueKind,
      issueCode: tabStates.get(1).issueCode,
      captureTabId
    })`, h.ctx);
    check(after.userStopped === true, "停止后 userStopped=true");
    check(after.captureTabId === null, "停止后 captureTabId 清空");
    check(after.issueKind === "" && after.issueCode === "", "停止后清除错误/操作提示，UI 回到 OFF");
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
  {
    // 场景：tabStates 无此记录（SW 休眠后 captureTabId 内存丢失、状态未恢复）时，
    // 点停止也必须发 CAPTURE_STOP——否则 offscreen 还在跑，停止失效
    const h = makeCtx();
    vm.runInContext(`tabStates.delete(1); captureTabId = null;`, h.ctx);
    const before = h.sent.length;
    await vm.runInContext(`stopCaptureForTab(1)`, h.ctx);
    await flush();
    check(h.sent.slice(before).some((m) => m.type === "CAPTURE_STOP"),
      `无状态记录也必须发 CAPTURE_STOP（实际 ${JSON.stringify(h.sent.slice(before).map((m) => m.type))}）`);
    console.log("T4 无状态记录停止仍发 CAPTURE_STOP PASS");
  }
  {
    // 场景：用户主动停止（userStopped=true）后，自动授权（PAGE_READY 每 3 秒触发）
    // 必须被拦——否则点停止的手势窗口内 getMediaStreamId 会成功，字幕悄悄重开
    const h = makeCtx({ captureStarted: false });
    vm.runInContext(`tabStates.set(1, { tabId: 1, captureStarted: false, userStopped: true, source: "tab", engine: "dashscope", liveOnly: true });`, h.ctx);
    h.ctx.chrome.tabCapture.getMediaStreamId = async () => { throw new Error("should not be called"); };
    // 模拟 content PAGE_READY 触发的 ensureLiveCaptions（视频在播）
    h.ctx.chrome.scripting.executeScript = async () => ([{
      frameId: 0,
      result: [{ sourceUrl: "https://cdn.example/v.mp4", playing: true, muted: false, durationMs: 10000, width: 640, height: 360 }]
    }]);
    const r = await vm.runInContext(`ensureLiveCaptions({ tabId: 1, pageUrl: "https://youtu.be/x" })`, h.ctx);
    await flush();
    check(!h.sent.some((m) => m.type === "CAPTURE_START"), "userStopped 后自动授权不开字幕");
    check(Boolean(r?.ok), "ensureLiveCaptions 正常返回");
    console.log("T5 停止后自动授权被拦 PASS");
  }
  {
    // 场景：UI 轮询后会话已从 A 交接到 B；晚到的 STOP(A) 不能杀掉 B。
    const h = makeCtx({ captureStarted: false });
    vm.runInContext(`
      tabStates.get(1).jobId = "job-a";
      tabStates.set(2, { tabId: 2, jobId: "job-b", captureStarted: true, status: "live", engine: "dashscope" });
      captureTabId = 2;
    `, h.ctx);
    const before = h.sent.length;
    const response = await vm.runInContext(`stopCaptureForTab({ tabId: 1, jobId: "job-a" })`, h.ctx);
    await flush();
    check(response.stale === true && response.state?.jobId === "job-b",
      "stale stop returns the current session for UI refresh");
    check(!h.sent.slice(before).some((message) => message.type === "CAPTURE_STOP")
        && vm.runInContext(`tabStates.get(2).captureStarted`, h.ctx) === true,
      "stale STOP from the previous tab cannot terminate the new global session");
    console.log("T6 交接后的旧 STOP 不杀新会话 PASS");
  }
  {
    // offscreen 明确返回 ignored 时不能伪装成 reset 成功；当前会话应走已有
    // stream id 完整重启，而已经被新会话取代的旧 reset 不得反启动。
    const h = makeCtx({ captureStarted: false });
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_RESET") return { ok: true, ignored: true };
      return { ok: true };
    };
    vm.runInContext(`
      tabStates.set(1, {
        tabId: 1, jobId: "job-reset", mediaEpoch: 4, captureStarted: true,
        userStopped: false, status: "live", engine: "dashscope", source: "tab"
      });
      captureTabId = 1;
      captureStreamIds.set(1, "stream-reset");
      globalThis.__resetRestart = null;
      startCapture = async (state, streamId) => {
        globalThis.__resetRestart = { tabId: state.tabId, jobId: state.jobId, mediaEpoch: state.mediaEpoch, streamId };
      };
    `, h.ctx);
    await vm.runInContext(`resetCaptureSession(tabStates.get(1))`, h.ctx);
    const restarted = vm.runInContext(`globalThis.__resetRestart`, h.ctx);
    check(restarted?.tabId === 1 && restarted?.jobId === "job-reset"
        && restarted?.mediaEpoch === 4 && restarted?.streamId === "stream-reset",
      "ignored reset fully restarts only the still-current capture identity");

    let releaseReset;
    h.ctx.chrome.runtime.sendMessage = (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_RESET") {
        return new Promise((resolve) => { releaseReset = resolve; });
      }
      return Promise.resolve({ ok: true });
    };
    vm.runInContext(`globalThis.__resetRestart = null`, h.ctx);
    const staleReset = vm.runInContext(`resetCaptureSession(tabStates.get(1))`, h.ctx);
    await flush();
    vm.runInContext(`
      tabStates.set(2, { tabId: 2, jobId: "job-new", mediaEpoch: 0, captureStarted: true, userStopped: false });
      captureTabId = 2;
    `, h.ctx);
    releaseReset({ ok: true, ignored: true });
    await staleReset;
    check(vm.runInContext(`globalThis.__resetRestart === null`, h.ctx),
      "ignored reset from a superseded session cannot restart the old tab");

    const local = makeCtx({ captureStarted: false });
    local.ctx.chrome.runtime.sendMessage = async (message) => {
      local.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_RESET") return { ok: true, ignored: true };
      if (message.type === "CAPTURE_STATUS") {
        return {
          ok: true, active: true, engine: "local",
          tabId: 1, jobId: "job-local-reset", mediaEpoch: 4
        };
      }
      return { ok: true };
    };
    vm.runInContext(`
      sendToContent = async () => undefined;
      persistStates = async () => undefined;
      postNativeMessage = () => undefined;
      publishMediaIssue = async (state, issue) => {
        state.issueKind = issue.kind;
        state.issueCode = issue.issueCode;
        state.captureNeedsGesture = Boolean(issue.captureNeedsGesture);
        state.status = issue.status;
        state.stageDetail = issue.detail;
      };
      tabStates.set(1, {
        tabId: 1, jobId: "job-local-reset", mediaEpoch: 4, captureStarted: true,
        localFallbackActive: true, userStopped: false, status: "live",
        engine: "local", source: "tab", translate: true, mediaIdentity: "private-local"
      });
      captureTabId = 1;
      captureStreamIds.set(1, "old-stream-id");
    `, local.ctx);
    await vm.runInContext(`resetLocalLiveSession(tabStates.get(1), "source")`, local.ctx);
    const localState = vm.runInContext(`tabStates.get(1)`, local.ctx);
    const preciseLocalStop = local.sent.find((message) => message.type === "CAPTURE_STOP");
    check(preciseLocalStop?.tabId === 1 && preciseLocalStop?.jobId === "job-local-reset"
        && preciseLocalStop?.mediaEpoch === 4 && preciseLocalStop?.force !== true,
      "ignored local reset releases the actual old offscreen identity");
    check(localState.captureStarted === false && localState.localFallbackActive === false
        && localState.captureNeedsGesture === true && localState.issueCode === "needs_tab_audio",
      "ignored local reset becomes an explicit one-click recovery state");
    console.log("T7 ignored reset recovery PASS");
  }
  {
    // B 正在等待停止 A 时，更新的 C 启动可先完成；B 的 await 晚到后不能
    // 再抢回全局 captureTabId。
    const h = makeCtx({ captureStarted: false });
    let releaseStopA;
    h.ctx.chrome.runtime.sendMessage = (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_STOP" && message.jobId === "job-a") {
        return new Promise((resolve) => { releaseStopA = resolve; });
      }
      return Promise.resolve({ ok: true });
    };
    vm.runInContext(`
      clearMediaIssue = async () => undefined;
      clearTranscript = async () => undefined;
      persistStates = async () => undefined;
      sendToContent = async () => undefined;
      requestOfflineMediaContext = async () => undefined;
      connectNativeHelper = () => ({});
      postNativeMessage = () => undefined;
      tabStates.set(1, {
        tabId: 1, jobId: "job-a", mediaEpoch: 1, captureStarted: true,
        userStopped: false, status: "live", engine: "dashscope", source: "tab"
      });
      tabStates.set(2, {
        tabId: 2, jobId: "job-b", mediaEpoch: 1, captureStarted: false,
        userStopped: false, status: "starting", engine: "local", source: "tab"
      });
      tabStates.set(3, {
        tabId: 3, jobId: "job-c", mediaEpoch: 1, captureStarted: false,
        userStopped: false, status: "starting", engine: "local", source: "tab"
      });
      captureTabId = 1;
    `, h.ctx);
    const startB = vm.runInContext(`startOfflineSession(tabStates.get(2), { allowHandoff: true })`, h.ctx);
    await flush();
    await vm.runInContext(`startOfflineSession(tabStates.get(3), { allowHandoff: true })`, h.ctx);
    releaseStopA({ ok: true });
    await startB;
    const finalRoute = vm.runInContext(`({
      captureTabId,
      a: tabStates.get(1),
      b: tabStates.get(2),
      c: tabStates.get(3)
    })`, h.ctx);
    check(finalRoute.captureTabId === 3 && finalRoute.c.captureStarted === true,
      "the newest C intent remains the global capture route");
    check(finalRoute.a.captureStarted === false && finalRoute.a.userStopped === true
        && finalRoute.b.captureStarted === false,
      "stopped A stays sealed and superseded B never becomes active");
    console.log("T8 background handoff intent PASS");
  }
  {
    // B 已走到清理旧提示、但尚未提交 captureTabId 时，C 可以成为更新意图；
    // B 的 clearMediaIssue 晚到后也不能写入 provisional active 状态。
    const h = makeCtx({ captureStarted: false });
    h.ctx.chrome.storage.local.get = async () => ({ koeApiKey: "key" });
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_START") return { ok: true, audioPositionMs: 0 };
      return { ok: true };
    };
    vm.runInContext(`
      ensureContentScript = async () => undefined;
      syncAuthorizationRule = async () => undefined;
      ensureOffscreen = async () => undefined;
      clearTranscript = async () => undefined;
      persistStates = async () => undefined;
      sendToContent = async () => undefined;
      globalThis.__releaseIssueClear = null;
      globalThis.__issueClearGate = new Promise((resolve) => { globalThis.__releaseIssueClear = resolve; });
      clearMediaIssue = async (state) => {
        if (state.tabId === 2) await globalThis.__issueClearGate;
      };
      tabStates.set(2, {
        tabId: 2, frameId: 0, jobId: "job-b-provisional", mediaEpoch: 1,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      tabStates.set(3, {
        tabId: 3, frameId: 0, jobId: "job-c-provisional", mediaEpoch: 1,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      captureTabId = null;
    `, h.ctx);
    const startB = vm.runInContext(`startCapture(tabStates.get(2), "stream-b")`, h.ctx);
    await flush();
    await vm.runInContext(`startCapture(tabStates.get(3), "stream-c")`, h.ctx);
    vm.runInContext(`globalThis.__releaseIssueClear()`, h.ctx);
    await startB;
    const finalRoute = vm.runInContext(`({
      captureTabId,
      b: tabStates.get(2),
      c: tabStates.get(3)
    })`, h.ctx);
    check(finalRoute.captureTabId === 3 && finalRoute.c.captureStarted === true
        && finalRoute.c.status === "live",
      "C remains active when it supersedes B during issue cleanup");
    check(finalRoute.b.captureStarted === false,
      "superseded B never commits a provisional active state");
    console.log("T9 provisional live intent PASS");
  }
  {
    // B 已提交 provisional active 并在清空旧字幕时等待；C 是更新的启动请求，
    // 但连内容脚本预检都没通过。C 不能提前作废 B，让 B 留在假 starting。
    const h = makeCtx({ captureStarted: false });
    h.ctx.chrome.storage.local.get = async () => ({ koeApiKey: "key" });
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_START") return { ok: true, audioPositionMs: 0 };
      return { ok: true };
    };
    vm.runInContext(`
      ensureContentScript = async (tabId) => {
        if (tabId === 3) throw new Error("content injection failed");
      };
      syncAuthorizationRule = async () => undefined;
      ensureOffscreen = async () => undefined;
      clearMediaIssue = async () => undefined;
      persistStates = async () => undefined;
      sendToContent = async () => undefined;
      globalThis.__releaseTranscriptClear = null;
      globalThis.__transcriptClearEntered = false;
      globalThis.__transcriptClearGate = new Promise((resolve) => {
        globalThis.__releaseTranscriptClear = resolve;
      });
      clearTranscript = async () => {
        globalThis.__transcriptClearEntered = true;
        await globalThis.__transcriptClearGate;
      };
      tabStates.set(2, {
        tabId: 2, frameId: 0, jobId: "job-b-preflight", mediaEpoch: 1,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      tabStates.set(3, {
        tabId: 3, frameId: 0, jobId: "job-c-preflight", mediaEpoch: 1,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      captureTabId = null;
      captureAttemptId = 0;
      captureIntentId = 0;
    `, h.ctx);
    const startB = vm.runInContext(`startCapture(tabStates.get(2), "stream-b")`, h.ctx);
    await flush();
    await flush();
    check(vm.runInContext(`globalThis.__transcriptClearEntered`, h.ctx) === true,
      "B reaches its provisional active wait");
    const resultC = await vm.runInContext(`startCapture(tabStates.get(3), "stream-c")
      .then(() => ({ ok: true })).catch((error) => ({ ok: false, error: error.message }))`, h.ctx);
    check(resultC.ok === false && resultC.error === "content injection failed",
      "C exits during fallible preflight");
    vm.runInContext(`globalThis.__releaseTranscriptClear()`, h.ctx);
    await startB;
    const finalRoute = vm.runInContext(`({
      captureTabId,
      b: tabStates.get(2),
      c: tabStates.get(3)
    })`, h.ctx);
    const starts = h.sent.filter((message) => message.type === "CAPTURE_START");
    check(finalRoute.captureTabId === 2 && finalRoute.b.captureStarted === true
        && finalRoute.b.status === "live",
      "failed C preflight leaves B as the real live route");
    check(starts.length === 1 && starts[0].tabId === 2 && starts[0].streamId === "stream-b",
      "B still submits exactly one real capture start");
    console.log("T10 failed newer preflight preserves active start PASS");
  }
  {
    // 较早 C 的预检很慢，较晚 D 已经完整启动后，C 再恢复也不能反抢。
    // 这防止把 committed intent 简单后移后引入“慢请求最后赢”的新竞态。
    const h = makeCtx({ captureStarted: false });
    h.ctx.chrome.storage.local.get = async () => ({ koeApiKey: "key" });
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_START") return { ok: true, audioPositionMs: 0 };
      return { ok: true };
    };
    vm.runInContext(`
      globalThis.__releaseSlowPreflight = null;
      globalThis.__slowPreflightEntered = false;
      globalThis.__slowPreflightGate = new Promise((resolve) => {
        globalThis.__releaseSlowPreflight = resolve;
      });
      ensureContentScript = async (tabId) => {
        if (tabId === 2) {
          globalThis.__slowPreflightEntered = true;
          await globalThis.__slowPreflightGate;
        }
      };
      syncAuthorizationRule = async () => undefined;
      ensureOffscreen = async () => undefined;
      clearMediaIssue = async () => undefined;
      clearTranscript = async () => undefined;
      persistStates = async () => undefined;
      sendToContent = async () => undefined;
      tabStates.set(2, {
        tabId: 2, frameId: 0, jobId: "job-c-slow", mediaEpoch: 1,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      tabStates.set(3, {
        tabId: 3, frameId: 0, jobId: "job-d-fast", mediaEpoch: 1,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      captureTabId = null;
      captureAttemptId = 0;
      captureIntentId = 0;
    `, h.ctx);
    const startC = vm.runInContext(`startCapture(tabStates.get(2), "stream-c")`, h.ctx);
    await flush();
    check(vm.runInContext(`globalThis.__slowPreflightEntered`, h.ctx) === true,
      "older C is waiting in preflight");
    await vm.runInContext(`startCapture(tabStates.get(3), "stream-d")`, h.ctx);
    vm.runInContext(`globalThis.__releaseSlowPreflight()`, h.ctx);
    await startC;
    const finalRoute = vm.runInContext(`({ captureTabId, c: tabStates.get(2), d: tabStates.get(3) })`, h.ctx);
    const starts = h.sent.filter((message) => message.type === "CAPTURE_START");
    check(finalRoute.captureTabId === 3 && finalRoute.d.captureStarted === true
        && finalRoute.d.status === "live" && finalRoute.c.captureStarted === false,
      "the later successful D attempt remains active");
    check(starts.length === 1 && starts[0].tabId === 3 && starts[0].streamId === "stream-d",
      "slow C never submits a stale CAPTURE_START");
    console.log("T11 slow older preflight cannot reclaim route PASS");
  }
  {
    // 用户在预检等待期间明确停止，释放等待后也绝不能迟到启动。
    const h = makeCtx({ captureStarted: false });
    h.ctx.chrome.storage.local.get = async () => ({ koeApiKey: "key" });
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_START") return { ok: true, audioPositionMs: 0 };
      return { ok: true };
    };
    vm.runInContext(`
      globalThis.__releaseStoppedPreflight = null;
      globalThis.__stoppedPreflightGate = new Promise((resolve) => {
        globalThis.__releaseStoppedPreflight = resolve;
      });
      ensureContentScript = async () => globalThis.__stoppedPreflightGate;
      syncAuthorizationRule = async () => undefined;
      ensureOffscreen = async () => undefined;
      clearMediaIssue = async () => undefined;
      clearTranscript = async () => undefined;
      persistStates = async () => undefined;
      sendToContent = async () => undefined;
      tabStates.set(2, {
        tabId: 2, frameId: 0, jobId: "job-stop-preflight", mediaEpoch: 1,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      captureTabId = null;
      captureAttemptId = 0;
      captureIntentId = 0;
    `, h.ctx);
    const pendingStart = vm.runInContext(`startCapture(tabStates.get(2), "stream-stop")`, h.ctx);
    await flush();
    await vm.runInContext(`stopCaptureForTab(2)`, h.ctx);
    vm.runInContext(`globalThis.__releaseStoppedPreflight()`, h.ctx);
    await pendingStart;
    const finalState = vm.runInContext(`({ captureTabId, state: tabStates.get(2) })`, h.ctx);
    check(finalState.captureTabId === null && finalState.state.captureStarted === false
        && finalState.state.userStopped === true,
      "explicit stop invalidates both pending attempt and committed intent");
    check(!h.sent.some((message) => message.type === "CAPTURE_START"),
      "stopped preflight cannot submit a late CAPTURE_START");
    console.log("T12 stop invalidates pending preflight PASS");
  }
  {
    // B 的 CAPTURE_START 已成功，但收尾清除提示时被 C 接管。B 的迟到
    // continuation 不能在 C 发过 LIVE_STOP(B) 后再次复活旧页会话。
    const h = makeCtx({ captureStarted: false });
    h.ctx.chrome.storage.local.get = async () => ({ koeApiKey: "key" });
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_START") return { ok: true, audioPositionMs: 24 };
      return { ok: true };
    };
    vm.runInContext(`
      ensureContentScript = async () => undefined;
      syncAuthorizationRule = async () => undefined;
      ensureOffscreen = async () => undefined;
      clearTranscript = async () => undefined;
      persistStates = async () => undefined;
      globalThis.__contentMessages = [];
      sendToContent = async (state, message) => {
        globalThis.__contentMessages.push({ tabId: state.tabId, ...message });
      };
      globalThis.__bIssueClearCount = 0;
      globalThis.__bFinalClearEntered = false;
      globalThis.__releaseBFinalClear = null;
      globalThis.__bFinalClearGate = new Promise((resolve) => {
        globalThis.__releaseBFinalClear = resolve;
      });
      clearMediaIssue = async (state) => {
        if (state.tabId !== 2) return;
        globalThis.__bIssueClearCount += 1;
        if (globalThis.__bIssueClearCount === 2) {
          globalThis.__bFinalClearEntered = true;
          await globalThis.__bFinalClearGate;
        }
      };
      tabStates.set(2, {
        tabId: 2, frameId: 0, jobId: "job-b-finalize", mediaEpoch: 2,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      tabStates.set(3, {
        tabId: 3, frameId: 0, jobId: "job-c-takeover", mediaEpoch: 5,
        captureStarted: false, userStopped: false, status: "starting",
        engine: "dashscope", source: "tab", translate: true
      });
      captureTabId = null;
      captureAttemptId = 0;
      captureIntentId = 0;
    `, h.ctx);
    const startB = vm.runInContext(`startCapture(tabStates.get(2), "stream-b-finalize")`, h.ctx);
    await flush();
    await flush();
    check(vm.runInContext(`globalThis.__bFinalClearEntered`, h.ctx) === true,
      "B waits in its successful finalization");
    await vm.runInContext(`startCapture(tabStates.get(3), "stream-c-takeover")`, h.ctx);
    vm.runInContext(`globalThis.__releaseBFinalClear()`, h.ctx);
    await startB;
    const finalRoute = vm.runInContext(`({ captureTabId, b: tabStates.get(2), c: tabStates.get(3) })`, h.ctx);
    const bMessages = vm.runInContext(`globalThis.__contentMessages.filter((message) => message.tabId === 2)`, h.ctx);
    const bStopIndex = bMessages.findIndex((message) => message.type === "LIVE_STOP");
    check(finalRoute.captureTabId === 3 && finalRoute.c.captureStarted === true
        && finalRoute.c.status === "live" && finalRoute.b.captureStarted === false,
      "C remains the only real active route after taking over B");
    check(bStopIndex >= 0
        && !bMessages.slice(bStopIndex + 1).some((message) => message.type === "LIVE_SESSION"),
      `B has no late LIVE_SESSION after STOP (${bMessages.map((message) => message.type).join(" -> ")})`);
    console.log("T13 finalized old tab cannot be revived PASS");
  }
  {
    // 两个设置快速切换会并发等待 CAPTURE_RESET。先发出的旧 reset 即使最后
    // 才返回，也不能借用 state 的新 epoch 再发布一条伪装成最新的 LIVE_SESSION。
    const h = makeCtx({ captureStarted: false });
    const resetResolvers = [];
    h.ctx.chrome.runtime.sendMessage = (message) => {
      h.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.type === "CAPTURE_RESET") {
        return new Promise((resolve) => resetResolvers.push({ message, resolve }));
      }
      return Promise.resolve({ ok: true });
    };
    vm.runInContext(`
      persistStates = async () => undefined;
      globalThis.__contentMessages = [];
      sendToContent = async (state, message) => {
        globalThis.__contentMessages.push(JSON.parse(JSON.stringify(message)));
      };
      tabStates.set(1, {
        tabId: 1, frameId: 0, jobId: "job-rapid-policy", mediaEpoch: 4,
        captureStarted: true, userStopped: false, status: "live",
        engine: "dashscope", source: "tab", translate: false,
        skipSameLanguage: true, preferredLanguage: ""
      });
      captureTabId = 1;
    `, h.ctx);
    const older = vm.runInContext(`setTranslate(1, true)`, h.ctx);
    await flush();
    const newer = vm.runInContext(`setSkipSameLanguage(1, false)`, h.ctx);
    await flush();
    check(resetResolvers.length === 2
        && resetResolvers[0].message.mediaEpoch === 5
        && resetResolvers[1].message.mediaEpoch === 6,
      "rapid policy changes submit distinct reset identities");
    resetResolvers[1].resolve({ ok: true, audioPositionMs: 600 });
    await newer;
    resetResolvers[0].resolve({ ok: true, audioPositionMs: 500 });
    await older;
    const sessions = vm.runInContext(`globalThis.__contentMessages.filter((message) => message.type === "LIVE_SESSION")`, h.ctx);
    check(sessions.length === 1 && sessions[0].mediaEpoch === 6
        && sessions[0].audioPositionMs === 600,
      `only the newest reset can announce a live session (${JSON.stringify(sessions)})`);
    console.log("T14 rapid reset cannot publish stale session PASS");
  }
  console.log(fail === 0 ? "stop-always 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
