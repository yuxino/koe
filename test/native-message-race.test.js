const fs = require("fs");
const vm = require("vm");

let failures = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failures += 1;
  }
};

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBackgroundContext() {
  const sessionStore = {};
  const localStore = {
    koePreferencesVersion: 1,
    koeCaptureSource: "tab",
    koeAsrEngine: "local",
    koeTranslate: true,
    koeSkipSameLanguage: true
  };
  const runtimeMessages = [];
  const contentMessages = [];
  let runtimeGate = null;
  let contentGate = null;
  const nativePort = {
    postMessage() {},
    disconnect() {},
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} }
  };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: {
          get: async () => ({ ...localStore }),
          set: async (values) => Object.assign(localStore, values)
        },
        session: {
          get: async (keys) => Object.fromEntries(
            [].concat(keys).map((key) => [key, sessionStore[key]])
          ),
          set: async (values) => Object.assign(sessionStore, clone(values))
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        id: "test-extension-id",
        lastError: null,
        onMessage: { addListener() {} },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        getURL: (path) => `chrome-extension://test/${path}`,
        connectNative: () => nativePort,
        sendMessage: async (message) => {
          const snapshot = clone(message);
          runtimeMessages.push(snapshot);
          const gate = runtimeGate;
          if (gate && gate.predicate(snapshot)) {
            runtimeGate = null;
            gate.entered.resolve(snapshot);
            await gate.release.promise;
          }
          return { ok: true };
        }
      },
      i18n: { getUILanguage: () => "zh-CN" },
      webRequest: { onBeforeRequest: { addListener() {} } },
      alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
      tabs: {
        query: async () => [],
        get: async () => null,
        sendMessage: async (tabId, message) => {
          const snapshot = { tabId, message: clone(message) };
          contentMessages.push(snapshot);
          const gate = contentGate;
          if (gate && gate.predicate(snapshot)) {
            contentGate = null;
            gate.entered.resolve(snapshot);
            await gate.release.promise;
          }
          return { ok: true };
        },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} }
      },
      contextMenus: {
        create() {},
        remove(_id, callback) { callback?.(); },
        onClicked: { addListener() {} }
      },
      commands: { onCommand: { addListener() {} } },
      action: {
        openPopup: async () => undefined,
        setPopup: async () => undefined,
        setBadgeText: async () => undefined,
        setBadgeBackgroundColor: async () => undefined,
        setBadgeTextColor: async () => undefined,
        setTitle: async () => undefined
      },
      sidePanel: {
        open: async () => undefined,
        setOptions: async () => undefined,
        setPanelBehavior: async () => undefined
      },
      tabCapture: { getMediaStreamId: async () => "stream-test" },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });

  const holdRuntimeMessage = (predicate) => {
    const entered = deferred();
    const release = deferred();
    runtimeGate = { predicate, entered, release };
    return { entered: entered.promise, release: release.resolve };
  };
  const holdContentMessage = (predicate) => {
    const entered = deferred();
    const release = deferred();
    contentGate = { predicate, entered, release };
    return { entered: entered.promise, release: release.resolve };
  };
  return { ctx, runtimeMessages, contentMessages, holdRuntimeMessage, holdContentMessage };
}

(async () => {
  {
    const harness = makeBackgroundContext();
    const run = (source) => vm.runInContext(source, harness.ctx);
    await run("bootPromise");
    run(`tabStates.set(21, {
      tabId: 21, frameId: 0, jobId: "old-cues-job", mediaEpoch: 4,
      captureStarted: true, engine: "local", localFallbackActive: false,
      status: "starting", stageDetail: "old session", issueKind: "action",
      issueCode: "capture_authorization", offlineCueRevision: 0,
      offlineContext: { durationMs: 120000 }, userStopped: false
    }); captureTabId = 21;`);

    const gate = harness.holdContentMessage(({ message }) => message.type === "KOE_MEDIA_STATUS");
    const pending = run(`handleNativeMessage({
      type: "cues", jobId: "old-cues-job", mediaEpoch: 4, revision: 1,
      cues: [{ cueId: "old-cue", startMs: 1000, endMs: 2000, text: "Old session cue" }]
    })`);
    await gate.entered;
    run(`Object.assign(tabStates.get(21), {
      jobId: "new-cues-job", mediaEpoch: 5, captureStarted: true,
      status: "starting", stageDetail: "new session starting", issueKind: "",
      issueCode: "", offlineCueRevision: 0, offlineContext: { durationMs: 180000 },
      userStopped: false
    }); captureTabId = 21;`);
    gate.release();
    await pending;

    const relabeledCue = harness.contentMessages.find(({ message }) => (
      message.type === "OFFLINE_CUES"
        && message.jobId === "new-cues-job"
        && message.mediaEpoch === 5
        && message.cues?.some((cue) => cue.cueId === "old-cue")
    ));
    check(!relabeledCue,
      "old native cues are never relabeled into a replacement job/epoch after an await");
    check(run(`tabStates.get(21).status === "starting"
      && tabStates.get(21).stageDetail === "new session starting"
      && tabStates.get(21).offlineCueRevision === 0`) === true,
    "old native cues cannot mark the replacement session live or advance its revision");
  }

  {
    const harness = makeBackgroundContext();
    const run = (source) => vm.runInContext(source, harness.ctx);
    await run("bootPromise");
    run(`tabStates.set(22, {
      tabId: 22, frameId: 0, jobId: "old-error-job", mediaEpoch: 7,
      captureStarted: true, engine: "local", localFallbackActive: true,
      status: "live", stageDetail: "old session live", issueKind: "", issueCode: "",
      sourceUrl: "blob:https://example.test/old", userStopped: false
    }); captureTabId = 22;`);

    const gate = harness.holdRuntimeMessage((message) => message.type === "CAPTURE_STOP");
    const pending = run(`handleNativeMessage({
      type: "error", jobId: "old-error-job", mediaEpoch: 7,
      error: "old helper failure", issueCode: "media_unreadable"
    })`);
    await gate.entered;
    run(`Object.assign(tabStates.get(22), {
      jobId: "new-error-job", mediaEpoch: 8, captureStarted: true,
      engine: "local", localFallbackActive: true, status: "starting",
      stageDetail: "new session starting", issueKind: "", issueCode: "",
      sourceUrl: "blob:https://example.test/new", userStopped: false
    }); captureTabId = 22;`);
    gate.release();
    await pending;

    const stoppedReplacement = harness.contentMessages.find(({ message }) => (
      ["LIVE_STOP", "OFFLINE_ERROR"].includes(message.type)
        && message.jobId === "new-error-job"
        && message.mediaEpoch === 8
    ));
    check(!stoppedReplacement,
      "an old native error never emits a stop/error for the replacement job/epoch");
    check(run(`tabStates.get(22).jobId === "new-error-job"
      && tabStates.get(22).mediaEpoch === 8
      && tabStates.get(22).captureStarted === true
      && tabStates.get(22).localFallbackActive === true
      && tabStates.get(22).userStopped === false
      && tabStates.get(22).status === "starting"
      && tabStates.get(22).stageDetail === "new session starting"
      && tabStates.get(22).issueKind === ""
      && tabStates.get(22).issueCode === ""`) === true,
    "an old native error cannot terminate or overwrite the replacement session state");
  }

  console.log(failures === 0
    ? "native-message race regression PASS"
    : `native-message race regression exposed ${failures} failures`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
