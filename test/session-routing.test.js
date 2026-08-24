// Regression: an offscreen caption must recover its session route after the
// Manifest V3 service worker loses all in-memory globals.
const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};

function makeContext(entries = null, { offscreenStatus = null } = {}) {
  const sent = [];
  const contentMessages = [];
  const events = [];
  const sessionStore = {
    koeTabs: entries || [{
      tabId: 7,
      frameId: 2,
      jobId: "live-7-test",
      status: "live",
      source: "tab",
      engine: "dashscope",
      mediaEpoch: 4,
      captureStarted: true,
      translate: true,
      liveOnly: true
    }],
    koeTranscript: []
  };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: {
          get: async () => ({
            koePreferencesVersion: 1,
            koeTranslate: true,
            koeHideOriginal: false,
            koeCaptureSource: "tab",
            koeAsrEngine: "local",
            koeOverlayEnabled: true,
            koeOverlaySize: "medium"
          }),
          set: async () => undefined
        },
        session: {
          get: async (keys) => {
            const result = {};
            for (const key of [].concat(keys)) result[key] = sessionStore[key];
            return result;
          },
          set: async (values) => Object.assign(sessionStore, values)
        }
      },
      runtime: {
        onMessage: { addListener: () => undefined },
        onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        sendMessage: async (message) => {
          const snapshot = JSON.parse(JSON.stringify(message));
          sent.push(snapshot);
          events.push({ channel: "runtime", message: snapshot });
          if (message.type === "CAPTURE_STATUS") return offscreenStatus || { ok: true, active: false };
          return { ok: true };
        },
        getURL: (path) => `chrome-extension://koe/${path}`
      },
      alarms: { create: async () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        query: async () => [], get: async (id) => ({ id, windowId: 1, url: `https://video.test/watch/${id}` }),
        sendMessage: async (tabId, message) => {
          const snapshot = JSON.parse(JSON.stringify(message));
          contentMessages.push({ tabId, message: snapshot });
          events.push({ channel: "content", tabId, message: snapshot });
        },
        onRemoved: { addListener: () => undefined },
        onActivated: { addListener: () => undefined }
      },
      contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: () => undefined } },
      action: { openPopup: async () => undefined },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream-7" },
      scripting: { executeScript: async (request) => request.func ? [{
        frameId: 0,
        result: [{
          index: 0,
          pageUrl: "https://video.test/watch",
          hasVideo: true,
          sourceUrl: "blob:https://video.test/player",
          durationMs: 60_000,
          width: 1280,
          height: 720,
          viewportArea: 921_600,
          inViewport: true,
          playing: true,
          muted: false,
          adLike: false
        }]
      }] : [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return { ctx, sent, contentMessages, events };
}

(async () => {
  const h = makeContext();
  await vm.runInContext("restoreStates()", h.ctx);
  const restored = vm.runInContext("({ captureTabId, state: tabStates.get(7) })", h.ctx);
  check(restored.captureTabId === 7, "active capture route restored");
  check(restored.state?.captureStarted === true, "active capture status restored");

  h.sent.length = 0;
  await vm.runInContext(`handle({
    type: "CAPTURE_LINES",
    tabId: 7,
    jobId: "live-7-test",
    mediaEpoch: 4,
    seq: 8,
    lines: [{ text: "Recovered line" }]
  }, {})`, h.ctx);
  check(h.sent.some((message) => message.type === "LIVE_SUBTITLES" && message.jobId === "live-7-test"),
    "first resumed caption routed to UI");

  const local = makeContext([{
    tabId: 9,
    frameId: 0,
    jobId: "offline-9-test",
    status: "live",
    source: "tab",
    engine: "local",
    sessionMode: "offline",
    mediaEpoch: 3,
    captureStarted: true,
    captureNeedsGesture: false,
    localFallbackActive: false,
    translate: true,
    mediaIdentity: "private-media-9",
    sourceUrl: "blob:https://video.test/player",
    pageUrl: "https://video.test/watch/9",
    liveOnly: true
  }]);
  await vm.runInContext("restoreStates()", local.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const localRestored = vm.runInContext("({ captureTabId, state: tabStates.get(9) })", local.ctx);
  check(localRestored.captureTabId === 9, "active local capture route restored");
  check(localRestored.state?.engine === "local" && localRestored.state?.captureStarted === true,
    "active local state survives a service-worker restart");
  check(localRestored.state?.mediaIdentity === "private-media-9",
    "local language/media identity survives recovery");
  check(local.contentMessages.some(({ message }) => message.type === "OFFLINE_SESSION"
      && message.jobId === "offline-9-test"),
    "restored local session asks the page to resume media discovery");

  const staleLocal = makeContext([{
    tabId: 11,
    frameId: 0,
    jobId: "offline-11-test",
    status: "live",
    source: "tab",
    engine: "local",
    sessionMode: "offline",
    mediaEpoch: 5,
    captureStarted: true,
    captureNeedsGesture: false,
    localFallbackActive: true,
    translate: true,
    mediaIdentity: "private-media-11",
    sourceUrl: "blob:https://video.test/player",
    pageUrl: "https://video.test/watch/11",
    liveOnly: true
  }], {
    // offscreen 已进入更新的 epoch，但 storage 写入尚未来得及落盘：冷恢复
    // 必须以实际捕获身份为准，精确释放，不能 force 误伤别的会话。
    offscreenStatus: {
      ok: true,
      active: true,
      engine: "local",
      source: "tab",
      tabId: 11,
      jobId: "offline-11-test",
      mediaEpoch: 6
    }
  });
  await vm.runInContext("bootPromise", staleLocal.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const staleStop = staleLocal.sent.find((message) => message.type === "CAPTURE_STOP");
  check(staleStop?.tabId === 11 && staleStop?.jobId === "offline-11-test"
      && staleStop?.mediaEpoch === 6 && staleStop?.force !== true,
    "cold recovery precisely releases the surviving local offscreen capture");
  const stopIndex = staleLocal.events.findIndex(({ message }) => message.type === "CAPTURE_STOP");
  const resumeIndex = staleLocal.events.findIndex(({ message }) => message.type === "OFFLINE_SESSION");
  check(stopIndex >= 0 && resumeIndex > stopIndex,
    "stale offscreen capture is released before local media discovery resumes");
  check(vm.runInContext("tabStates.get(11).localFallbackActive", staleLocal.ctx) === false,
    "cold recovery does not pretend the disconnected native stream survived");
  const stopCount = staleLocal.sent.filter((message) => message.type === "CAPTURE_STOP").length;
  await vm.runInContext("restoreStates()", staleLocal.ctx);
  check(staleLocal.sent.filter((message) => message.type === "CAPTURE_STOP").length === stopCount,
    "periodic restore does not repeatedly stop an already recovered session");

  const stoppedLive = makeContext([{
    tabId: 13,
    frameId: 0,
    jobId: "live-13-stopped",
    status: "idle",
    source: "tab",
    engine: "dashscope",
    mediaEpoch: 2,
    captureStarted: false,
    userStopped: true,
    translate: true,
    liveOnly: true
  }], {
    offscreenStatus: {
      ok: true,
      active: true,
      engine: "dashscope",
      source: "tab",
      tabId: 13,
      jobId: "live-13-stopped",
      mediaEpoch: 2
    }
  });
  await vm.runInContext("bootPromise", stoppedLive.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const stoppedLiveRelease = stoppedLive.sent.find((message) => message.type === "CAPTURE_STOP");
  check(stoppedLiveRelease?.tabId === 13 && stoppedLiveRelease?.jobId === "live-13-stopped",
    "cold recovery releases a surviving offscreen stream for a session already switched off");
  check(vm.runInContext("captureTabId", stoppedLive.ctx) === null
      && vm.runInContext("tabStates.get(13).captureStarted", stoppedLive.ctx) === false,
    "a stopped live session remains off after service-worker recovery");
  console.log(fail === 0 ? "session-routing regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
