const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(condition, label) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL: ${label}`);
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay = 0) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay: Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runDue(maxDelay = Infinity) {
      while (true) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.delay <= maxDelay)
          .sort(([left], [right]) => left - right);
        if (due.length === 0) return;
        for (const [id, timer] of due) {
          if (!pending.delete(id)) continue;
          timer.callback();
        }
      }
    }
  };
}

function makeContext({ initialized = true } = {}) {
  const timers = makeTimers();
  const sessionStore = {};
  const nativeMessages = [];
  const contentMessages = [];
  const runtimeMessages = [];
  const ports = [];
  let connectCalls = 0;
  let disconnectCalls = 0;
  const localConfig = initialized ? {
    koePreferencesVersion: 1,
    koeCaptureSource: "tab",
    koeAsrEngine: "local",
    koeTranslate: true,
    koeSkipSameLanguage: true,
    koeHideOriginal: false,
    koeOverlayEnabled: true,
    koeOverlaySize: "medium"
  } : {};

  function createPort() {
    const messageListeners = [];
    const disconnectListeners = [];
    let disconnected = false;
    const port = {
      postMessage(message) {
        nativeMessages.push(JSON.parse(JSON.stringify(message)));
      },
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        disconnectCalls += 1;
        for (const listener of disconnectListeners) listener();
      },
      onMessage: { addListener(listener) { messageListeners.push(listener); } },
      onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
      emit(message) {
        for (const listener of messageListeners) listener(message);
      }
    };
    ports.push(port);
    return port;
  }

  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => undefined,
    chrome: {
      storage: {
        local: {
          get: async () => ({ ...localConfig }),
          set: async (values) => Object.assign(localConfig, JSON.parse(JSON.stringify(values)))
        },
        session: {
          get: async (keys) => Object.fromEntries([].concat(keys).map((key) => [key, sessionStore[key]])),
          set: async (values) => Object.assign(sessionStore, JSON.parse(JSON.stringify(values)))
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        id: "test-extension-id",
        lastError: null,
        onMessage: { addListener() {} },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        getURL: (file) => `chrome-extension://test/${file}`,
        connectNative() {
          connectCalls += 1;
          return createPort();
        },
        sendMessage: async (message) => {
          runtimeMessages.push(JSON.parse(JSON.stringify(message)));
          return { ok: true };
        }
      },
      i18n: { getUILanguage: () => "zh-CN" },
      webRequest: { onBeforeRequest: { addListener() {} } },
      alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
      tabs: {
        query: async () => [],
        get: async (tabId) => ({ id: tabId, url: "https://example.com/watch" }),
        sendMessage: async (tabId, message) => contentMessages.push({
          tabId,
          message: JSON.parse(JSON.stringify(message))
        }),
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} }
      },
      contextMenus: { create() {}, remove(_id, callback) { callback?.(); }, onClicked: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      action: {
        openPopup: async () => undefined,
        setPopup: async () => undefined,
        setBadgeText: async () => undefined,
        setBadgeBackgroundColor: async () => undefined,
        setBadgeTextColor: async () => undefined,
        setTitle: async () => undefined
      },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream" },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"),
    ctx,
    { filename: "background.js" }
  );
  return {
    ctx,
    timers,
    nativeMessages,
    contentMessages,
    runtimeMessages,
    ports,
    connectCalls: () => connectCalls,
    disconnectCalls: () => disconnectCalls
  };
}

function installLocalState(run, tabId, jobId) {
  run(`tabStates.set(${tabId}, {
    tabId: ${tabId}, frameId: 0, jobId: ${JSON.stringify(jobId)}, mediaEpoch: 0,
    captureStarted: false, status: "idle", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "https://video.example/media.m3u8",
    pageUrl: "https://example.com/watch", translate: false, userStopped: false,
    mediaIdentity: ${JSON.stringify(`identity-${tabId}`)}
  });`);
}

