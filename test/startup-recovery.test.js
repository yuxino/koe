const fs = require("fs");
const vm = require("vm");

let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};
const settle = async () => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function makeContext() {
  const listeners = {};
  const scriptInjections = [];
  const tabQueries = [];
  const sessionStore = {};
  const tabs = new Map([
    [11, { id: 11, windowId: 1, url: "https://video.example/watch", active: true, discarded: false }],
    [12, { id: 12, windowId: 2, url: "chrome://extensions/", active: true, discarded: false }],
    [13, { id: 13, windowId: 3, url: "https://video.example/sleeping", active: true, discarded: true }],
    [14, { id: 14, windowId: 1, url: "https://video.example/second", active: false, discarded: false }],
    [15, { id: 15, windowId: 1, url: "https://video.example/session", active: false, discarded: false }],
    [16, { id: 16, windowId: 7, url: "https://video.example/new-window", active: true, discarded: false }],
    [17, { id: 17, windowId: 4, url: "", pendingUrl: "https://video.example/restoring", active: true, discarded: false }],
    [18, { id: 18, windowId: 5, url: "file:///tmp/private.html", active: true, discarded: false }],
    [19, { id: 19, windowId: 1, url: "https://video.example/idle-history", active: false, discarded: false }]
  ]);
  let rejectInjectionForTab = null;
  const nativePort = {
    postMessage() {},
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} }
  };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: {
          get: async () => ({ koeCaptureSource: "tab", koeAsrEngine: "local", koeTranslate: true }),
          set: async () => undefined
        },
        session: {
          get: async (keys) => {
            const result = {};
            for (const key of [].concat(keys)) result[key] = sessionStore[key];
            return result;
          },
          set: async (values) => Object.assign(sessionStore, JSON.parse(JSON.stringify(values)))
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        id: "test-extension-id",
        lastError: null,
        onMessage: { addListener() {} },
        onStartup: { addListener(listener) { listeners.startup = listener; } },
        onInstalled: { addListener(listener) { listeners.installed = listener; } },
        sendMessage: async () => ({ ok: true }),
        connectNative: () => nativePort,
        getURL: (path) => `chrome-extension://test/${path}`
      },
      webRequest: { onBeforeRequest: { addListener() {} } },
      alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
      tabs: {
        query: async (queryInfo = {}) => {
          tabQueries.push(JSON.parse(JSON.stringify(queryInfo)));
          return [...tabs.values()].filter((tab) => (!queryInfo.active || tab.active)
            && (!Number.isInteger(queryInfo.windowId) || tab.windowId === queryInfo.windowId));
        },
        get: async (tabId) => {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error("No tab");
          return tab;
        },
        sendMessage: async () => undefined,
        onRemoved: { addListener() {} },
        onUpdated: { addListener(listener) { listeners.updated = listener; } },
        onActivated: { addListener(listener) { listeners.activated = listener; } }
      },
      windows: { onCreated: { addListener(listener) { listeners.windowCreated = listener; } } },
      contextMenus: { create() {}, remove(_id, callback) { callback?.(); }, onClicked: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      action: { openPopup: async () => undefined, setPopup: async () => undefined, setBadgeText: async () => undefined },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream" },
      scripting: {
        executeScript: async (details) => {
          scriptInjections.push(JSON.parse(JSON.stringify(details)));
          if (details.target?.tabId === rejectInjectionForTab) throw new Error("Cannot access this page");
          return [];
        }
      },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return {
    ctx, listeners, scriptInjections, tabQueries, tabs, sessionStore,
    rejectInjectionForTab(tabId) { rejectInjectionForTab = tabId; }
  };
}

