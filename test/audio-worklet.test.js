const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};

(async () => {
  let workletPath = "";
  let legacyCalls = 0;
  let workletInstance = null;
  class FakeAudioWorkletNode {
    constructor(context, name) {
      this.context = context;
      this.name = name;
      this.port = { onmessage: null };
      workletInstance = this;
    }
    connect() {}
    disconnect() {}
  }
  const ctx = {
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    chrome: {
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: async () => ({ ok: true }),
        getURL: (path) => `chrome-extension://koe/${path}`
      }
    },
    document: { body: { appendChild: () => undefined }, createElement: () => ({ style: {}, contentWindow: { postMessage: () => undefined } }) },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    Audio: function () {},
    AudioWorkletNode: FakeAudioWorkletNode,
    AudioContext: function () {
      this.state = "running";
      this.sampleRate = 16_000;
      this.destination = {};
      this.audioWorklet = { addModule: async (path) => { workletPath = path; } };
      this.resume = async () => undefined;
      this.close = async () => undefined;
      this.createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
      this.createGain = () => ({ gain: { value: 0 }, connect() {}, disconnect() {} });
      this.createScriptProcessor = () => { legacyCalls += 1; return { connect() {}, disconnect() {} }; };
    },
    WebSocket: { OPEN: 1 },
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    Date, console, JSON, String, Number, Boolean, Promise, Math, Uint8Array, DataView, Float32Array, Array
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("offscreen.js", "utf8"), ctx, { filename: "offscreen.js" });
  vm.runInContext("stream = { getTracks: () => [] }", ctx);
  const started = await vm.runInContext("startPcmCapture()", ctx);
  check(started === true, "AudioWorklet capture starts");
  check(workletPath.endsWith("/pcm-worklet.js"), `worklet module loaded (${workletPath})`);
  check(workletInstance?.name === "koe-pcm-capture", "correct worklet processor selected");
  check(legacyCalls === 0, "modern path never creates deprecated ScriptProcessorNode");
  vm.runInContext("processor.port.onmessage({ data: new Float32Array(1600) })", ctx);
  check(vm.runInContext("capturedAudioSamples", ctx) === 1600, "worklet PCM reaches audio clock");
  check(vm.runInContext("frameQueue.length", ctx) === 1, "worklet PCM becomes one 100ms frame");

  let Registered = null;
  const posted = [];
  class BaseProcessor {
    constructor() {
      this.port = { postMessage: (data) => posted.push(data) };
    }
  }
  const workletCtx = {
    AudioWorkletProcessor: BaseProcessor,
    registerProcessor: (name, klass) => { if (name === "koe-pcm-capture") Registered = klass; },
    Float32Array, Math
  };
  vm.createContext(workletCtx);
  vm.runInContext(fs.readFileSync("pcm-worklet.js", "utf8"), workletCtx, { filename: "pcm-worklet.js" });
  const capture = new Registered();
  for (let index = 0; index < 16; index += 1) capture.process([[new Float32Array(128).fill(0.25)]]);
  check(posted.length === 1 && posted[0].length === 2048, "render quanta batch into one stable PCM block");

  console.log(fail === 0 ? "audio-worklet regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