(async () => {
  {
    const h = makeContext({ initialized: true });
    const run = (source) => vm.runInContext(source, h.ctx);
    await run("bootPromise");
    h.timers.runDue();
    await settle();
    check(h.connectCalls() === 0,
      "initialized browser preferences do not launch the Native Helper during background boot");
  }

  {
    const h = makeContext({ initialized: false });
    const run = (source) => vm.runInContext(source, h.ctx);
    await settle();
    check(h.connectCalls() === 1 && run("nativePreferenceWaiters.size") === 1,
      "a fresh browser profile opens one conditional Native preference restore request");
    run("scheduleNativeIdleDisconnect(0)");
    h.timers.runDue(0);
    check(h.disconnectCalls() === 0 && Boolean(run("nativePort")),
      "a pending Native preference waiter keeps its connection alive");
    await run(`handleNativeMessage({
      type: "preferences",
      preferences: { koePreferencesVersion: 1, koeAsrEngine: "local", koeCaptureSource: "tab" }
    })`);
    await run("bootPromise");
    h.timers.runDue();
    check(h.disconnectCalls() === 1 && run("nativePort") === null,
      "the conditional preference connection closes after its response");
  }

  {
    const h = makeContext({ initialized: true });
    const run = (source) => vm.runInContext(source, h.ctx);
    await run("bootPromise");
    installLocalState(run, 1, "local-1");
    await run("startOfflineSession(tabStates.get(1))");
    h.timers.runDue();
    check(h.connectCalls() === 1 && h.disconnectCalls() === 0 && Boolean(run("nativePort")),
      "an active local session keeps the Native Helper connected");

    const response = await run(`stopCaptureForTab({ tabId: 1, jobId: "local-1" })`);
    h.timers.runDue();
    const stopped = run("tabStates.get(1)");
    check(response?.ok === true
        && h.nativeMessages.some((message) => message.type === "cancel")
        && h.disconnectCalls() === 1 && run("nativePort") === null,
      "stopping the last local session cancels work and actively closes the Helper");
    check(stopped.captureStarted === false && stopped.status === "idle" && stopped.userStopped === true,
      "an intentional Native disconnect does not rewrite the stopped session as an error");
  }

  {
    const h = makeContext({ initialized: true });
    const run = (source) => vm.runInContext(source, h.ctx);
    await run("bootPromise");
    installLocalState(run, 1, "local-a");
    installLocalState(run, 2, "local-b");
    await run("startOfflineSession(tabStates.get(1))");
    h.timers.runDue();
    run("tabStates.get(1).localFallbackActive = true");
    let releaseOldStop;
    let oldStopReached = false;
    h.ctx.chrome.runtime.sendMessage = (message) => {
      h.runtimeMessages.push(JSON.parse(JSON.stringify(message)));
      if (!oldStopReached && message.type === "CAPTURE_STOP") {
        oldStopReached = true;
        return new Promise((resolve) => { releaseOldStop = resolve; });
      }
      return Promise.resolve({ ok: true });
    };
    const handoff = run("startOfflineSession(tabStates.get(2), { allowHandoff: true })");
    await settle();
    check(oldStopReached && typeof releaseOldStop === "function",
      "a local handoff can wait for the old capture to release");
    run("scheduleNativeIdleDisconnect(0)");
    h.timers.runDue(0);
    check(h.disconnectCalls() === 0 && Boolean(run("nativePort"))
        && run("nativeSessionStartWaiters") === 1,
      "an idle-close firing inside an asynchronous handoff keeps the Helper connected");
    releaseOldStop({ ok: true });
    await handoff;
    h.timers.runDue();
    const route = run("({ captureTabId, a: tabStates.get(1), b: tabStates.get(2), nativePort })");
    check(route.captureTabId === 2 && route.a.captureStarted === false && route.b.captureStarted === true,
      "a local-to-local handoff leaves only the new session active");
    check(h.connectCalls() === 1 && h.disconnectCalls() === 0 && Boolean(route.nativePort),
      "the old session's idle-close request cannot disconnect the newly active local handoff");
  }

  console.log(failures === 0 ? "native lifecycle regression PASS" : `${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
