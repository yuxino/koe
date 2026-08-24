const fs = require("fs");
const vm = require("vm");

let failures = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failures += 1;
  }
};
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function makeBackgroundContext() {
  const sessionStore = {};
  const nativeMessages = [];
  const contentMessages = [];
  const runtimeMessages = [];
  const nativeListeners = [];
  const localConfig = {
    koePreferencesVersion: 1,
    koeCaptureSource: "tab",
    koeAsrEngine: "local",
    koeTranslate: true
  };
  const port = {
    postMessage(message) { nativeMessages.push(JSON.parse(JSON.stringify(message))); },
    onMessage: { addListener(listener) { nativeListeners.push(listener); } },
    onDisconnect: { addListener() {} }
  };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: {
          get: async () => ({ ...localConfig }),
          set: async (values) => Object.assign(localConfig, values)
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
        getURL: (path) => `chrome-extension://test/${path}`,
        connectNative: () => port,
        sendMessage: async (message) => {
          runtimeMessages.push(JSON.parse(JSON.stringify(message)));
          if (message.type === "CAPTURE_START") return { ok: true, mode: "local", audioPositionMs: 0 };
          return { ok: true };
        }
      },
      webRequest: { onBeforeRequest: { addListener() {} } },
      alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
      tabs: {
        query: async () => [],
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
      tabCapture: { getMediaStreamId: async () => { throw new Error("gesture required"); } },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return { ctx, nativeMessages, contentMessages, runtimeMessages };
}

function makeOffscreenContext() {
  const runtimeMessages = [];
  let socketCount = 0;
  function FakeWebSocket() { socketCount += 1; }
  FakeWebSocket.OPEN = 1;
  const mediaStream = { getTracks: () => [{ stop() {} }] };
  const ctx = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: {
      body: { appendChild() {} },
      createElement: () => ({ style: {}, contentWindow: { postMessage() {} } })
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        getURL: (path) => `chrome-extension://test/${path}`,
        sendMessage: async (message) => {
          runtimeMessages.push(JSON.parse(JSON.stringify(message)));
          return { ok: true };
        }
      }
    },
    navigator: { mediaDevices: { getUserMedia: async () => mediaStream } },
    Audio: function () {
      this.srcObject = null;
      this.play = async () => undefined;
      this.pause = () => undefined;
    },
    AudioContext: function () {
      this.state = "running";
      this.sampleRate = 16_000;
      this.destination = {};
      this.resume = async () => undefined;
      this.close = async () => undefined;
      this.createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
      this.createGain = () => ({ gain: { value: 0 }, connect() {}, disconnect() {} });
      this.createScriptProcessor = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
    },
    WebSocket: FakeWebSocket,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    btoa,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    Date, console, JSON, String, Number, Boolean, Promise, Math,
    Uint8Array, DataView, Float32Array, Array
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("offscreen.js", "utf8"), ctx, { filename: "offscreen.js" });
  return { ctx, runtimeMessages, socketCount: () => socketCount };
}

