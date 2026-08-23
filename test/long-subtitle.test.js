const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;

function check(condition, label) {
  if (condition) return;
  console.error(`FAIL: ${label}`);
  failures += 1;
}

function makeHarness() {
  const sent = [];
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math,
    Uint8Array, DataView, Float32Array,
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: async () => ({
      ok: true,
      body: null,
      json: async () => ({ output: { choices: [{ message: { content: "" } }] } })
    }),
    WebSocket: function WebSocket() {
      this.readyState = 1;
      this.send = () => undefined;
      this.close = () => undefined;
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    Audio: function Audio() {
      this.play = async () => undefined;
      this.pause = () => undefined;
    },
    AudioContext: function AudioContext() {},
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return Promise.resolve({ ok: true });
        },
        getURL: (name) => `chrome-extension://koe/${name}`
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8"),
    ctx,
    { filename: "offscreen.js" }
  );
  return { ctx, sent, run: (source) => vm.runInContext(source, ctx) };
}

{
  const h = makeHarness();
  const draft = "We can keep moving through this explanation and make the next step clear";
  h.run(`updateDraft(${JSON.stringify(draft)})`);
  const committed = h.run("commitPendingDraft({ forceLongIncomplete: true })");
  check(Boolean(committed), "maximum-wait fallback commits a readable Latin fragment before 120 characters");
  check(Array.from(String(committed || "")).length <= 64, "forced Latin fragment stays within the 64-character hard cap");
}

{
  const h = makeHarness();
  const draft = "This complete sentence keeps adding useful context for the listener while continuing well beyond a comfortable subtitle width.";
  h.run(`updateDraft(${JSON.stringify(draft)})`);
  const committed = h.run("commitPendingDraft({ forceLongIncomplete: false })");
  check(Boolean(committed), "a complete oversized sentence still commits promptly");
  check(Array.from(String(committed || "")).length <= 64, "a complete sentence is bounded instead of becoming one oversized unit");
  check(!/\s$/.test(String(committed || "")), "the bounded unit does not end in stray whitespace");
}

{
  const h = makeHarness();
  const draft = "This explanation has enough context to remain accurate, but it should pause here, before the next idea keeps growing past the subtitle width";
  h.run(`updateDraft(${JSON.stringify(draft)})`);
  const committed = h.run("commitPendingDraft({ forceLongIncomplete: true })");
  check(String(committed || "").endsWith(","), "the long-speech segmenter prefers a natural pause near the width limit");
}

{
  const h = makeHarness();
  const draft = "这是一段持续增长而且没有句号的识别草稿需要在画面字幕达到可读长度以后及时切开避免整段文字覆盖视频内容";
  h.run(`updateDraft(${JSON.stringify(draft)})`);
  const committed = h.run("commitPendingDraft({ forceLongIncomplete: true })");
  check(Boolean(committed), "maximum-wait fallback also commits CJK continuous speech");
  check(Array.from(String(committed || "")).length <= 28, "CJK committed units respect the 28-character hard cap");
}

{
  const h = makeHarness();
  const text = "This final result contains a long uninterrupted explanation that should be divided at a natural word boundary before it fills the whole video. It then continues with a short closing sentence.";
  const units = h.run(`typeof splitSubtitleUnits === "function" ? splitSubtitleUnits(${JSON.stringify(text)}) : []`);
  check(units.length >= 2, "an oversized server final is split into multiple subtitle-sized units");
  check(units.every((unit) => Array.from(unit).length <= 64), "every server-final unit respects the Latin hard cap");
}

{
  const h = makeHarness();
  const units = h.run(`typeof splitSubtitleUnits === "function" ? splitSubtitleUnits("Okay. Great. Let's continue.") : []`);
  check(units.length === 1, "adjacent short final sentences are packed into one readable unit");
}

console.log(failures === 0 ? "long subtitle regression PASS" : `${failures} failures`);
process.exit(failures ? 1 : 0);
