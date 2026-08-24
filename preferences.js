// Shared, non-secret Koe preferences. This file deliberately excludes the
// DashScope API Key: the key stays in chrome.storage.local in the browser.
(function exposeKoePreferences(root) {
  const VERSION = 1;
  const DEFAULTS = Object.freeze({
    koePreferencesVersion: VERSION,
    koeTranslate: true,
    koeHideOriginal: false,
    koeCaptureSource: "tab",
    koeAsrEngine: "local",
    koeOverlayEnabled: true,
    koeOverlaySize: "medium"
  });
  const KEYS = Object.freeze(Object.keys(DEFAULTS));

  function own(value, key) {
    return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function bool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function normalize(input = {}, { defaults = false } = {}) {
    const fallback = defaults ? DEFAULTS : {};
    const result = {};
    const version = Number(input.koePreferencesVersion);
    if (Number.isInteger(version) && version > 0) result.koePreferencesVersion = Math.min(VERSION, version);
    else if (defaults) result.koePreferencesVersion = VERSION;

    if (own(input, "koeTranslate") || defaults) {
      result.koeTranslate = bool(input.koeTranslate, fallback.koeTranslate);
    }
    if (own(input, "koeHideOriginal") || defaults) {
      result.koeHideOriginal = bool(input.koeHideOriginal, fallback.koeHideOriginal);
    }
    if (own(input, "koeCaptureSource") || defaults) {
      result.koeCaptureSource = input.koeCaptureSource === "tab" ? "tab" : fallback.koeCaptureSource;
    }
    if (own(input, "koeAsrEngine") || defaults) {
      result.koeAsrEngine = ["local", "dashscope"].includes(input.koeAsrEngine)
        ? input.koeAsrEngine
        : fallback.koeAsrEngine;
    }
    if (own(input, "koeOverlayEnabled") || defaults) {
      result.koeOverlayEnabled = bool(input.koeOverlayEnabled, fallback.koeOverlayEnabled);
    }
    if (own(input, "koeOverlaySize") || defaults) {
      result.koeOverlaySize = ["small", "medium", "large"].includes(input.koeOverlaySize)
        ? input.koeOverlaySize
        : fallback.koeOverlaySize;
    }
    return result;
  }

  function isInitialized(input = {}) {
    return Number(input.koePreferencesVersion) >= 1
      || KEYS.some((key) => key !== "koePreferencesVersion" && own(input, key));
  }

  function resolveInitial(browser = {}, native = {}) {
    return isInitialized(browser)
      ? normalize(browser, { defaults: true })
      : normalize({ ...DEFAULTS, ...normalize(native) }, { defaults: true });
  }

  root.KoePreferences = Object.freeze({
    version: VERSION,
    defaults: DEFAULTS,
    keys: KEYS,
    normalize,
    resolveInitial,
    isInitialized
  });
})(globalThis);
