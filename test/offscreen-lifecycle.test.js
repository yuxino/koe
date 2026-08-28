// Regression: concurrent capture starts must share one offscreen document creation.
// Chrome allows only one offscreen document; racing createDocument calls can make
// an otherwise valid start fail with "Only a single offscreen document may be created".
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
  let createCalls = 0;
  let releaseContexts;
  const contextsGate = new Promise((resolve) => { releaseContexts = resolve; });
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
        session: { get: async () => ({}), set: async () => undefined }
      },
      runtime: {
        onMessage: { addListener: () => undefined },
        onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        sendMessage: async () => ({ ok: true }),
        getURL: (path) => `chrome-extension://koe/${path}`,
        getContexts: async () => {
          await contextsGate;
          return [];
        }
      },
      tabs: {
        query: async () => [], onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined }, onActivated: { addListener: () => undefined }
      },
      contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: () => undefined } },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
      action: { setPopup: async () => undefined, setBadgeText: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream" },
      alarms: { onAlarm: { addListener: () => undefined } },
      scripting: { executeScript: async () => [] },
      offscreen: {
        createDocument: async () => { createCalls += 1; }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return { ctx, releaseContexts, createCalls: () => createCalls };
}

(async () => {
  const h = makeContext();
  const first = vm.runInContext("ensureOffscreen()", h.ctx);
  const second = vm.runInContext("ensureOffscreen()", h.ctx);
  h.releaseContexts();
  const results = await Promise.allSettled([first, second]);
  check(results.every((result) => result.status === "fulfilled"),
    "concurrent callers both observe successful offscreen initialization");
  check(h.createCalls() === 1,
    `concurrent callers create exactly one offscreen document (actual ${h.createCalls()})`);
  console.log(fail === 0 ? "offscreen-lifecycle regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
