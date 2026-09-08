// Exercise real background lifecycle functions with deferred browser responses.
// All media, storage and Native Messaging data in this file are synthetic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function makeContext({ engine = "local", active = true } = {}) {
  const sent = [];
  const native = [];
  const content = [];
  const local = {
    koePreferencesVersion: 1, koeCaptureSource: "tab", koeAsrEngine: engine,
    koeTranslate: true, koeSkipSameLanguage: true
  };
  const event = { addListener() {} };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    chrome: {
      storage: {
        local: { get: async () => ({ ...local }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} }, onChanged: event
      },
      runtime: {
        onMessage: event, onStartup: event, onInstalled: event,
        getURL: (file) => `chrome-extension://test/${file}`,
        sendMessage: async (message) => { sent.push(message); return { ok: true }; },
        connectNative: () => ({
          postMessage: (message) => native.push(message), disconnect() {},
          onMessage: event, onDisconnect: event
        })
      },
      i18n: { getUILanguage: () => "zh-CN" },
      tabs: {
        query: async () => [], get: async (id) => ({ id }),
        sendMessage: async (tabId, message) => { content.push({ tabId, ...message }); },
        onRemoved: event, onUpdated: event, onActivated: event
      },
      tabCapture: { getMediaStreamId: async () => "synthetic-stream" },
      contextMenus: { create() {}, remove(_id, done) { done?.(); }, onClicked: event },
      commands: { onCommand: event }, alarms: { onAlarm: event },
      webRequest: { onBeforeRequest: event },
      action: { setPopup: async () => {}, setBadgeText: async () => {} },
      sidePanel: { setPanelBehavior: async () => {}, setOptions: async () => {} },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => {} },
      declarativeNetRequest: { updateSessionRules: async () => {} }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx);
  const run = (source) => vm.runInContext(source, ctx);
  await run("bootPromise");
  run(`
    ensureContentScript = async () => {};
    discoverVideoSource = async () => ({
      hasVideo: true, playing: true, muted: false, frameId: 0,
      sourceUrl: "https://media.example.test/video.m3u8",
      pageUrl: "https://example.test/watch"
    });
    tabStates.set(1, {
      tabId: 1, frameId: 0, jobId: "old-job", mediaEpoch: 1,
      engine: ${JSON.stringify(engine)}, sessionMode: ${JSON.stringify(engine === "local" ? "offline" : "live")},
      source: "tab", captureStarted: ${active}, userStopped: false,
      status: ${JSON.stringify(active ? "live" : "starting")}, translate: true,
      skipSameLanguage: true, preferredLanguage: "zh-CN",
      sourceUrl: "https://media.example.test/video.m3u8", pageUrl: "https://example.test/watch"
    });
    captureTabId = ${active ? "1" : "null"};
  `);
  return { ctx, run, sent, native, content, local };
}

async function stopCannotOverwriteRestart(active, pauseAtStatusClear = false) {
  const h = await makeContext({ active });
  const gate = deferred();
  if (pauseAtStatusClear) {
    h.run('tabStates.get(1).issueKind = "error"; tabStates.get(1).issueCode = "capture_failed"');
    h.ctx.chrome.tabs.sendMessage = async (_tabId, message) => {
      if (message.type === "KOE_MEDIA_STATUS") await gate.promise;
    };
  } else {
    h.run("tabStates.get(1).localFallbackActive = true");
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      h.sent.push(message);
      if (message.type === "CAPTURE_STOP") await gate.promise;
      return { ok: true };
    };
  }
  const stopping = h.run("stopCaptureForTab(1)");
  await flush();
  if (!pauseAtStatusClear) {
    assert.equal(h.run("tabStates.get(1).userStopped"), true,
      "stop closes the automatic-start gate before waiting for audio cleanup");
  }
  // A manual retry mutates the existing tab state instead of replacing it.
  h.run(`
    Object.assign(tabStates.get(1), {
      jobId: "new-job", mediaEpoch: 2, captureStarted: true, userStopped: false,
      status: "live", stageDetail: "new session", localFallbackActive: true,
      offlineContext: { currentTimeMs: 1234 }, offlineSourceUrl: "new-source",
      sourceUrl: "https://media.example.test/new.m3u8", issueKind: "", issueCode: ""
    });
    captureTabId = 1;
    captureStreamIds.set(1, "new-stream");
    mediaCandidatesByTab.set(1, [{ url: "new-candidate" }]);
  `);
  const before = h.run("JSON.stringify({ state: tabStates.get(1), captureTabId })");
  gate.resolve();
  await stopping;
  assert.equal(h.run("JSON.stringify({ state: tabStates.get(1), captureTabId })"), before,
    "late stop cleanup preserves every field and the route of the replacement session");
  assert.equal(h.run("captureStreamIds.get(1)"), "new-stream");
  assert.equal(h.run("mediaCandidatesByTab.get(1)[0].url"), "new-candidate");
}