(async () => {
  const background = makeBackgroundContext();
  const run = (source) => vm.runInContext(source, background.ctx);
  await run("bootPromise");
  run(`tabStates.set(9, {
    tabId: 9, frameId: 0, jobId: "offline-9", mediaEpoch: 2,
    captureStarted: true, status: "starting", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "blob:https://youtube.com/video", pageUrl: "https://youtube.com/watch?v=x",
    translate: true, mediaIdentity: "identity-9", offlineMissingMediaSince: Date.now() - 3_000
  }); captureTabId = 9; captureStreamIds.set(9, "stream-9");`);

  await run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-9", mediaEpoch: 2,
    currentSrc: "blob:https://youtube.com/video", resourceUrls: [],
    currentTimeMs: 12_000, durationMs: 600_000, playbackRate: 1
  }, { tab: { id: 9 }, frameId: 0 })`);
  await settle();

  check(run("tabStates.get(9).localFallbackActive") === true,
    "a non-HLS local session switches to local live capture");
  check(background.nativeMessages.some((message) => message.type === "streamStart"
      && message.sampleRate === 16_000 && message.channels === 1 && message.translate === true),
    "fallback starts the native local PCM stream");
  const captureStart = background.runtimeMessages.find((message) => message.type === "CAPTURE_START");
  check(captureStart?.engine === "local" && captureStart?.streamId === "stream-9" && !captureStart?.apiKey,
    "local capture starts without exposing or requiring an API Key");
  check(background.contentMessages.some(({ message }) => message.type === "OFFLINE_STOP")
      && background.contentMessages.some(({ message }) => message.type === "LIVE_SESSION"),
    "the page switches cleanly from ahead-of-playback cues to live cues");

  await run(`handle({
    type: "LOCAL_PCM_CHUNK", tabId: 9, jobId: "offline-9", mediaEpoch: 2,
    pcmBase64: "AAAAAA==", audioPositionMs: 500
  }, {})`);
  check(background.nativeMessages.some((message) => message.type === "streamAudio"
      && message.pcmBase64 === "AAAAAA=="),
    "browser PCM is forwarded only through Native Messaging");

  await run(`handleNativeMessage({
    type: "streamCues", jobId: "offline-9", mediaEpoch: 2, revision: 1,
    cues: [{ cueId: "cue-1", startMs: 0, endMs: 1_900, text: "Local original.", translated: "本地译文。" }]
  })`);
  await settle();
  const original = background.runtimeMessages.find((message) => message.type === "LIVE_SUBTITLES");
  const translated = background.runtimeMessages.find((message) => message.type === "LIVE_TRANSLATED");
  check(original?.lines?.[0]?.text === "Local original." && translated?.lines?.[0]?.translated === "本地译文。",
    "native stream cues reach the normal live subtitle UI");
  check(original?.seq > 0 && original.seq === translated?.seq,
    "original and translation keep the same subtitle sequence");

  const discoveriesBefore = background.contentMessages
    .filter(({ message }) => message.type === "OFFLINE_DISCOVER").length;
  await run("requestOfflineMediaContext(tabStates.get(9))");
  check(background.contentMessages.filter(({ message }) => message.type === "OFFLINE_DISCOVER").length
      === discoveriesBefore,
    "periodic page activity cannot switch a running local-live fallback back to offline discovery");

  const nativeBeforeTranslate = background.nativeMessages.length;
  await run("setTranslate(9, false)");
  await settle();
  check(run("tabStates.get(9).mediaEpoch") === 3
      && background.nativeMessages.slice(nativeBeforeTranslate).some((message) => (
        message.type === "streamStart" && message.mediaEpoch === 3 && message.translate === false
      )),
  "changing translation restarts only the native stream on a fresh timeline");
  check(background.runtimeMessages.some((message) => message.type === "CAPTURE_RESET"
      && message.engine === "local" && message.mediaEpoch === 3),
    "translation changes reset the browser PCM clock without opening a WebSocket");

  const audioCountBeforeStale = background.nativeMessages
    .filter((message) => message.type === "streamAudio").length;
  await run(`handle({
    type: "LOCAL_PCM_CHUNK", tabId: 9, jobId: "offline-9", mediaEpoch: 2,
    pcmBase64: "AAAAAA==", audioPositionMs: 1_000
  }, {})`);
  check(background.nativeMessages.filter((message) => message.type === "streamAudio").length
      === audioCountBeforeStale,
    "PCM from the previous local-live epoch is ignored");

  await run(`mediaDiscontinuity({
    type: "MEDIA_DISCONTINUITY", jobId: "offline-9", mediaEpoch: 3,
    discontinuityId: 1, reason: "seek", currentTime: 120
  }, { tab: { id: 9 }, frameId: 0 })`);
  check(run("tabStates.get(9).mediaEpoch") === 4
      && background.nativeMessages.some((message) => message.type === "streamStart" && message.mediaEpoch === 4),
    "seeking resets local live recognition and keeps its audio timeline aligned");

  await run("stopCapture(tabStates.get(9))");
  await settle();
  check(background.nativeMessages.some((message) => message.type === "streamStop" && message.mediaEpoch === 4)
      && background.runtimeMessages.some((message) => message.type === "CAPTURE_STOP")
      && background.contentMessages.some(({ message }) => message.type === "LIVE_STOP"),
    "stopping local live capture releases both Helper and tab audio");
  check(run("tabStates.get(9).localFallbackActive") === false,
    "stopped local live state cannot be revived by late PCM");

  const offscreen = makeOffscreenContext();
  const offRun = (source) => vm.runInContext(source, offscreen.ctx);
  const result = await offRun(`startCapture({
    streamId: "stream-local", translate: true, apiKey: "", source: "tab", engine: "local",
    jobId: "offline-local", tabId: 9, mediaEpoch: 2
  }).then((value) => ({ ok: true, mode: value.mode })).catch((error) => ({ ok: false, error: error.message }))`);
  check(result.ok === true && result.mode === "local", "offscreen local capture is keyless");
  check(offscreen.socketCount() === 0, "local capture never opens a cloud ASR WebSocket");
  offRun("enqueueSamples(new Float32Array(8_000).fill(0.1)); flushFrames();");
  await settle();
  const pcm = offscreen.runtimeMessages.find((message) => message.type === "LOCAL_PCM_CHUNK");
  check(pcm?.jobId === "offline-local" && pcm?.pcmBase64?.length > 10_000,
    "500 ms PCM batches are sent to the background with session identity");

  console.log(failures === 0 ? "local live fallback regression PASS" : `${failures} failures`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
