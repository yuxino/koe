// Regression: original and translation share one durable row, and ASR revoke
// removes the same rows from restored history.
const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};
const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

function makeContext() {
  const sessionStore = {};
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
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, sendMessage: async () => ({ ok: true }),
        getURL: (path) => `chrome-extension://koe/${path}`
      },
      alarms: { create: async () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: { query: async () => [], onRemoved: { addListener: () => undefined } },
      contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: () => undefined } },
      action: { openPopup: async () => undefined },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream" },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return ctx;
}

(async () => {
  const ctx = makeContext();
  vm.runInContext(`
    tabStates.set(1, { tabId: 1, frameId: 0, jobId: "live-1", captureStarted: true, mediaEpoch: 0 });
    captureTabId = 1;
    recordTranscript({ seq: 3, text: "Good morning.", mediaEpoch: 0 });
    recordTranscript({ seq: 3, translated: "早上好。", mediaEpoch: 0 });
  `, ctx);
  await settle();
  let result = await vm.runInContext("getTranscript()", ctx);
  check(result.rows.length === 1, `same seq merged into one row (${result.rows.length})`);
  check(result.rows[0]?.text === "Good morning." && result.rows[0]?.translated === "早上好。",
    "merged row retains original and translation");

  await vm.runInContext(`forwardRevoke({ tabId: 1, jobId: "live-1", mediaEpoch: 0, fromSeq: 3, toSeq: 3 })`, ctx);
  await settle();
  result = await vm.runInContext("getTranscript()", ctx);
  check(result.rows.length === 0, "revoked row removed from restored history");

  vm.runInContext(`
    tabStates.get(1).mediaEpoch = 2;
    recordTranscript({ seq: 9, text: "Current timeline.", mediaEpoch: 2 });
  `, ctx);
  await settle();
  await vm.runInContext(`forwardRevoke({ tabId: 1, jobId: "live-1", mediaEpoch: 1, fromSeq: 9, toSeq: 9 })`, ctx);
  await settle();
  result = await vm.runInContext("getTranscript()", ctx);
  check(result.rows.some((row) => row.seq === 9), "stale epoch revoke cannot erase current timeline");
  console.log(fail === 0 ? "transcript-consistency regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