async function stoppedDiscoveryStaysStopped(active, hasState = true, pauseAtInjection = false) {
  const h = await makeContext({ active });
  if (!hasState) h.run("tabStates.clear(); captureTabId = null");
  const gate = deferred();
  h.ctx.discoveryGate = gate.promise;
  h.run(pauseAtInjection
    ? "ensureContentScript = async () => { await discoveryGate; }"
    : `discoverVideoSource = async () => {
      await discoveryGate;
      return { hasVideo: true, playing: true, muted: false, frameId: 0,
        sourceUrl: "https://media.example.test/late.m3u8", pageUrl: "https://example.test/watch" };
    }`);
  const pending = h.run(`ensureLiveCaptions({ tabId: 1,
    pageUrl: "https://example.test/watch", forceReset: ${!active}, mediaChanged: ${active} })`);
  await flush();
  await h.run("stopCaptureForTab(1)");
  const stopped = h.run("JSON.stringify(tabStates.get(1) || null)");
  const nativeCount = h.native.length;
  gate.resolve();
  await pending;
  assert.equal(h.run("JSON.stringify(tabStates.get(1) || null)"), stopped,
    "discovery finishing after stop cannot create, rewrite or restart the stopped task");
  assert.equal(h.run("captureTabId"), null);
  assert.equal(h.native.length, nativeCount, "cancelled discovery cannot contact the Helper");
}

async function staleAuthorizationFailureStaysSilent() {
  const h = await makeContext({ engine: "dashscope", active: false });
  const gate = deferred();
  h.ctx.authorizationGate = gate.promise;
  h.run("ensureContentScript = async () => { await authorizationGate; }");
  const pending = h.run("ensureCaptureAuthorized(tabStates.get(1))");
  await flush();
  await h.run("stopCaptureForTab(1)");
  const stopped = h.run("JSON.stringify(tabStates.get(1))");
  gate.reject(new Error("old injection failed"));
  await pending;
  assert.equal(h.run("JSON.stringify(tabStates.get(1))"), stopped,
    "an abandoned start cannot replace the stopped UI with an old error");
}

async function retryDoesNotWaitForOldAuthorization(failOldRequest) {
  const h = await makeContext({ engine: "dashscope", active: false });
  h.local.koeApiKey = "synthetic-test-key";
  const gate = deferred();
  let requests = 0;
  h.ctx.chrome.tabCapture.getMediaStreamId = async () => {
    requests += 1;
    return requests === 1 ? gate.promise : "new-stream";
  };
  const old = h.run("ensureCaptureAuthorized(tabStates.get(1))");
  await flush();
  await h.run("stopCaptureForTab(1)");
  const retry = h.run('startCaptureForTab({ tabId: 1, pageUrl: "https://example.test/watch" })');
  await flush();
  // Release even a broken implementation so regressions fail rather than hang.
  const retriedImmediately = requests === 2 && h.run("tabStates.get(1).captureStarted");
  if (failOldRequest) gate.reject(new Error("old permission request failed"));
  else gate.resolve("old-stream");
  const results = await Promise.allSettled([old, retry]);
  assert.equal(retriedImmediately, true, "retry starts without waiting for the cancelled request");
  assert(results.every((result) => result.status === "fulfilled"), "superseded authorization finishes quietly");
  const starts = h.sent.filter((message) => message.type === "CAPTURE_START");
  assert.equal(starts.length, 1, "the old authorization must never submit another capture");
  assert.equal(starts[0].streamId, "new-stream");
  assert.equal(h.run("tabStates.get(1).status"), "live");
  assert.equal(h.run("tabStates.get(1).userStopped"), false);
}