(async () => {
  const h = makeContext();
  const run = (source) => vm.runInContext(source, h.ctx);
  await run("bootPromise");
  const isContentInjection = (details, tabId, frameId = 0) => details.target?.tabId === tabId
    && details.target?.frameIds?.[0] === frameId
    && details.files?.includes("media-discovery.js")
    && details.files?.includes("content.js");

  h.sessionStore.koeTabs = [
    {
      tabId: 15, frameId: 2, jobId: "offline-15-restored", engine: "local",
      captureStarted: true, userStopped: false, startedAt: 200
    },
    {
      tabId: 19, frameId: 0, jobId: "offline-19-idle", engine: "local",
      captureStarted: false, userStopped: false, startedAt: 100
    }
  ];
  run("tabStates.clear(); captureTabId = null;");
  h.scriptInjections.length = 0;
  h.listeners.startup();
  await run("bootPromise");
  await settle();

  const startupTargets = h.scriptInjections.map((details) => details.target);
  check(h.scriptInjections.filter((details) => isContentInjection(details, 11)).length === 1,
    "startup refreshes an ordinary restored active web tab");
  check(h.scriptInjections.some((details) => isContentInjection(details, 15, 2)),
    "startup restores a persisted active subtitle session in its recorded frame");
  check(!startupTargets.some((target) => target.tabId === 19),
    "startup does not reinject inactive historical Koe state");
  check(!startupTargets.some((target) => target.tabId === 12),
    "startup ignores internal browser pages");
  check(!startupTargets.some((target) => target.tabId === 13),
    "startup does not wake discarded tabs");
  check(startupTargets.some((target) => target.tabId === 17),
    "startup recognizes a restored web page from pendingUrl");
  check(!startupTargets.some((target) => target.tabId === 18),
    "startup does not inject into file pages outside the supported web surface");

  h.scriptInjections.length = 0;
  h.listeners.activated({ tabId: 14 });
  await settle();
  check(h.scriptInjections.some((details) => isContentInjection(details, 14)),
    "the first activation self-heals an ordinary restored web tab");

  h.scriptInjections.length = 0;
  h.listeners.activated({ tabId: 12 });
  await settle();
  check(h.scriptInjections.length === 0, "tab activation ignores an internal browser page");

  h.scriptInjections.length = 0;
  h.listeners.activated({ tabId: 13 });
  await settle();
  check(h.scriptInjections.length === 0, "activation does not force a discarded tab awake");
  h.tabs.set(13, { ...h.tabs.get(13), discarded: false, status: "complete" });
  h.listeners.updated(13, { status: "complete" }, h.tabs.get(13));
  await settle();
  check(h.scriptInjections.some((details) => isContentInjection(details, 13)),
    "a user-activated discarded tab self-heals after restoration completes");

  run("globalThis.__originalResumeLocalTab = resumeLocalTab; resumeLocalTab = async (tabId) => { globalThis.__resumedTabId = tabId; };");
  h.rejectInjectionForTab(14);
  h.scriptInjections.length = 0;
  h.listeners.activated({ tabId: 14 });
  await settle();
  const resumedTabId = run("globalThis.__resumedTabId");
  check(resumedTabId === 14,
    "an injection failure does not prevent an existing local subtitle session from resuming");
  run("resumeLocalTab = globalThis.__originalResumeLocalTab;");
  h.rejectInjectionForTab(null);

  run(`
    globalThis.__originalEnsureLiveCaptions = ensureLiveCaptions;
    ensureLiveCaptions = async (options) => { globalThis.__resumedPageUrl = options.pageUrl; return { ok: true }; };
    tabStates.set(17, {
      tabId: 17, frameId: 0, jobId: "offline-17-pending", engine: "local",
      captureStarted: true, userStopped: false, pageUrl: ""
    });
    captureTabId = 17;
  `);
  await run("resumeLocalTab(17)");
  check(run("globalThis.__resumedPageUrl") === "https://video.example/restoring",
    "a restored local session resumes from pendingUrl before the committed URL is available");
  run("ensureLiveCaptions = globalThis.__originalEnsureLiveCaptions; tabStates.delete(17); captureTabId = 15;");

  h.scriptInjections.length = 0;
  h.tabQueries.length = 0;
  h.listeners.windowCreated({ id: 7 });
  await settle();
  check(h.scriptInjections.some((details) => isContentInjection(details, 16)),
    "a restored browser window refreshes its own active web tab");
  check(!h.scriptInjections.some((details) => details.target?.tabId === 11
      || details.target?.tabId === 15),
    "opening one window does not reinject active tabs or sessions from other windows");
  check(h.tabQueries.some((queryInfo) => queryInfo.active === true && queryInfo.windowId === 7),
    "window recovery scopes its tab query to the created window");

  h.scriptInjections.length = 0;
  h.listeners.installed({ reason: "update" });
  await run("bootPromise");
  await settle();
  check(h.scriptInjections.some((details) => isContentInjection(details, 17)),
    "an install or update requests content recovery for a newly restored active page");
  check(h.scriptInjections.some((details) => isContentInjection(details, 19)),
    "an install or update also cleans up inactive pages with historical Koe state");

  if (fail) process.exit(1);
  console.log("startup content recovery regression PASS");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
