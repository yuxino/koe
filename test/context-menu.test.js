const fs = require("fs");
const vm = require("vm");
let removed = 0;
let created = 0;
let lastErrorReads = 0;

const runtime = {
  onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} },
  sendMessage: async () => ({ ok: true }), getURL: (path) => `chrome-extension://koe/${path}`
};
Object.defineProperty(runtime, "lastError", { get() { lastErrorReads += 1; return undefined; } });
const ctx = {
  console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  chrome: {
    runtime,
    contextMenus: {
      remove: (id, callback) => { if (id === "koe-capture-tab") removed += 1; callback(); },
      create: (options, callback) => { if (options.id === "koe-capture-tab") created += 1; callback(); },
      onClicked: { addListener() {} }
    },
    storage: { local: { get: async () => ({}), set: async () => undefined }, session: { get: async () => ({}), set: async () => undefined } },
    alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
    tabs: { query: async () => [], onRemoved: { addListener() {} } },
    commands: { onCommand: { addListener() {} } }, action: { openPopup: async () => undefined },
    sidePanel: { open: async () => undefined, setOptions: async () => undefined },
    tabCapture: { getMediaStreamId: async () => "stream" }, scripting: { executeScript: async () => [] },
    offscreen: { createDocument: async () => undefined }, declarativeNetRequest: { updateSessionRules: async () => undefined }
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
if (removed !== 1 || created !== 1 || lastErrorReads < 2) {
  console.error(`FAIL: removed=${removed} created=${created} lastErrorReads=${lastErrorReads}`);
  process.exit(1);
}
console.log("context-menu reload regression PASS");