async function currentFailureRemainsVisible() {
  const h = await makeContext({ engine: "dashscope", active: false });
  await h.run("ensureCaptureAuthorized(tabStates.get(1))");
  assert.equal(h.run("tabStates.get(1).status"), "error");
  assert.equal(h.run("tabStates.get(1).issueCode"), "capture_failed");
  assert.match(h.run("tabStates.get(1).stageDetail"), /DashScope API Key/);
}

async function modeChangeStillStarts() {
  const h = await makeContext({ engine: "dashscope" });
  h.local.koeAsrEngine = "local";
  await h.run('ensureLiveCaptions({ tabId: 1, pageUrl: "https://example.test/watch" })');
  assert.equal(h.run("tabStates.get(1).engine"), "local");
  assert.equal(h.run("tabStates.get(1).captureStarted"), true);
  assert.equal(h.run("captureTabId"), 1);
  assert(h.sent.some((message) => message.type === "CAPTURE_STOP" && message.jobId === "old-job"));
  assert(h.content.some((message) => message.type === "OFFLINE_SESSION"));
}

async function handoffInvalidatesOldDiscovery() {
  const h = await makeContext();
  const gate = deferred();
  h.ctx.discoveryGate = gate.promise;
  h.run(`
    const originalDiscovery = discoverVideoSource;
    discoverVideoSource = async (...args) => { await discoveryGate; return originalDiscovery(...args); };
    tabStates.set(2, { ...tabStates.get(1), tabId: 2, jobId: "new-tab", captureStarted: false });
  `);
  const pending = h.run('ensureLiveCaptions({ tabId: 1, pageUrl: "https://example.test/old", forceReset: true })');
  await flush();
  await h.run("startOfflineSession(tabStates.get(2))");
  const afterHandoff = h.run("JSON.stringify([...tabStates])");
  gate.resolve();
  await pending;
  assert.equal(h.run("JSON.stringify([...tabStates])"), afterHandoff);
  assert.equal(h.run("captureTabId"), 2, "late discovery cannot reclaim the active tab");
}

async function staleOfflineStartCannotReuseNewIdentity() {
  const h = await makeContext({ active: false });
  const gate = deferred();
  h.run('tabStates.get(1).issueKind = "error"');
  h.ctx.chrome.tabs.sendMessage = async (_tabId, message) => {
    if (message.type === "KOE_MEDIA_STATUS") await gate.promise;
    h.content.push(message);
  };
  const pending = h.run("startOfflineSession(tabStates.get(1))");
  await flush();
  await h.run("stopCaptureForTab(1)");
  await h.run('startCaptureForTab({ tabId: 1, pageUrl: "https://example.test/watch" })');
  const current = h.run("JSON.stringify(tabStates.get(1))");
  const nativeCount = h.native.length;
  gate.resolve();
  await pending;
  assert.equal(h.run("JSON.stringify(tabStates.get(1))"), current);
  assert.equal(h.native.length, nativeCount, "old offline startup cannot launch again under the retry identity");
}

