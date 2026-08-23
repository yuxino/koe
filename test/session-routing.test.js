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

function makeContext() {
  const sent = [];
  const sessionStore = {
    koeTabs: [{
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
        local: { get: async () => ({}), set: async () => undefined },
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
        sendMessage: async (message) => { sent.push(JSON.parse(JSON.stringify(message))); return { ok: true }; },
        getURL: (path) => `chrome-extension://koe/${path}`
      },
      alarms: { create: async () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        query: async () => [], get: async (id) => ({ id, windowId: 1 }),
        onRemoved: { addListener: () => undefined }
      },
      contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: () => undefined } },
      action: { openPopup: async () => undefined },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream-7" },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return { ctx, sent };
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
  console.log(fail === 0 ? "session-routing regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
