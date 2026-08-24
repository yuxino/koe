const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

const source = fs.readFileSync(path.join(__dirname, "..", "preferences.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: "preferences.js" });
const prefs = context.globalThis.KoePreferences;

check(Boolean(prefs), "preferences helper is exposed");

const defaults = prefs.normalize({}, { defaults: true });
check(defaults.koeTranslate === true, "fresh installs default to translation");
check(defaults.koeAsrEngine === "local", "fresh installs default to local-first mode");
check(defaults.koeCaptureSource === "tab", "fresh installs capture the tab");
check(defaults.koeOverlayEnabled === true, "fresh installs show in-video captions");
check(defaults.koeOverlaySize === "medium", "fresh installs use the standard caption size");
check(defaults.koeHideOriginal === false, "fresh installs keep original text visible");

const native = prefs.normalize({
  koeTranslate: false,
  koeHideOriginal: true,
  koeAsrEngine: "local",
  koeCaptureSource: "tab",
  koeOverlayEnabled: false,
  koeOverlaySize: "large"
}, { defaults: true });
const restored = prefs.resolveInitial({}, native);
check(restored.koeTranslate === false && restored.koeOverlaySize === "large",
  "fresh browser storage restores native preferences");

const browser = {
  koePreferencesVersion: 1,
  koeTranslate: true,
  koeHideOriginal: false,
  koeAsrEngine: "dashscope",
  koeCaptureSource: "tab",
  koeOverlayEnabled: true,
  koeOverlaySize: "small",
  koeApiKey: "must-not-leave-browser"
};
const resolved = prefs.resolveInitial(browser, native);
check(resolved.koeAsrEngine === "dashscope" && resolved.koeOverlaySize === "small",
  "initialized browser preferences override native mirror");
check(!Object.prototype.hasOwnProperty.call(resolved, "koeApiKey"),
  "API Key is never included in normalized preferences");
check(!prefs.keys.includes("koeApiKey"), "API Key is excluded from the preference allow-list");

const legacyBrowser = prefs.resolveInitial({
  koeTranslate: false,
  koeAsrEngine: "dashscope",
  koeOverlaySize: "large"
}, native);
check(legacyBrowser.koeTranslate === false
      && legacyBrowser.koeAsrEngine === "dashscope"
      && legacyBrowser.koeOverlaySize === "large",
  "legacy browser preferences remain authoritative before the version marker exists");

const invalid = prefs.normalize({
  koeTranslate: "false",
  koeAsrEngine: "webspeech",
  koeCaptureSource: "mic",
  koeOverlaySize: "huge"
}, { defaults: true });
check(invalid.koeTranslate === true, "invalid boolean falls back safely");
check(invalid.koeAsrEngine === "local", "retired engine falls back to local-first");
check(invalid.koeCaptureSource === "tab", "retired microphone source falls back to tab");
check(invalid.koeOverlaySize === "medium", "invalid overlay size falls back safely");

process.exitCode = failures ? 1 : 0;
console.log(failures === 0 ? "preferences regression PASS" : `${failures} failures`);
