// Regression: server sentence timestamps and identity survive the offscreen
// pipeline, and identical text in different sentence IDs is not swallowed.
const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};

const sent = [];
const ctx = {
  console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
  Uint8Array, DataView, Float32Array,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
  performance: { now: () => 1_000 },
  crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
  window: { addEventListener: () => undefined, removeEventListener: () => undefined },
  chrome: {
    runtime: {
      onMessage: { addListener: () => undefined },
      sendMessage: (message) => { sent.push(JSON.parse(JSON.stringify(message))); return Promise.resolve({ ok: true }); },
      getURL: (path) => `chrome-extension://koe/${path}`
    }
  },
  fetch: async () => ({ ok: true, json: async () => ({}) })
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync("offscreen.js", "utf8"), ctx, { filename: "offscreen.js" });

function sentence(id, text, begin, end) {
  return {
    header: { event: "result-generated" },
    payload: { output: { sentence: {
      sentence_id: id,
      sentence_end: true,
      begin_time: begin,
      end_time: end,
      text
    } } }
  };
}

vm.runInContext(`handleDashScopeMessage(${JSON.stringify(sentence(1, "Yeah.", 170, 920))})`, ctx);
vm.runInContext(`handleDashScopeMessage(${JSON.stringify(sentence(2, "Yeah.", 1_050, 1_600))})`, ctx);

const lines = sent.filter((message) => message.type === "CAPTURE_LINES");
check(lines.length === 2, `identical text from different sentence IDs preserved (${lines.length})`);
check(lines[0]?.sentenceId === 1, "sentence identity propagated");
check(lines[0]?.beginTimeMs === 170 && lines[0]?.endTimeMs === 920, "sentence timing propagated");
check(vm.runInContext(`isAlreadyChinese("気持ちいい")`, ctx) === false, "Japanese with kanji still requires translation");
check(vm.runInContext(`primaryLanguageSubtag("en-US")`, ctx) === "en",
  "BCP-47 region variants compare by their primary language");
check(vm.runInContext(`[
  primaryLanguageSubtag("iw-IL"),
  primaryLanguageSubtag("in_ID"),
  primaryLanguageSubtag("ji")
].join(",")`, ctx) === "he,id,yi",
  "legacy browser language identifiers normalize to modern BCP-47 primary subtags");
check(vm.runInContext(`detectionMatchesPreferredLanguage({
  isReliable: true,
  languages: [{ language: "en", percentage: 70 }]
}, "en-US")`, ctx) === true, "reliable 70-percent primary candidate can skip translation");
check(vm.runInContext(`detectionMatchesPreferredLanguage({
  isReliable: true,
  languages: [{ language: "en", percentage: 69 }]
}, "en-US")`, ctx) === false, "language detection below 70 percent remains translated");
check(vm.runInContext(`detectionMatchesPreferredLanguage({
  isReliable: false,
  languages: [{ language: "en", percentage: 99 }]
}, "en-US")`, ctx) === false, "unreliable language detection remains translated");
check(vm.runInContext(`detectionMatchesPreferredLanguage({
  isReliable: true,
  languages: [
    { language: "ja", percentage: 72 },
    { language: "en", percentage: 28 }
  ]
}, "en-US")`, ctx) === false, "only the top detected language can skip translation");
console.log(fail === 0 ? "timeline regression PASS" : `${fail} failures`);
process.exit(fail ? 1 : 0);
