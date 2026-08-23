const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};

function makeClassList() {
  const values = new Set();
  return {
    add: (value) => values.add(value),
    remove: (value) => values.delete(value),
    toggle: (value, force) => force ? values.add(value) : values.delete(value),
    contains: (value) => values.has(value)
  };
}

function makeElement(tag = "div") {
  const element = {
    tag, id: "", hidden: false, isConnected: false, parentNode: null, textContent: "",
    children: [],
    style: { setProperty() {} }, classList: makeClassList(),
    appendChild(child) { this.children.push(child); child.parentNode = this; child.isConnected = true; return child; },
    getBoundingClientRect: () => ({ left: 100, bottom: 700, width: 900, height: 500 })
  };
  element.attachShadow = () => {
    const nodes = {
      ".stage": makeElement("stage"),
      ".original": makeElement("original"),
      ".translation": makeElement("translation")
    };
    element.shadowRoot = { innerHTML: "", querySelector: (selector) => nodes[selector] };
    return element.shadowRoot;
  };
  return element;
}

(async () => {
  const messageListeners = [];
  const documentListeners = {};
  const root = makeElement("html");
  root.isConnected = true;
  root.clientWidth = 1280;
  root.clientHeight = 800;
  const video = makeElement("video");
  Object.assign(video, { videoWidth: 1280, videoHeight: 720, currentSrc: "https://cdn.test/movie.mp4", paused: false, muted: false, readyState: 4 });
  class HTMLVideoElement {}
  Object.setPrototypeOf(video, HTMLVideoElement.prototype);
  const document = {
    documentElement: root,
    fullscreenElement: null,
    querySelectorAll: (selector) => selector === "video" ? [video] : [],
    createElement: (tag) => makeElement(tag),
    addEventListener: (type, listener) => { documentListeners[type] = listener; }
  };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL, Array,
    location: { href: "https://example.test/watch" },
    history: { pushState() {}, replaceState() {} },
    HTMLVideoElement,
    document,
    window: {
      __koeLoaded: undefined,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      setInterval: () => 0,
      setTimeout: () => 1,
      clearTimeout() {}
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        onMessage: { addListener: (listener) => messageListeners.push(listener) },
        sendMessage: async () => ({ ok: true })
      },
      storage: {
        local: { get: async () => ({ koeOverlayEnabled: true, koeOverlaySize: "medium" }) },
        onChanged: { addListener() {} }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("content.js", "utf8"), ctx, { filename: "content.js" });
  const send = (message) => messageListeners.forEach((listener) => listener(message));
  send({ type: "LIVE_SESSION", jobId: "job-1", mediaEpoch: 3, translate: true });
  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 1, unit: true, lines: [{ text: "Original line" }] });
  const overlay = root.children[0];
  check(overlay.shadowRoot.querySelector(".original").textContent === "Original line", "current epoch original renders");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 2, seq: 1, unit: true, lines: [{ translated: "旧字幕" }] });
  check(overlay.shadowRoot.querySelector(".translation").textContent === "", "stale epoch translation rejected");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 3, seq: 1, unit: true, lines: [{ translated: "当前字幕" }] });
  check(overlay.shadowRoot.querySelector(".translation").textContent === "当前字幕", "current translation renders");

  const fullscreenRoot = makeElement("fullscreen");
  document.fullscreenElement = fullscreenRoot;
  documentListeners.fullscreenchange();
  check(overlay.parentNode === fullscreenRoot, "overlay remounts into fullscreen subtree");
  document.fullscreenElement = null;
  documentListeners.fullscreenchange();
  check(overlay.parentNode === root, "overlay returns to document after fullscreen");

  console.log(fail === 0 ? "overlay regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