async function fallbackCannotOverwriteRestart(boundary) {
  const h = await makeContext();
  const gate = deferred();
  let entered = false;
  h.run('tabStates.get(1).issueKind = "action"');
  const hold = async (message) => {
    if (message.type === boundary) { entered = true; await gate.promise; }
  };
  h.ctx.chrome.tabs.sendMessage = async (_id, message) => { h.content.push(message); await hold(message); };
  h.ctx.chrome.runtime.sendMessage = async (message) => {
    h.sent.push(message);
    await hold(message);
    return boundary === "CAPTURE_STOP" && message.type === "CAPTURE_START"
      ? { ok: false, error: "synthetic capture failure" } : { ok: true };
  };
  const pending = h.run('startLocalLiveFallback(tabStates.get(1), "old-stream")');
  await flush();
  assert.equal(entered, true, `fallback reaches ${boundary}`);
  h.run(`Object.assign(tabStates.get(1), {
    jobId: "new-fallback-job", mediaEpoch: 2, captureStarted: true,
    userStopped: false, status: "live", stageDetail: "new session",
    localFallbackActive: true, captureNeedsGesture: false, issueKind: "", issueCode: ""
  }); captureTabId = 1; transcriptCache = [{ text: "new transcript" }]; transcriptHydrated = true;`);
  const current = h.run("JSON.stringify(tabStates.get(1))");
  const nativeCount = h.native.length;
  const contentCount = h.content.length;
  gate.resolve();
  await pending;
  assert.equal(h.run("JSON.stringify(tabStates.get(1))"), current, "old fallback must preserve the replacement state");
  assert.equal(h.native.length, nativeCount, "old fallback must not submit more native work");
  assert.equal(h.content.length, contentCount, "old fallback must not announce or stop the replacement session");
  assert.equal(h.run("transcriptCache[0]?.text"), "new transcript", "old fallback must preserve the new transcript");
}

async function manualFallbackRespectsStop() {
  const h = await makeContext();
  const gate = deferred();
  h.ctx.startGate = gate.promise;
  h.run(`
    tabStates.get(1).offlineMissingMediaSince = 1;
    let injections = 0;
    ensureContentScript = async () => { if (++injections === 1) await startGate; };
  `);
  const pending = h.run('startCaptureForTab({ tabId: 1, streamId: "old-stream", pageUrl: "https://example.test/watch" })');
  await flush();
  await h.run("stopCaptureForTab(1)");
  const stopped = h.run("JSON.stringify(tabStates.get(1))");
  gate.resolve();
  await pending;
  assert.equal(h.run("JSON.stringify(tabStates.get(1))"), stopped,
    "cancelled fallback must not restart discovery from the old manual start");
  assert.equal(h.run("captureTabId"), null);
}

async function fallbackRetryDoesNotWait() {
  const h = await makeContext();
  const gate = deferred();
  h.ctx.startGate = gate.promise;
  h.run(`
    let injections = 0;
    ensureContentScript = async () => { if (++injections === 1) await startGate; };
  `);
  const old = h.run('startLocalLiveFallback(tabStates.get(1), "old-stream")');
  await flush();
  await h.run("stopCaptureForTab(1)");
  h.run(`Object.assign(tabStates.get(1), {
    jobId: "new-fallback", mediaEpoch: 2, captureStarted: true, userStopped: false
  }); captureTabId = 1;`);
  const retry = h.run('startLocalLiveFallback(tabStates.get(1), "new-stream")');
  await flush();
  const startedImmediately = h.sent.some((message) => message.type === "CAPTURE_START"
    && message.jobId === "new-fallback" && message.streamId === "new-stream");
  gate.resolve();
  await Promise.all([old, retry]);
  assert.equal(startedImmediately, true, "new local fallback bypasses the old pending session");
  assert.equal(h.sent.filter((message) => message.type === "CAPTURE_START").length, 1);
}

async function lateDiscoveryFailureStaysSilent() {
  const h = await makeContext({ active: false });
  const gate = deferred();
  h.ctx.startGate = gate.promise;
  h.run("ensureContentScript = async () => { await startGate; }");
  const pending = h.run("ensureLiveCaptions({ tabId: 1, forceReset: true })");
  await flush();
  await h.run("stopCaptureForTab(1)");
  gate.reject(new Error("old page disappeared"));
  assert.equal((await pending).skipped, true, "late discovery failure is treated as a cancelled request");
  assert.equal(h.run("tabStates.get(1).status"), "idle");
}

