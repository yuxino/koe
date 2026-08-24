const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failures += 1;
  }
};

function makeClassList() {
  return { add() {}, remove() {}, toggle() {} };
}

function makeElement() {
  const nodes = new Map();
  const node = {
    id: "",
    hidden: false,
    isConnected: true,
    parentNode: null,
    textContent: "",
    classList: makeClassList(),
    style: { setProperty() {} },
    appendChild(child) { child.parentNode = this; },
    attachShadow() {
      const shadow = {
        innerHTML: "",
        querySelector(selector) {
          if (!nodes.has(selector)) nodes.set(selector, makeElement());
          return nodes.get(selector);
        }
      };
      node.shadowRoot = shadow;
      return shadow;
    },
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, right: 960, bottom: 540, width: 960, height: 540 }; }
  };
  return node;
}

function makeHarness() {
  let wallNow = 1_000_000;
  let performanceNow = 300_000;
  let resourceEntries = [];
  const sent = [];
  const listeners = [];
  const intervals = [];
  const location = { href: "https://site.example/watch/one" };

  class TestDate extends Date {}
  TestDate.now = () => wallNow;

  class FakeVideo {}
  const video = new FakeVideo();
  Object.assign(video, {
    currentSrc: "blob:https://site.example/current",
    src: "",
    currentTime: 12,
    duration: 600,
    playbackRate: 1,
    paused: false,
    muted: false,
    readyState: 4,
    videoWidth: 960,
    videoHeight: 540,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, right: 960, bottom: 540, width: 960, height: 540 })
  });

  const documentElement = makeElement();
  documentElement.clientWidth = 1280;
  documentElement.clientHeight = 720;
  const document = {
    fullscreenElement: null,
    documentElement,
    querySelectorAll(selector) { return selector === "video" ? [video] : []; },
    createElement: () => makeElement(),
    addEventListener() {}
  };
  const window = {
    __koeLoaded: undefined,
    innerWidth: 1280,
    innerHeight: 720,
    setInterval(fn, delay) { intervals.push({ fn, delay }); return intervals.length; },
    setTimeout: () => 0,
    clearTimeout() {},
    addEventListener() {}
  };
  const context = {
    console,
    Date: TestDate,
    JSON,
    String,
    Number,
    Boolean,
    Promise,
    Math,
    URL,
    Map,
    Set,
    HTMLVideoElement: FakeVideo,
    location,
    window,
    document,
    history: { pushState() {}, replaceState() {} },
    performance: {
      now: () => performanceNow,
      getEntriesByType: (type) => type === "resource" ? resourceEntries : []
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "test-resource-window" }),
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return Promise.resolve({ ok: true });
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"),
    context,
    { filename: "content.js" }
  );

  return {
    sent,
    location,
    setWallNow(value) { wallNow = value; },
    setPerformanceNow(value) { performanceNow = value; },
    setResources(entries) { resourceEntries = entries; },
    deliver(message) { for (const listener of listeners) listener(message); },
    tickVideoSource() {
      const tracker = intervals.find((entry) => entry.delay === 1_000);
      if (!tracker) throw new Error("trackVideoSource interval missing");
      tracker.fn();
    },
    lastMediaContext() {
      return [...sent].reverse().find((message) => message.type === "MEDIA_CONTEXT");
    }
  };
}

function startAndDiscover(harness, jobId = "offline-window") {
  harness.deliver({ type: "OFFLINE_SESSION", jobId, mediaEpoch: 1, translate: false });
  harness.deliver({ type: "OFFLINE_DISCOVER", jobId, mediaEpoch: 1 });
  return harness.lastMediaContext();
}

{
  const harness = makeHarness();
  const preloaded = "https://media.example/preloaded/master.m3u8?token=memory-only";
  harness.setResources([{ name: preloaded, startTime: 10_000 }]);
  const context = startAndDiscover(harness);
  check(context?.resourceUrls?.[0]?.url === preloaded,
    "initial local session discovers HLS preloaded more than 60 seconds earlier");
  check(context?.resourceUrls?.[0]?.observedAt === 1_000_000,
    "preloaded HLS is freshly confirmed when the current media context is reported");

  harness.setWallNow(1_061_000);
  harness.deliver({ type: "OFFLINE_DISCOVER", jobId: "offline-window", mediaEpoch: 1 });
  const refreshed = harness.lastMediaContext();
  check(refreshed?.resourceUrls?.[0]?.observedAt === 1_061_000,
    "periodic reports refresh candidate activity beyond the background TTL");
}

{
  const harness = makeHarness();
  const previous = "https://media.example/previous/master.m3u8";
  const current = "https://media.example/current/master.m3u8";
  harness.setPerformanceNow(200_000);
  harness.setResources([
    { name: previous, startTime: 10_000 },
    { name: current, startTime: 198_000 }
  ]);
  harness.location.href = "https://site.example/watch/two";
  harness.tickVideoSource();
  const context = startAndDiscover(harness, "offline-after-source-change");
  const urls = context?.resourceUrls?.map((item) => item.url) || [];
  check(urls.includes(current), "source change keeps resources from the current media generation");
  check(!urls.includes(previous), "source change before activation excludes the previous media generation");
}

console.log(failures === 0 ? "offline resource window regression PASS" : `${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