async function cancelledAuthorizationCannotUseRetryDiscovery(kind) {
  const h = await makeContext({ engine: "dashscope", active: false });
  h.local.koeApiKey = "synthetic-test-key";
  const oldGate = deferred();
  const retryGate = deferred();
  if (kind === "injection-error") {
    h.ctx.oldGate = oldGate.promise;
    h.run("ensureContentScript = async () => { await oldGate; }");
  } else {
    h.ctx.chrome.tabCapture.getMediaStreamId = async () => oldGate.promise;
  }
  const old = h.run("ensureCaptureAuthorized(tabStates.get(1))").then(() => null, (error) => error);
  await flush();
  await h.run("stopCaptureForTab(1)");
  h.ctx.retryGate = retryGate.promise;
  h.run(`
    const discoverRetrySource = discoverVideoSource;
    discoverVideoSource = async (...args) => { await retryGate; return discoverRetrySource(...args); };
  `);
  const retry = h.run('startCaptureForTab({ tabId: 1, streamId: "retry-stream", pageUrl: "https://example.test/watch" })');
  await flush();
  const current = h.run("JSON.stringify(tabStates.get(1))");
  if (kind.endsWith("error")) oldGate.reject(new Error("old browser request failed"));
  else oldGate.resolve("old-stream");
  const oldError = await old;
  const afterOld = h.run("JSON.stringify(tabStates.get(1))");
  const startedOld = h.sent.some((message) => message.type === "CAPTURE_START");
  h.run("ensureContentScript = async () => {}");
  retryGate.resolve();
  await retry;
  assert.equal(oldError, null, "cancelled authorization finishes quietly during retry discovery");
  assert.equal(afterOld, current, "the retry's temporary reuse of the old identity cannot revive an old error");
  assert.equal(startedOld, false, "old authorization cannot start while the retry is still discovering media");
  assert.equal(h.sent.filter((message) => message.type === "CAPTURE_START").at(-1)?.streamId, "retry-stream");
}

// A missed deferred response must fail the suite, not let Node exit successfully
// with the main promise still pending and later cases silently unexecuted.
const watchdog = setTimeout(() => {
  console.error("FAIL session boundary tests timed out");
  process.exit(1);
}, 10_000);

(async () => {
  const cases = [
    ["active stop / restart", () => stopCannotOverwriteRestart(true)],
    ["restored stop / restart", () => stopCannotOverwriteRestart(false)],
    ["stop status clear / restart", () => stopCannotOverwriteRestart(true, true)],
    ["maintenance discovery / stop", () => stoppedDiscoveryStaysStopped(true)],
    ["manual discovery / stop", () => stoppedDiscoveryStaysStopped(false)],
    ["first discovery / stop", () => stoppedDiscoveryStaysStopped(false, false)],
    ["script injection / stop", () => stoppedDiscoveryStaysStopped(true, true, true)],
    ["authorization failure / stop", staleAuthorizationFailureStaysSilent],
    ["retry / old authorization success", () => retryDoesNotWaitForOldAuthorization(false)],
    ["retry / old authorization failure", () => retryDoesNotWaitForOldAuthorization(true)],
    ["current failure feedback", currentFailureRemainsVisible],
    ["active engine change", modeChangeStillStarts],
    ["discovery / tab handoff", handoffInvalidatesOldDiscovery],
    ["offline startup / retry", staleOfflineStartCannotReuseNewIdentity],
    ...["KOE_MEDIA_STATUS", "OFFLINE_STOP", "LIVE_SESSION", "CAPTURE_STOP"].map((boundary) =>
      [`fallback ${boundary} / restart`, () => fallbackCannotOverwriteRestart(boundary)]),
    ["manual fallback / stop", manualFallbackRespectsStop],
    ["local fallback retry", fallbackRetryDoesNotWait],
    ["late discovery failure", lateDiscoveryFailureStaysSilent],
    ...["authorization-success", "authorization-error", "injection-error"].map((kind) =>
      [`retry discovery / old ${kind}`, () => cancelledAuthorizationCannotUseRetryDiscovery(kind)])
  ];
  let failures = 0;
  for (const [name, test] of cases) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
  }
  assert.equal(failures, 0, "session boundary regressions");
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(watchdog));
