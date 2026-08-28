if (typeof importScripts === "function") importScripts("preferences.js");

// Koe 字幕后台：实时模式捕获标签页声音；本地精准模式只把媒体定位信息
// 通过 Chrome Native Messaging 交给本机 Helper，音视频不离开电脑。

const AUTH_RULE_ID = 9001;
const NATIVE_HOST_NAME = "app.yuxino.koe.helper";
const NATIVE_PROTOCOL_VERSION = 1;
const MEDIA_CANDIDATE_TTL_MS = 60_000;
const OFFLINE_REFILL_LEAD_MS = 45_000;
const LOCAL_LIVE_FALLBACK_DELAY_MS = 1_800;
const NATIVE_IDLE_DISCONNECT_MS = 1_000;
const preferenceTools = globalThis.KoePreferences || createPreferenceFallback();
const PREFERENCE_KEYS = [...preferenceTools.keys];
const tabStates = new Map();
const captureStreamIds = new Map();
const captureStartPromises = new Map();
const localFallbackPromises = new Map();
const mediaCandidatesByTab = new Map();
let captureTabId = null;
// captureAttemptId 只表示“最近一次实时启动尝试”；预检失败的尝试不能
// 提前杀掉仍在建立连接的旧会话。captureIntentId 只在预检全部通过、真正
// 获准接管全局捕获目标时递增，避免 tab 快速切换留下幽灵 starting 状态。
let captureAttemptId = 0;
let captureIntentId = 0;
let bootPromise;
let nativePort = null;
// null = Helper 尚未握手；false 只表示 Helper 已明确报告不可用。
let nativeTranslationAvailable = null;
const nativePreferenceWaiters = new Set();
let nativeSessionStartWaiters = 0;
let preferenceMirrorTimer = 0;
let nativeIdleDisconnectTimer = 0;
let offscreenCreationPromise = null;
let stateWriteChain = Promise.resolve();
let mediaIdentityCounter = 0;

function createMediaIdentity() {
  mediaIdentityCounter += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `media-${Date.now()}-${mediaIdentityCounter}-${Math.random().toString(36).slice(2)}`;
}

function createPreferenceFallback() {
  const defaults = Object.freeze({
    koePreferencesVersion: 1,
    koeTranslate: true,
    koeSkipSameLanguage: true,
    koeHideOriginal: false,
    koeCaptureSource: "tab",
    koeAsrEngine: "local",
    koeOverlayEnabled: true,
    koeOverlaySize: "medium"
  });
  const keys = Object.keys(defaults);
  const own = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
  const normalize = (input = {}, { defaults: withDefaults = false } = {}) => {
    const fallback = withDefaults ? defaults : {};
    const value = {};
    if (own(input, "koePreferencesVersion") || withDefaults) value.koePreferencesVersion = 1;
    if (own(input, "koeTranslate") || withDefaults) {
      value.koeTranslate = typeof input.koeTranslate === "boolean" ? input.koeTranslate : fallback.koeTranslate;
    }
    if (own(input, "koeSkipSameLanguage") || withDefaults) {
      value.koeSkipSameLanguage = typeof input.koeSkipSameLanguage === "boolean"
        ? input.koeSkipSameLanguage
        : fallback.koeSkipSameLanguage;
    }
    if (own(input, "koeHideOriginal") || withDefaults) {
      value.koeHideOriginal = typeof input.koeHideOriginal === "boolean" ? input.koeHideOriginal : fallback.koeHideOriginal;
    }
    if (own(input, "koeCaptureSource") || withDefaults) value.koeCaptureSource = "tab";
    if (own(input, "koeAsrEngine") || withDefaults) {
      value.koeAsrEngine = ["local", "dashscope"].includes(input.koeAsrEngine)
        ? input.koeAsrEngine
        : fallback.koeAsrEngine;
    }
    if (own(input, "koeOverlayEnabled") || withDefaults) {
      value.koeOverlayEnabled = typeof input.koeOverlayEnabled === "boolean"
        ? input.koeOverlayEnabled
        : fallback.koeOverlayEnabled;
    }
    if (own(input, "koeOverlaySize") || withDefaults) {
      value.koeOverlaySize = ["small", "medium", "large"].includes(input.koeOverlaySize)
        ? input.koeOverlaySize
        : fallback.koeOverlaySize;
    }
    return value;
  };
  const isInitialized = (input = {}) => keys.some((key) => own(input, key));
  return Object.freeze({
    defaults,
    keys,
    normalize,
    isInitialized,
    resolveInitial: (browser = {}, native = {}) => isInitialized(browser)
      ? normalize(browser, { defaults: true })
      : normalize({ ...defaults, ...normalize(native) }, { defaults: true })
  });
}

function currentPreferredLanguage() {
  try {
    const value = String(chrome.i18n?.getUILanguage?.() || "").trim().replaceAll("_", "-");
    return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) ? value.slice(0, 64) : "";
  } catch {
    return "";
  }
}

function translationPolicyFields(state) {
  return {
    skipSameLanguage: state?.skipSameLanguage !== false,
    preferredLanguage: String(state?.preferredLanguage || currentPreferredLanguage()).slice(0, 64)
  };
}

function resetOfflineBatchState(state, { preserveRevision = false } = {}) {
  if (!state) return;
  if (state.offlineFallbackTimer) clearTimeout(state.offlineFallbackTimer);
  state.offlineFallbackTimer = 0;
  state.offlineStartToken = (Number(state.offlineStartToken) || 0) + 1;
  state.offlineStartedEpoch = undefined;
  state.offlineRunActive = false;
  state.offlinePreparedUntilMs = 0;
  state.offlineMediaComplete = false;
  state.offlineMissingMediaSince = 0;
  if (!preserveRevision) state.offlineCueRevision = 0;
}

installMediaRequestObserver();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => { bootPromise = boot(); });
chrome.runtime.onInstalled.addListener(() => {
  bootPromise = boot();
  // Chrome 不会自动把更新后的静态 content script 注入已打开页面。
  // 主动接管已知会话，才能在升级后立刻移除旧版视频状态卡。
  void bootPromise.then(refreshKnownContentScripts).catch(() => undefined);
});
chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local" || !PREFERENCE_KEYS.some((key) => changes[key])) return;
  schedulePreferenceMirror();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "koe-restore") void restoreStates();
});
bootPromise = boot();

// 点击工具栏图标打开弹窗（default_popup），弹窗里的主按钮点击是
// 本地实测唯一稳定有效的 tabCapture 授权手势；action.onClicked 不再触发，
// 开启只由弹窗/侧边栏主按钮或右键菜单明确触发；Alt+K 只负责打开控制器。

// 右键菜单 = 另一个官方认可的授权手势，作为备用的点击式开启路径
const CONTEXT_MENU_ID = "koe-capture-tab";
installContextMenu();

function installContextMenu() {
  const create = () => {
    try {
      chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: "Koe：开启本页实时字幕",
        contexts: ["page", "video"]
      }, () => {
        // 回调存在时 Chrome 才认为 runtime.lastError 已被消费。
        void chrome.runtime.lastError;
      });
    } catch {
      // 环境不支持时忽略
    }
  };
  if (typeof chrome.contextMenus.remove !== "function") {
    create();
    return;
  }
  try {
    chrome.contextMenus.remove(CONTEXT_MENU_ID, () => {
      // 首次安装时“不存在此菜单”是正常情况，也要消费 lastError。
      void chrome.runtime.lastError;
      create();
    });
  } catch {
    create();
  }
}

function installMediaRequestObserver() {
  const listener = chrome.webRequest?.onBeforeRequest;
  if (!listener?.addListener) return;
  try {
    listener.addListener((details) => {
      if (!Number.isInteger(details?.tabId) || details.tabId < 0) return;
      const state = tabStates.get(details.tabId);
      // 带签名的 HLS URL 只在用户明确开启的本地会话中短暂保存在内存。
      // 其他标签页、实时模式和停止后的网络请求一律不观察。
      if (captureTabId !== details.tabId || !state?.captureStarted || state.engine !== "local") return;
      if (!isHlsUrl(details.url)) return;
      rememberMediaCandidate(details.tabId, {
        url: details.url,
        frameId: Number(details.frameId) || 0,
        seenAt: Number(details.timeStamp) || Date.now(),
        source: "webRequest"
      });
    }, { urls: ["<all_urls>"] });
  } catch {
    // 缺少权限或浏览器不支持时，内容脚本的 Performance 资源列表仍可兜底。
  }
}

function isHlsUrl(value) {
  try {
    return /\.m3u8$/i.test(new URL(String(value || "")).pathname);
  } catch {
    return false;
  }
}

function rememberMediaCandidate(tabId, candidate) {
  const id = Number(tabId);
  const url = String(candidate?.url || "");
  if (!Number.isInteger(id) || !isHlsUrl(url) || isAdSource(url)) return;
  const now = Date.now();
  const existing = (mediaCandidatesByTab.get(id) || [])
    .filter((item) => now - Number(item.seenAt || 0) <= MEDIA_CANDIDATE_TTL_MS && item.url !== url);
  existing.push({
    url,
    frameId: Number(candidate.frameId) || 0,
    seenAt: Number(candidate.seenAt) || now,
    source: String(candidate.source || "page"),
    quality: Math.max(0, Number(candidate.quality) || 0)
  });
  mediaCandidatesByTab.set(id, existing.slice(-24));
}

function selectMediaCandidate(tabId, context = {}) {
  const id = Number(tabId);
  const frameId = Number(context.frameId) || 0;
  const now = Date.now();
  const direct = String(context.currentSrc || "");
  if (isHlsUrl(direct)) {
    rememberMediaCandidate(id, { url: direct, frameId, seenAt: now, source: "video" });
    // currentSrc 是播放器此刻明确使用的 HLS，必须压过旧视频留下的缓存。
    return { url: direct, frameId, seenAt: now, source: "video" };
  }
  for (const item of Array.isArray(context.resourceUrls) ? context.resourceUrls : []) {
    const url = typeof item === "string" ? item : String(item?.url || "");
    const observedAt = typeof item === "string" ? now : Number(item?.observedAt) || now;
    const source = typeof item === "string" || item?.source !== "page-definition"
      ? "performance"
      : "page-definition";
    if (isHlsUrl(url)) {
      rememberMediaCandidate(id, {
        url,
        frameId,
        seenAt: observedAt,
        source,
        quality: Math.max(0, Number(item?.quality) || 0)
      });
    }
  }
  const candidates = (mediaCandidatesByTab.get(id) || [])
    .filter((item) => now - Number(item.seenAt || 0) <= MEDIA_CANDIDATE_TTL_MS && !isAdSource(item.url));
  return candidates.sort((left, right) => mediaCandidateScore(right, frameId) - mediaCandidateScore(left, frameId))[0] || null;
}

function mediaCandidateScore(candidate, frameId) {
  let score = isHlsUrl(candidate.url) ? 10_000 : 2_000;
  if (Number(candidate.frameId) === Number(frameId)) score += 1_000;
  if (candidate.source === "webRequest") score += 300;
  if (candidate.source === "video") score += 200;
  score += playlistStructureScore(candidate.url);
  if (candidate.source === "page-definition") {
    score += 900;
    // 识别只需要音轨，优先最低画质能显著减少本地分片下载量。
    score += Math.max(0, 1_200 - (Number(candidate.quality) || 1_200));
  }
  score += Math.max(-60, Math.min(0, ((Number(candidate.seenAt) || 0) - Date.now()) / 1_000));
  return score;
}

// MSE 播放器通常先请求 master playlist，再请求当前画质的 media playlist。
// 把 master 交给 Helper，它才能自行选最低码率；若误选 1080p 分支，首次字幕
// 会多下载数十 MB，弱网下很容易在字幕出现前超时。
function playlistStructureScore(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    const filename = String(segments[segments.length - 1] || "").toLowerCase();
    const path = url.pathname.toLowerCase();
    let score = Math.max(0, 600 - segments.length * 100);
    if (/(^|[._-])master([._-]|$)/.test(filename)) score += 900;
    else if (/(^|[._-])(manifest|playlist)([._-]|$)/.test(filename)) score += 450;
    if (/(^|[\/_-])(2160|1440|1080|fhd|uhd|high)([\/_-]|$)/.test(path)) score -= 700;
    else if (/(^|[\/_-])(720|hd)([\/_-]|$)/.test(path)) score -= 350;
    if (/(^|[\/_-])(144|180|240|low|ld)([\/_-]|$)/.test(path)) score += 150;
    // Dailymotion 的 dmxleo 端点虽然以 .m3u8 结尾，返回的是不含媒体
    // 分片的动态元数据；真正的 master playlist 来自 cdndirector。
    if (hostname === "dmxleo.dailymotion.com") score -= 2_000;
    if (hostname === "cdndirector.dailymotion.com") score += 800;
    return score;
  } catch {
    return 0;
  }
}
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    // 忽略
  }
  await stashStreamIdForTab(tab.id);
  await ensureLiveCaptions({ tabId: tab.id, pageUrl: tab.url, forceReset: true });
});

// 在合法手势的上下文里预取音频流 ID 并暂存（一次授权可用 15 分钟内多次启动）
async function stashStreamIdForTab(tabId) {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    captureStreamIds.set(tabId, streamId);
  } catch {
    // 手势不被认可时忽略；面板按钮稍后尝试时会给出明确指引
  }
}

// 快捷键 Alt+K：Chrome 的 command 事件不是可靠的 tabCapture 手势
// （sidePanel.open / getMediaStreamId 会因"not a user gesture"失败——SO 77213045）。
// 正确做法：打开弹窗——用户再用弹窗主按钮明确开启；按钮点击是验证过的
// tabCapture 手势源。快捷键本身不改变当前开关状态。
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-tab") return;
  try {
    await chrome.action.openPopup();
  } catch {
    // 老版本 Chrome 不支持 openPopup：退回原逻辑（尽力开侧边栏 + 提示）
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (active?.windowId) {
      try {
        await chrome.sidePanel.open({ windowId: active.windowId });
      } catch {
        // 无手势或版本不支持时忽略
      }
    }
  }
  // 这里只打开控制器，不直接尝试 getMediaStreamId，也不改变字幕开关。
});

chrome.tabs.onRemoved.addListener((tabId) => cleanupTab(tabId));
chrome.tabs.onActivated?.addListener?.(({ tabId }) => {
  void (async () => {
    await bootPromise;
    await resumeLocalTab(tabId);
  })();
});

async function boot() {
  try {
    await chrome.alarms.create("koe-restore", { periodInMinutes: 0.5 });
  } catch {
    // 个别环境不支持 alarms 时仅保留内存状态
  }
  await initializePreferences();
  await restoreStates();
}

async function initializePreferences() {
  let browser = {};
  try {
    browser = await chrome.storage.local.get(PREFERENCE_KEYS);
  } catch {
    browser = {};
  }
  const native = preferenceTools.isInitialized(browser)
    ? {}
    : await requestNativePreferences(900);
  const resolved = preferenceTools.resolveInitial(browser, native || {});
  try {
    await chrome.storage.local.set(resolved);
  } catch {
    // Storage may be unavailable only in restricted test/browser contexts.
  }
  return resolved;
}

function requestNativePreferences(timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      nativePreferenceWaiters.delete(finish);
      clearTimeout(timer);
      resolve(value || null);
      scheduleNativeIdleDisconnect();
    };
    const timer = setTimeout(() => finish(null), Math.max(100, Number(timeoutMs) || 900));
    nativePreferenceWaiters.add(finish);
    try {
      postNativeMessage({ type: "preferencesGet", protocolVersion: NATIVE_PROTOCOL_VERSION });
    } catch {
      finish(null);
    }
  });
}

function schedulePreferenceMirror(snapshot = null) {
  if (preferenceMirrorTimer) clearTimeout(preferenceMirrorTimer);
  preferenceMirrorTimer = setTimeout(() => {
    preferenceMirrorTimer = 0;
    void mirrorPreferences(snapshot);
  }, 80);
}

async function mirrorPreferences(snapshot = null) {
  let values = snapshot;
  if (!values) {
    try {
      values = await chrome.storage.local.get(PREFERENCE_KEYS);
    } catch {
      return;
    }
  }
  try {
    postNativeMessage({
      type: "preferencesSet",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      preferences: preferenceTools.normalize(values, { defaults: true })
    });
    scheduleNativeIdleDisconnect();
  } catch {
    // Helper is optional; browser storage remains authoritative.
  }
}

function hasActiveLocalSession() {
  return [...tabStates.values()].some((state) => state?.captureStarted && state.engine === "local");
}

function cancelNativeIdleDisconnect() {
  if (!nativeIdleDisconnectTimer) return;
  clearTimeout(nativeIdleDisconnectTimer);
  nativeIdleDisconnectTimer = 0;
}

function scheduleNativeIdleDisconnect(delayMs = NATIVE_IDLE_DISCONNECT_MS) {
  cancelNativeIdleDisconnect();
  nativeIdleDisconnectTimer = setTimeout(() => {
    nativeIdleDisconnectTimer = 0;
    if (!nativePort
        || nativePreferenceWaiters.size > 0
        || nativeSessionStartWaiters > 0
        || hasActiveLocalSession()) return;
    const port = nativePort;
    // Mark this as an intentional close before notifying Chrome. The existing
    // onDisconnect fence then ignores it instead of turning an idle state into
    // a user-visible Helper error.
    nativePort = null;
    try {
      port.disconnect?.();
    } catch {
      // A closed/stale Port will be recreated lazily on the next local action.
    }
  }, Math.max(0, Number(delayMs) || 0));
}

async function handle(message, sender) {
  if (!message || typeof message.type !== "string") return { ok: true };
  await bootPromise;
  const tabId = Number(message.tabId ?? sender?.tab?.id);
  if (message.type === "PAGE_READY") return pageReady(sender);
  if (message.type === "VIDEO_CHANGED") return videoChanged(message, sender);
  if (message.type === "MEDIA_CONTEXT") return receiveMediaContext(message, sender);
  if (message.type === "MEDIA_DISCONTINUITY") return mediaDiscontinuity(message, sender);
  if (message.type === "OFFLINE_VISIBLE_REPORT") return recordOfflineVisible(message, sender);
  if (message.type === "GET_STATE") {
    // 不带 tabId 时优先返回正在捕获的会话；终止错误已释放 captureTabId，
    // 此时回退到动作徽标使用的最近状态，让弹窗/侧边栏仍能展示失败原因。
    const state = tabStates.get(tabId) || (message.tabId === undefined ? currentActionState() : null);
    return { ok: true, state: publicState(state) };
  }
  if (message.type === "CAPTURE_LINES") return forwardCaptureLines(message, "LIVE_SUBTITLES");
  if (message.type === "CAPTURE_PARTIAL") return forwardCaptureLines(message, "LIVE_PARTIAL");
  if (message.type === "CAPTURE_TRANSLATED") return forwardCaptureLines(message, "LIVE_TRANSLATED");
  if (message.type === "CAPTURE_REVOKE") return forwardRevoke(message);
  if (message.type === "CAPTURE_ERROR") return handleCaptureError(message);
  if (message.type === "LOCAL_PCM_CHUNK") return forwardLocalPCM(message);
  if (message.type === "START_CAPTURE") return startCaptureForTab(message);
  if (message.type === "RECOMMEND_TAB") return recommendCaptureTab(Number(message.tabId));
  if (message.type === "KOE_LOG") return appendLog(message);
  if (message.type === "GET_LOGS") return getLogs();
  if (message.type === "CLEAR_LOGS") return clearLogs();
  if (message.type === "GET_TRANSCRIPT") return getTranscript();
  if (message.type === "CLEAR_TRANSCRIPT") {
    await clearTranscript();
    return { ok: true };
  }
  if (message.type === "STOP_CAPTURE") return stopCaptureForTab({
    tabId: Number(message.tabId),
    jobId: String(message.jobId || "")
  });
  if (message.type === "SET_TRANSLATE") return setTranslate(tabId, Boolean(message.translate));
  if (message.type === "SET_SKIP_SAME_LANGUAGE") {
    return setSkipSameLanguage(tabId, Boolean(message.skipSameLanguage));
  }
  if (message.type === "SET_CAPTURE") return setCaptureConfig(tabId);
  return { ok: true };
}

async function pageReady(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, skipped: true };
  const pageUrl = String(sender.tab?.url || "");
  if (!/^https?:/i.test(pageUrl)) return { ok: true, skipped: true };
  return ensureLiveCaptions({ tabId, pageUrl });
}

async function videoChanged(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, skipped: true };
  const reportedPageUrl = String(message?.pageUrl || "");
  const pageUrl = /^https?:/i.test(reportedPageUrl) ? reportedPageUrl : String(sender.tab?.url || "");
  if (!/^https?:/i.test(pageUrl)) return { ok: true, skipped: true };
  // 页内切视频：让“视频源是否真的变了”来判断要不要重连识别会话，
  // 避免 CDN 换签名、同一视频重载这类情况把字幕打断
  return ensureLiveCaptions({ tabId, pageUrl, mediaChanged: true });
}

// ===== 实时字幕核心：找到正在播放的主视频 → 开启/保持标签页声音捕获 =====
async function ensureLiveCaptions({ tabId, pageUrl = "", translate, forceReset = false, mediaChanged = false }) {
  tabId = Number(tabId);
  if (!Number.isInteger(tabId)) return { ok: true, skipped: true };
  let state = tabStates.get(tabId);
  // PAGE_READY / VIDEO_CHANGED / 标签页激活都只是会话维护信号，不能代表
  // 用户同意开启。没有正在运行的手动会话，或用户已经停止时，始终保持关闭。
  if (!forceReset && (!state?.captureStarted || state.userStopped)) {
    return { ok: true, skipped: true };
  }
  let captureSource = state?.source || preferenceTools.defaults?.koeCaptureSource || "tab";
  let captureEngine = state?.engine || preferenceTools.defaults?.koeAsrEngine || "local";
  let skipSameLanguage = state
    ? state.skipSameLanguage !== false
    : preferenceTools.defaults?.koeSkipSameLanguage !== false;
  const preferredLanguage = currentPreferredLanguage();
  try {
    const stored = await chrome.storage.local.get([
      "koeTranslate", "koeSkipSameLanguage", "koeCaptureSource", "koeAsrEngine"
    ]);
    if (translate === undefined) translate = stored.koeTranslate;
    captureSource = stored.koeCaptureSource;
    captureEngine = stored.koeAsrEngine;
    skipSameLanguage = stored.koeSkipSameLanguage !== false;
  } catch {
    // 偏好读取失败时沿用当前会话；新会话使用上面的安全默认值。
  }
  const sourceMode = captureSource === "mic" ? "mic" : "tab";
  const engineMode = ["local", "webspeech"].includes(captureEngine) ? captureEngine : "dashscope";
  const sessionMode = engineMode === "local" ? "offline" : "live";
  if (engineMode === "local" && nativeTranslationAvailable === false) translate = false;

  // 麦克风模式：不需要标签页授权手势，也不需要页面里有视频
  let source;
  if (sourceMode === "mic") {
    source = {
      hasVideo: true,
      playing: true,
      muted: false,
      sourceUrl: "",
      frameId: 0,
      pageUrl: pageUrl || ""
    };
  } else {
    source = await discoverVideoSource(tabId, pageUrl, { allowPaused: engineMode === "local" }).catch(() => null);
  }
  const sourceKey = source?.sourceUrl ? normalizeSourceKey(source.sourceUrl) : "";
  const nextPageKey = normalizePageKey(pageUrl || source?.pageUrl || "");
  const previousPageKey = normalizePageKey(state?.pageUrl || "");
  const pageChanged = Boolean(state && nextPageKey && previousPageKey && nextPageKey !== previousPageKey);
  const languagePolicyChanged = Boolean(state) && (
    state.skipSameLanguage !== skipSameLanguage
      || String(state.preferredLanguage || "") !== preferredLanguage
  );
  const activeState = captureTabId === null ? null : tabStates.get(captureTabId);

  // 全局只允许一个会话。用户可用弹窗、侧边栏或右键菜单明确切换目标；
  // 页面自身的维护事件不能接管另一个标签页正在运行的会话。
  if (engineMode === "local" && !forceReset) {
    if (activeState?.captureStarted && activeState.tabId !== tabId && activeState.status !== "error") {
      return { ok: true, skipped: true };
    }
  }

  // “停止/报错 → 用户明确再开”必须得到新的会话身份。若沿用旧 job/epoch，
  // 停止前已经排队的 Helper 消息会在新会话激活后重新通过校验。
  if (forceReset && state && !state.captureStarted) {
    state.jobId = `${sessionMode}-${tabId}-${Date.now()}`;
    state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
    state.lastDiscontinuityId = 0;
    resetOfflineBatchState(state);
    state.offlineSourceUrl = "";
    state.offlineContext = undefined;
    mediaCandidatesByTab.delete(tabId);
    state.startedAt = Date.now();
  }

  const usableVideo = engineMode === "local"
    ? Boolean(source?.hasVideo && !isAdSource(source.sourceUrl || ""))
    : isLiveAllowed(source);
  if (sourceMode !== "mic" && (!source?.hasVideo || !usableVideo)) {
    // 没有正在播放的主视频，或只是静音/广告/背景视频：不打扰，也不清掉已有会话
    return { ok: true, skipped: true };
  }
  await ensureContentScript(tabId, source.frameId || 0);

  const startedHere = !state || String(state.sessionMode || (state.liveOnly ? "live" : "")) !== sessionMode;
  if (startedHere) {
    if (state?.captureStarted) await stopCapture(state);
    state = {
      tabId,
      frameId: source.frameId || 0,
      status: "starting",
      jobId: `${sessionMode}-${tabId}-${Date.now()}`,
      translate: translate !== undefined ? Boolean(translate) : true,
      skipSameLanguage,
      preferredLanguage,
      source: sourceMode,
      engine: engineMode,
      sourceUrl: source.sourceUrl || "",
      pageUrl: pageUrl || source.pageUrl,
      liveOnly: sessionMode === "live",
      sessionMode,
      captureStarted: false,
      captureNeedsGesture: false,
      stageDetail: sessionMode === "offline" ? "准备本地精准字幕…" : "准备实时字幕…",
      mediaIdentity: createMediaIdentity(),
      startedAt: Date.now()
    };
    tabStates.set(tabId, state);
    await persistStates();
  } else if (forceReset || pageChanged || mediaChanged
      || (sourceKey && sourceKey !== normalizeSourceKey(state.sourceUrl || ""))
      || state.source !== sourceMode || state.engine !== engineMode || languagePolicyChanged) {
    const previousSourceKey = normalizeSourceKey(state.sourceUrl || "");
    const mediaIdentityChanged = pageChanged || mediaChanged
      || Boolean(sourceKey && sourceKey !== previousSourceKey)
      || state.engine !== engineMode;
    // 只有明确启动会清除停止标记；换页、换源和播放事件都不能改变开关。
    if (forceReset) state.userStopped = false;
    state.frameId = source.frameId || state.frameId;
    state.pageUrl = pageUrl || source.pageUrl;
    state.sourceUrl = source.sourceUrl || "";
    state.source = sourceMode;
    state.engine = engineMode;
    state.sessionMode = sessionMode;
    state.translate = translate !== undefined ? Boolean(translate) : state.translate;
    state.skipSameLanguage = skipSameLanguage;
    state.preferredLanguage = preferredLanguage;
    if (sessionMode === "offline" && mediaIdentityChanged) {
      // 只传给 Helper 一个不含 URL 的媒体代号：换视频重新检测语言，seek 保留。
      state.mediaIdentity = createMediaIdentity();
    }
    // 换视频/强制刷新是新的媒体时间线。先提升 epoch 并清掉页面旧字幕，
    // 再重连识别；这样旧 WebSocket 或翻译请求即使晚到，也会被后台拒绝。
    if (state.captureStarted && sessionMode === "live") {
      state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
      const resetIdentity = sessionIdentity(state);
      const resetTranslate = state.translate;
      await sendToContent(state, {
        type: "LIVE_RESET",
        jobId: state.jobId,
        mediaEpoch: state.mediaEpoch,
        reason: forceReset ? "manual" : "source"
      });
      if (!isCurrentSession(state, resetIdentity, true)) return { ok: true, skipped: true };
      const response = await resetCaptureSession(state);
      if (!isCurrentSession(state, resetIdentity, true)) return { ok: true, skipped: true };
      await sendToContent(state, {
        type: "LIVE_SESSION",
        jobId: resetIdentity.jobId,
        mediaEpoch: resetIdentity.mediaEpoch,
        translate: resetTranslate,
        audioPositionMs: Number(response?.audioPositionMs) || 0
      });
      await persistStates();
    } else if (state.captureStarted && sessionMode === "offline") {
      if (state.localFallbackActive) {
        await resetLocalLiveSession(state, forceReset ? "manual" : "source", {
          currentTimeMs: source?.currentTimeMs,
          playbackRate: source?.playbackRate
        });
      } else {
        const previousEpoch = Number(state.mediaEpoch) || 0;
        try {
          postNativeMessage({ type: "cancel", jobId: state.jobId, mediaEpoch: previousEpoch });
        } catch {
          // Helper 缺失/断开时仍要完成页面时间线切换。
        }
        state.mediaEpoch = previousEpoch + 1;
        resetOfflineBatchState(state);
        state.offlineSourceUrl = "";
        state.offlineContext = undefined;
        mediaCandidatesByTab.delete(tabId);
        await sendToContent(state, {
          type: "OFFLINE_RESET",
          jobId: state.jobId,
          mediaEpoch: state.mediaEpoch,
          reason: forceReset ? "manual" : "source"
        });
        await persistStates();
      }
    }
  }

  state = tabStates.get(tabId);
  if (!state) return { ok: true };
  state.skipSameLanguage = state.skipSameLanguage !== false;
  state.preferredLanguage = String(state.preferredLanguage || preferredLanguage);
  if (state.engine === "local") {
    if (state.localFallbackActive) {
      // PAGE_READY/play/source maintenance gives us a fresh renderer clock.
      // Re-anchor at the current captured-audio position so rate changes and
      // pause/resume do not accumulate drift without restarting Whisper.
      if (Number.isFinite(Number(source?.currentTimeMs))) {
        setLocalMediaAnchor(state, {
          currentTimeMs: Number(source.currentTimeMs),
          playbackRate: source.playbackRate
        }, Number(state.localAudioPositionMs) || 0);
      }
      await sendToContent(state, {
        type: "LIVE_SESSION",
        jobId: state.jobId,
        mediaEpoch: Number(state.mediaEpoch) || 0,
        translate: state.translate,
        audioPositionMs: localMediaTimeAtAudio(state, Number(state.localAudioPositionMs) || 0),
        mediaTimed: true,
        discontinuityId: Number(state.lastDiscontinuityId) || 0
      });
      return { ok: true };
    }
    if (!state.captureStarted) {
      await startOfflineSession(state, { allowHandoff: forceReset });
    } else {
      // 页面 reload 或扩展重载后，新的 content script 没有 activeSession。
      // 先幂等恢复会话身份，再让它回报媒体地址。
      await sendToContent(state, {
        type: "OFFLINE_SESSION",
        jobId: state.jobId,
        mediaEpoch: Number(state.mediaEpoch) || 0,
        translate: state.translate,
        discontinuityId: Number(state.lastDiscontinuityId) || 0
      });
      await requestOfflineMediaContext(state);
    }
    return { ok: true };
  }
  if (state.captureStarted) {
    await sendToContent(state, {
      type: "LIVE_SESSION",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      translate: state.translate,
      audioPositionMs: 0
    });
    return { ok: true };
  }
  await ensureCaptureAuthorized(state);
  return { ok: true };
}

async function startOfflineSession(state, { allowHandoff = true } = {}) {
  // 本地模式和实时模式一样尊重用户的明确停止。只有 START_CAPTURE
  // 会先清除此标记；页面自己的 PAGE_READY/播放事件不得偷偷重启。
  if (!state || state.userStopped) return;
  await clearMediaIssue(state);
  // clearMediaIssue 会让出事件循环；这期间另一个标签页可能已经接管，
  // 或用户已经停止当前页。失效启动不能再把自己写回全局路由。
  if (state.userStopped || tabStates.get(state.tabId) !== state) return;
  try {
    connectNativeHelper();
  } catch (error) {
    state.captureStarted = false;
    state.status = "error";
    state.stageDetail = error instanceof Error ? error.message : String(error);
    await persistStates();
    return;
  }
  nativeSessionStartWaiters += 1;
  try {
    const previous = captureTabId ? tabStates.get(captureTabId) : null;
    // 两个 PAGE_READY 可能并发通过前置检查。启动前再检查一次，确保后到的
    // 自动任务不会在竞态中停掉刚建立的会话。
    if (!allowHandoff && previous?.captureStarted && previous.tabId !== state.tabId
        && previous.status !== "error") return;
    const startIdentity = sessionIdentity(state);
    const intentId = ++captureIntentId;
    if (!isCurrentCaptureIntent(state, startIdentity, intentId)) return;
    if (previous && previous.tabId !== state.tabId && previous.captureStarted) {
      // 先封存旧页，再等待异步清理。否则 stopCapture 让出事件循环后，旧页的
      // PAGE_READY 会趁 captureTabId 为空重新启动，形成两个“运行中”状态。
      previous.userStopped = true;
      await stopCapture(previous);
      if (!isCurrentCaptureIntent(state, startIdentity, intentId)) return;
      // 单会话切到新标签页后，旧页仍会周期发送 PAGE_READY。保持封存，
      // 直到用户再次明确点击旧页，避免两个标签页互相抢占。
      previous.status = "idle";
      previous.stageDetail = "字幕已切换到另一个标签页";
      previous.captureNeedsGesture = false;
    }
    state.captureStarted = true;
    state.localFallbackActive = false;
    state.captureNeedsGesture = false;
    state.status = "starting";
    state.stageDetail = "正在定位视频媒体…";
    resetOfflineBatchState(state);
    captureTabId = state.tabId;
    await clearTranscript();
    if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) return;
    await persistStates();
    if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) return;
    await sendToContent(state, {
      type: "OFFLINE_SESSION",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      translate: state.translate,
      discontinuityId: Number(state.lastDiscontinuityId) || 0
    });
    if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
      await sendToContent(state, {
        type: "OFFLINE_STOP",
        jobId: startIdentity.jobId,
        mediaEpoch: startIdentity.mediaEpoch
      });
      return;
    }
    postNativeMessage({ type: "hello", protocolVersion: NATIVE_PROTOCOL_VERSION });
    await requestOfflineMediaContext(state);
  } finally {
    nativeSessionStartWaiters = Math.max(0, nativeSessionStartWaiters - 1);
    scheduleNativeIdleDisconnect();
  }
}

function sessionIdentity(state) {
  return {
    tabId: Number(state?.tabId),
    jobId: String(state?.jobId || ""),
    mediaEpoch: Number(state?.mediaEpoch) || 0
  };
}

function matchesSessionIdentity(state, identity) {
  return Boolean(state && identity
    && tabStates.get(identity.tabId) === state
    && state.jobId === identity.jobId
    && (Number(state.mediaEpoch) || 0) === identity.mediaEpoch);
}

function isCurrentSession(state, identity, requireActive = false) {
  if (!matchesSessionIdentity(state, identity) || state.userStopped) return false;
  return !requireActive || (state.captureStarted && captureTabId === identity.tabId);
}

function isCurrentCaptureIntent(state, identity, intentId, requireActive = false) {
  return Number(intentId) === captureIntentId
    && isCurrentSession(state, identity, requireActive);
}

function isCurrentCaptureAttempt(state, identity, attemptId, baseIntentId) {
  return Number(attemptId) === captureAttemptId
    && Number(baseIntentId) === captureIntentId
    && isCurrentSession(state, identity);
}

function commitCaptureIntent(state, identity, attemptId, baseIntentId) {
  if (!isCurrentCaptureAttempt(state, identity, attemptId, baseIntentId)) return 0;
  captureIntentId += 1;
  return captureIntentId;
}

function ownsProvisionalCapture(state, identity, intentId) {
  return Boolean(state)
    && tabStates.get(identity.tabId) === state
    && state.jobId === identity.jobId
    && (Number(state.mediaEpoch) || 0) === identity.mediaEpoch
    && Number(state.captureStartIntentId) === Number(intentId)
    && state.captureStarted
    && captureTabId === identity.tabId;
}

async function abandonProvisionalCapture(state, identity, intentId, {
  sessionAnnounced = false,
  startSubmitted = false
} = {}) {
  // 同一 tab/job/epoch 可能已经被更新的启动尝试接管；owner token 防止旧清理
  // 把新会话误当成自己回滚。
  if (!ownsProvisionalCapture(state, identity, intentId)) return;
  state.captureStarted = false;
  state.captureStartIntentId = 0;
  state.captureNeedsGesture = false;
  state.status = "idle";
  state.stageDetail = "字幕启动已被新的请求替代";
  if (captureTabId === identity.tabId) captureTabId = null;
  if (startSubmitted) {
    try {
      await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", ...identity });
    } catch {
      // 离屏页可能尚未真正建立流，精确停止可以安全忽略。
    }
  }
  if (sessionAnnounced) {
    try {
      await chrome.runtime.sendMessage({ type: "LIVE_STOP", ...identity });
    } catch {
      // 侧边栏未打开时忽略。
    }
    await sendToContent(state, { type: "LIVE_STOP", ...identity });
  }
  await persistStates();
  scheduleNativeIdleDisconnect();
}

async function requestOfflineMediaContext(state) {
  if (!state?.captureStarted || state.engine !== "local" || state.localFallbackActive) return;
  await sendToContent(state, {
    type: "OFFLINE_DISCOVER",
    jobId: state.jobId,
    mediaEpoch: Number(state.mediaEpoch) || 0
  });
}

function scheduleOfflineFallbackProbe(state) {
  if (!state?.captureStarted || state.offlineFallbackTimer || !state.offlineMissingMediaSince) return;
  const identity = sessionIdentity(state);
  const elapsed = Date.now() - Number(state.offlineMissingMediaSince);
  const delay = Math.max(50, LOCAL_LIVE_FALLBACK_DELAY_MS - elapsed);
  state.offlineFallbackTimer = setTimeout(() => {
    state.offlineFallbackTimer = 0;
    if (!isCurrentSession(state, identity, true)
        || state.engine !== "local"
        || state.localFallbackActive
        || !state.offlineMissingMediaSince
        || state.offlineSourceUrl) return;
    void requestOfflineMediaContext(state);
  }, delay);
}

function normalizeLocalPlaybackRate(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0.25, Math.min(4, numeric));
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric)
    ? Math.max(0.25, Math.min(4, fallbackNumeric))
    : 1;
}

function localMediaTimeAtAudio(state, audioPositionMs) {
  const audio = Math.max(0, Number(audioPositionMs) || 0);
  const mediaAnchor = Number(state?.localMediaAnchorMs);
  if (!Number.isFinite(mediaAnchor)) return audio;
  const audioAnchor = Math.max(0, Number(state?.localAudioAnchorMs) || 0);
  const playbackRate = normalizeLocalPlaybackRate(state?.localPlaybackRate);
  return Math.max(0, mediaAnchor + (audio - audioAnchor) * playbackRate);
}

function setLocalMediaAnchor(state, context = {}, audioPositionMs = 0) {
  if (!state) return;
  const currentTimeMs = Number(context.currentTimeMs);
  state.localMediaAnchorMs = Number.isFinite(currentTimeMs)
    ? Math.max(0, currentTimeMs)
    : localMediaTimeAtAudio(state, state.localAudioPositionMs);
  state.localAudioAnchorMs = Math.max(0, Number(audioPositionMs) || 0);
  state.localPlaybackRate = normalizeLocalPlaybackRate(
    context.playbackRate,
    state.localPlaybackRate
  );
  state.localMediaTimed = true;
  state.offlineContext = {
    ...(state.offlineContext || {}),
    currentTimeMs: state.localMediaAnchorMs,
    playbackRate: state.localPlaybackRate
  };
}

async function startLocalLiveFallback(state, streamId = captureStreamIds.get(state?.tabId) || "") {
  if (!state?.captureStarted || state.engine !== "local" || state.userStopped) return false;
  if (state.localFallbackActive) return true;
  const existing = localFallbackPromises.get(state.tabId);
  if (existing) return existing;
  const pending = runLocalLiveFallback(state, String(streamId || ""));
  localFallbackPromises.set(state.tabId, pending);
  try {
    return await pending;
  } finally {
    if (localFallbackPromises.get(state.tabId) === pending) localFallbackPromises.delete(state.tabId);
  }
}

async function runLocalLiveFallback(state, streamId) {
  const identity = sessionIdentity(state);
  if (!streamId) {
    state.status = "starting";
    state.captureNeedsGesture = true;
    state.stageDetail = "这个网站需要点一次 Koe 来读取标签页声音；音频只在本机处理";
    await publishMediaIssue(state, {
      kind: "action",
      issueCode: "needs_tab_audio",
      detail: state.stageDetail,
      status: "starting",
      captureNeedsGesture: true
    });
    return false;
  }

  connectNativeHelper();
  await ensureContentScript(state.tabId, state.frameId || 0);
  if (!isCurrentSession(state, identity, true)) return false;
  await ensureOffscreen();
  if (!isCurrentSession(state, identity, true)) return false;

  try {
    // 同一个 Helper 同时只跑一种本地任务。先终止可能仍在排队的 HLS 批次，
    // 然后把页面从媒体时间轴字幕无缝切换到音频流时间轴字幕。
    try {
      postNativeMessage({
        type: "cancel",
        jobId: state.jobId,
        mediaEpoch: Number(state.mediaEpoch) || 0
      });
    } catch {
      // 新会话尚未真正进入 Helper 时 cancel 可以安全忽略。
    }
    resetOfflineBatchState(state);
    state.offlineSourceUrl = "";
    setLocalMediaAnchor(state, state.offlineContext, 0);
    mediaCandidatesByTab.delete(state.tabId);
    state.localFallbackActive = true;
    if (!state.mediaIdentity) state.mediaIdentity = createMediaIdentity();
    state.localLiveSeq = 0;
    state.localAudioPositionMs = 0;
    state.localCueSequences = Object.create(null);
    state.localCueOriginals = Object.create(null);
    state.localCueTranslations = Object.create(null);
    state.captureNeedsGesture = false;
    state.status = "starting";
    state.stageDetail = "正在启动本地实时字幕…";
    await clearMediaIssue(state);
    captureTabId = state.tabId;
    await clearTranscript();
    if (!isCurrentSession(state, identity, true)) return false;
    await sendToContent(state, {
      type: "OFFLINE_STOP",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0
    });
    await sendToContent(state, {
      type: "LIVE_SESSION",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      translate: state.translate,
      audioPositionMs: localMediaTimeAtAudio(state, 0),
      mediaTimed: true,
      discontinuityId: Number(state.lastDiscontinuityId) || 0
    });
    postNativeMessage({
      type: "streamStart",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      mediaKey: state.mediaIdentity,
      sampleRate: 16_000,
      channels: 1,
      translate: Boolean(state.translate),
      ...translationPolicyFields(state)
    });
    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_START",
      streamId,
      apiKey: "",
      translate: state.translate,
      ...translationPolicyFields(state),
      source: "tab",
      engine: "local",
      tabId: state.tabId,
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0
    });
    if (!isCurrentSession(state, identity, true)) {
      try { await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", ...identity }); } catch { /* stopped */ }
      return false;
    }
    if (!response?.ok) throw new Error(response?.error || "无法读取标签页声音。");
    state.status = "starting";
    state.stageDetail = "本地模型正在听取第一句…";
    await persistStates();
    return true;
  } catch (error) {
    if (!isCurrentSession(state, identity, true)) return false;
    try {
      postNativeMessage({
        type: "streamStop",
        jobId: state.jobId,
        mediaEpoch: Number(state.mediaEpoch) || 0
      });
    } catch { /* Helper disconnected */ }
    try { await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", ...identity }); } catch { /* offscreen unavailable */ }
    state.localFallbackActive = false;
    state.captureNeedsGesture = true;
    state.status = "starting";
    state.stageDetail = `点一次 Koe 重试标签页声音：${error instanceof Error ? error.message : String(error)}`;
    await sendToContent(state, { type: "LIVE_STOP", jobId: state.jobId, mediaEpoch: state.mediaEpoch });
    await sendToContent(state, {
      type: "OFFLINE_SESSION",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      translate: state.translate,
      discontinuityId: Number(state.lastDiscontinuityId) || 0
    });
    await publishMediaIssue(state, {
      kind: "action",
      issueCode: "needs_tab_audio",
      detail: state.stageDetail,
      status: "starting",
      captureNeedsGesture: true
    });
    return false;
  }
}

async function resetLocalLiveSession(state, reason = "media", mediaContext = {}) {
  if (!state?.captureStarted || !state.localFallbackActive) return null;
  const previousAudioPositionMs = Math.max(0, Number(state.localAudioPositionMs) || 0);
  const currentTimeMs = Number(mediaContext.currentTimeMs);
  const nextMediaTimeMs = Number.isFinite(currentTimeMs)
    ? Math.max(0, currentTimeMs)
    : localMediaTimeAtAudio(state, previousAudioPositionMs);
  const nextPlaybackRate = normalizeLocalPlaybackRate(
    mediaContext.playbackRate,
    state.localPlaybackRate
  );
  const previousEpoch = Number(state.mediaEpoch) || 0;
  try {
    postNativeMessage({ type: "cancel", jobId: state.jobId, mediaEpoch: previousEpoch });
  } catch {
    // Helper 断开时下面的 streamStart 会给出统一错误。
  }
  state.mediaEpoch = previousEpoch + 1;
  state.localLiveSeq = 0;
  state.localAudioPositionMs = 0;
  setLocalMediaAnchor(state, {
    currentTimeMs: nextMediaTimeMs,
    playbackRate: nextPlaybackRate
  }, 0);
  state.localCueSequences = Object.create(null);
  state.localCueOriginals = Object.create(null);
  state.localCueTranslations = Object.create(null);
  state.status = "starting";
  state.stageDetail = "正在重新对齐本地字幕…";
  const resetIdentity = sessionIdentity(state);
  const resetTranslate = state.translate;
  const resetPolicy = translationPolicyFields(state);
  const resetMediaKey = state.mediaIdentity || createMediaIdentity();
  const resetDiscontinuityId = Number(state.lastDiscontinuityId) || 0;
  await sendToContent(state, {
    type: "LIVE_RESET",
    jobId: resetIdentity.jobId,
    mediaEpoch: resetIdentity.mediaEpoch,
    reason
  });
  if (!isCurrentSession(state, resetIdentity, true)) return null;
  postNativeMessage({
    type: "streamStart",
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    jobId: resetIdentity.jobId,
    mediaEpoch: resetIdentity.mediaEpoch,
    mediaKey: resetMediaKey,
    sampleRate: 16_000,
    channels: 1,
    translate: Boolean(resetTranslate),
    ...resetPolicy
  });
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "CAPTURE_RESET",
      translate: resetTranslate,
      ...resetPolicy,
      source: "tab",
      engine: "local",
      tabId: resetIdentity.tabId,
      jobId: resetIdentity.jobId,
      mediaEpoch: resetIdentity.mediaEpoch
    });
  } catch {
    response = null;
  }
  if (!isCurrentSession(state, resetIdentity, true)) return null;
  if (!response?.ok || response.ignored) {
    const status = await chrome.runtime.sendMessage({ type: "CAPTURE_STATUS" }).catch(() => null);
    if (!isCurrentSession(state, resetIdentity, true)) return null;
    const stopIdentity = status?.active
      && Number(status.tabId) === state.tabId
      && String(status.jobId || "") === state.jobId
      ? {
          tabId: Number(status.tabId),
          jobId: String(status.jobId || ""),
          mediaEpoch: Number(status.mediaEpoch) || 0
        }
      : { ...resetIdentity, mediaEpoch: previousEpoch };
    await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", ...stopIdentity }).catch(() => undefined);
    try {
      postNativeMessage({ type: "cancel", jobId: resetIdentity.jobId, mediaEpoch: resetIdentity.mediaEpoch });
    } catch { /* Helper disconnected */ }
    if (!isCurrentSession(state, resetIdentity, true)) return null;
    state.captureStarted = false;
    state.localFallbackActive = false;
    state.captureNeedsGesture = true;
    state.status = "starting";
    state.stageDetail = "播放器已经切换，需要重新读取一次标签页声音。";
    if (captureTabId === state.tabId) captureTabId = null;
    captureStreamIds.delete(state.tabId);
    await sendToContent(state, {
      type: "LIVE_STOP",
      jobId: resetIdentity.jobId,
      mediaEpoch: resetIdentity.mediaEpoch
    });
    await publishMediaIssue(state, {
      kind: "action",
      issueCode: "needs_tab_audio",
      detail: state.stageDetail,
      status: "starting",
      captureNeedsGesture: true
    });
    scheduleNativeIdleDisconnect();
    return null;
  }
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: resetIdentity.jobId,
    mediaEpoch: resetIdentity.mediaEpoch,
    translate: resetTranslate,
    audioPositionMs: localMediaTimeAtAudio(state, Number(response.audioPositionMs) || 0),
    mediaTimed: true,
    discontinuityId: resetDiscontinuityId
  });
  await persistStates();
  return response;
}

async function receiveMediaContext(message, sender) {
  const tabId = Number(sender?.tab?.id);
  const state = tabStates.get(tabId);
  if (!state?.captureStarted || state.engine !== "local" || state.localFallbackActive) {
    return { ok: true, ignored: true };
  }
  if (String(message.jobId || "") !== state.jobId) return { ok: true, ignored: true };
  if ((Number(message.mediaEpoch) || 0) !== (Number(state.mediaEpoch) || 0)) return { ok: true, ignored: true };
  const frameId = Number(sender?.frameId) || 0;
  if (frameId !== Number(state.frameId || 0)) return { ok: true, ignored: true };
  const identity = sessionIdentity(state);
  const contextVersion = (Number(state.offlineContextVersion) || 0) + 1;
  state.offlineContextVersion = contextVersion;
  const context = {
    frameId,
    currentSrc: String(message.currentSrc || ""),
    resourceUrls: Array.isArray(message.resourceUrls)
      ? message.resourceUrls.slice(-24).map((item) => typeof item === "string"
        ? item
        : {
            url: String(item?.url || ""),
            observedAt: Number(item?.observedAt) || Date.now(),
            source: item?.source === "page-definition" ? "page-definition" : "performance",
            quality: Math.max(0, Number(item?.quality) || 0)
          })
      : [],
    currentTimeMs: Math.max(0, Number(message.currentTimeMs) || 0),
    durationMs: Math.max(0, Number(message.durationMs) || 0),
    playbackRate: Math.max(0.25, Math.min(4, Number(message.playbackRate) || 1))
  };
  const pageDefinitions = await discoverPageMediaDefinitions(tabId, frameId).catch(() => []);
  // executeScript 期间可能发生 seek / 换源 / 停止。旧页面返回的签名地址和
  // 时间点绝不能覆盖新 epoch，也不能把已停止的会话重新启动。
  if (!isCurrentSession(state, identity, true)
      || state.engine !== "local"
      || state.localFallbackActive
      || state.offlineContextVersion !== contextVersion) {
    return { ok: true, ignored: true };
  }
  for (const definition of pageDefinitions) {
    rememberMediaCandidate(tabId, {
      url: definition.url,
      frameId,
      seenAt: Date.now(),
      source: "page-definition",
      quality: definition.quality
    });
  }
  const candidate = selectMediaCandidate(tabId, context);
  if (!candidate) {
    // 非 HLS 页面随后会切到标签页音频。保留这次播放器快照，
    // 让 capture-relative Whisper cue 能映射回真实视频时间。
    state.offlineContext = context;
    const authorizedStreamId = String(captureStreamIds.get(tabId) || "");
    if (authorizedStreamId) {
      if (state.offlineFallbackTimer) clearTimeout(state.offlineFallbackTimer);
      state.offlineFallbackTimer = 0;
      state.offlineMissingMediaSince = 0;
      const started = await startLocalLiveFallback(state, authorizedStreamId);
      return { ok: true, pending: !started, fallback: started };
    }
    if (!state.offlineMissingMediaSince) state.offlineMissingMediaSince = Date.now();
    const waitingMs = Date.now() - state.offlineMissingMediaSince;
    if (waitingMs >= LOCAL_LIVE_FALLBACK_DELAY_MS) {
      if (state.offlineFallbackTimer) clearTimeout(state.offlineFallbackTimer);
      state.offlineFallbackTimer = 0;
      const started = await startLocalLiveFallback(state);
      return { ok: true, pending: !started, fallback: started };
    }
    scheduleOfflineFallbackProbe(state);
    state.status = "starting";
    state.stageDetail = "正在判断最快的本地字幕方式…";
    await persistStates();
    return { ok: true, pending: true };
  }
  if (state.offlineFallbackTimer) clearTimeout(state.offlineFallbackTimer);
  state.offlineFallbackTimer = 0;
  state.offlineMissingMediaSince = 0;
  state.offlineSourceUrl = candidate.url;
  state.offlineContext = context;
  await beginOfflineEpoch(state);
  maybeExtendOfflinePrep(state);
  return { ok: true };
}

// 本地精准按批预置[当前位置, +120s]。播放接近或越过边界后自动续批；
// 同一时刻只允许一批运行，避免周期性的媒体回报重复启动 Helper。
function maybeExtendOfflinePrep(state) {
  if (shouldStartOfflineBatch(state)) void beginOfflineEpoch(state);
}

function shouldStartOfflineBatch(state) {
  if (!state?.captureStarted || state.engine !== "local"
      || state.localFallbackActive || state.offlineRunActive) return false;
  if (state.offlineMediaComplete === true) return false;
  const epoch = Number(state.mediaEpoch) || 0;
  if (state.offlineStartedEpoch !== epoch) return true;
  const context = state.offlineContext || {};
  const currentMs = Math.max(0, Number(context.currentTimeMs) || 0);
  const durationMs = Math.max(0, Number(context.durationMs) || 0);
  if (durationMs > 0 && currentMs >= durationMs - 1_000) return false;
  const preparedUntilMs = Math.max(0, Number(state.offlinePreparedUntilMs) || 0);
  if (preparedUntilMs <= 0) return true;
  // 短视频的一批预处理可能已经覆盖片尾。此时即使“当前位置 + 提前量”
  // 越过 preparedUntil，也没有下一批可续；否则会在 ready / resolving
  // 之间永久重跑同一段媒体。
  if (durationMs > 0 && preparedUntilMs >= durationMs - 1_000) return false;
  const playbackRate = Math.max(0.25, Math.min(4, Number(context.playbackRate) || 1));
  return currentMs + OFFLINE_REFILL_LEAD_MS * playbackRate >= preparedUntilMs;
}

async function beginOfflineEpoch(state) {
  const epoch = Number(state.mediaEpoch) || 0;
  if (!shouldStartOfflineBatch(state)) return;
  const identity = sessionIdentity(state);
  if (!state.mediaIdentity) state.mediaIdentity = createMediaIdentity();
  const sourceUrl = String(state.offlineSourceUrl || "");
  if (!isHlsUrl(sourceUrl)) return;
  const contextVersion = Number(state.offlineContextVersion) || 0;
  const context = { ...(state.offlineContext || {}) };
  const pageUrl = String(state.pageUrl || "");
  let origin = "";
  try { origin = new URL(pageUrl).origin; } catch { /* optional */ }
  const startToken = (Number(state.offlineStartToken) || 0) + 1;
  state.offlineStartToken = startToken;
  state.offlineStartedEpoch = epoch;
  state.offlineRunActive = true;
  state.status = "starting";
  state.stageDetail = "本地 Helper 正在准备当前位置…";
  await persistStates();
  if (!isCurrentSession(state, identity, true)
      || state.engine !== "local"
      || state.offlineStartToken !== startToken) return;
  if (state.offlineSourceUrl !== sourceUrl || state.offlineContextVersion !== contextVersion) {
    state.offlineRunActive = false;
    return beginOfflineEpoch(state);
  }
  try {
    postNativeMessage({
      type: "start",
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      jobId: state.jobId,
      mediaEpoch: epoch,
      mediaKey: state.mediaIdentity,
      source: {
        url: sourceUrl,
        headers: {
          referer: pageUrl,
          origin
        }
      },
      currentTimeMs: Math.max(0, Number(context.currentTimeMs) || 0),
      durationMs: Math.max(0, Number(context.durationMs) || 0),
      playbackRate: Math.max(0.25, Math.min(4, Number(context.playbackRate) || 1)),
      translate: Boolean(state.translate),
      ...translationPolicyFields(state)
    });
  } catch (error) {
    if (state.offlineStartToken === startToken) state.offlineRunActive = false;
    throw error;
  }
}

function connectNativeHelper() {
  cancelNativeIdleDisconnect();
  if (nativePort) return nativePort;
  if (typeof chrome.runtime.connectNative !== "function") {
    throw new Error("未检测到本地 Koe Helper；请先安装 Helper。");
  }
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  port.onMessage.addListener((message) => { void handleNativeMessage(message); });
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    nativePort = null;
    const detail = chrome.runtime.lastError?.message || "本地 Koe Helper 已断开";
    void appendLog({ event: "native-disconnect", detail: String(detail) });
    for (const state of tabStates.values()) {
      if (!state.captureStarted || state.engine !== "local") continue;
      const wasLocalLive = Boolean(state.localFallbackActive);
      state.captureStarted = false;
      state.status = "error";
      state.userStopped = true;
      resetOfflineBatchState(state);
      state.offlineSourceUrl = "";
      state.offlineContext = undefined;
      state.localFallbackActive = false;
      state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
      mediaCandidatesByTab.delete(state.tabId);
      state.stageDetail = /native messaging host|not found/i.test(detail)
        ? `未安装本地 Koe Helper：${String(detail)}`
        : `本地 Koe Helper 已断开：${String(detail)}`;
      if (wasLocalLive) {
        void chrome.runtime.sendMessage({
          type: "CAPTURE_STOP",
          tabId: state.tabId,
          jobId: state.jobId,
          mediaEpoch: Number(state.mediaEpoch) || 0
        }).catch(() => undefined);
      }
      void publishMediaIssue(state, {
        kind: "error",
        issueCode: "helper_unavailable",
        detail: state.stageDetail,
        status: "error",
        captureNeedsGesture: false
      });
      void sendToContent(state, {
        type: wasLocalLive ? "LIVE_STOP" : "OFFLINE_ERROR",
        jobId: state.jobId,
        mediaEpoch: state.mediaEpoch,
        error: state.stageDetail,
        issueCode: "helper_unavailable"
      });
    }
    void persistStates();
  });
  return port;
}

function postNativeMessage(message) {
  const port = connectNativeHelper();
  port.postMessage(message);
}

function forwardLocalPCM(message) {
  const tabId = Number(message?.tabId);
  const state = Number.isInteger(tabId) ? tabStates.get(tabId) : null;
  if (!state?.captureStarted || state.engine !== "local" || !state.localFallbackActive) {
    return { ok: true, ignored: true };
  }
  if (String(message.jobId || "") !== state.jobId
      || (Number(message.mediaEpoch) || 0) !== (Number(state.mediaEpoch) || 0)) {
    return { ok: true, ignored: true };
  }
  const pcmBase64 = String(message.pcmBase64 || "");
  if (!pcmBase64 || pcmBase64.length > 700_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pcmBase64)) {
    return { ok: false, error: "本地音频片段无效。" };
  }
  state.localAudioPositionMs = Math.max(
    Number(state.localAudioPositionMs) || 0,
    Math.max(0, Number(message.audioPositionMs) || 0)
  );
  postNativeMessage({
    type: "streamAudio",
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    jobId: state.jobId,
    mediaEpoch: Number(state.mediaEpoch) || 0,
    sampleRate: 16_000,
    channels: 1,
    pcmBase64
  });
  return { ok: true };
}

async function forwardLocalStreamCues(state, message, identity = sessionIdentity(state)) {
  const isCurrent = () => matchesSessionIdentity(state, identity)
    && state.captureStarted && state.engine === "local" && !state.userStopped;
  if (!isCurrent()) return;
  const cues = (Array.isArray(message.cues) ? message.cues : [])
    .map((cue) => normalizeOfflineCue(cue))
    .filter(Boolean)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (cues.length === 0) return;
  if (!state.localCueSequences) state.localCueSequences = Object.create(null);
  if (!state.localCueOriginals) state.localCueOriginals = Object.create(null);
  if (!state.localCueTranslations) state.localCueTranslations = Object.create(null);
  const audioPositionMs = Math.max(
    Number(state.localAudioPositionMs) || 0,
    ...cues.map((cue) => cue.endMs)
  );
  const mediaPositionMs = localMediaTimeAtAudio(state, audioPositionMs);
  for (const cue of cues) {
    if (!isCurrent()) return;
    let seq = Number(state.localCueSequences[cue.cueId]) || 0;
    if (!seq) {
      seq = (Number(state.localLiveSeq) || 0) + 1;
      state.localLiveSeq = seq;
      state.localCueSequences[cue.cueId] = seq;
    }
    const timing = {
      ...identity,
      seq,
      unit: true,
      beginTimeMs: localMediaTimeAtAudio(state, cue.startMs),
      endTimeMs: localMediaTimeAtAudio(state, cue.endMs),
      audioPositionMs: mediaPositionMs,
      mediaTimed: true,
      sentenceId: cue.cueId
    };
    if (!state.localCueOriginals[cue.cueId]) {
      state.localCueOriginals[cue.cueId] = cue.text;
      await forwardCaptureLines({ ...timing, lines: [{ text: cue.text }] }, "LIVE_SUBTITLES");
      if (!isCurrent()) return;
    }
    if (state.translate && cue.translated
        && state.localCueTranslations[cue.cueId] !== cue.translated) {
      state.localCueTranslations[cue.cueId] = cue.translated;
      await forwardCaptureLines({
        ...timing,
        streaming: false,
        lines: [{ translated: cue.translated }]
      }, "LIVE_TRANSLATED");
      if (!isCurrent()) return;
    }
  }
  if (!isCurrent()) return;
  state.status = "live";
  state.stageDetail = "本地实时字幕运行中";
  await clearMediaIssue(state);
  if (!isCurrent()) return;
  await persistStates();
}

async function handleNativeMessage(message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "ready") {
    // Helper 通过 hello 握手上报本地翻译能力（macOS 26+ 且支持简体中文目标）。
    nativeTranslationAvailable = Boolean(message.nativeTranslation);
    void appendLog({ event: "native-ready", detail: `nativeTranslation=${nativeTranslationAvailable}` });
    for (const state of tabStates.values()) {
      if (state.engine === "local" && nativeTranslationAvailable === false) state.translate = false;
    }
    void persistStates();
    return;
  }
  if (message.type === "preferences") {
    const preferences = preferenceTools.normalize(message.preferences || {});
    for (const finish of [...nativePreferenceWaiters]) finish(preferences);
    scheduleNativeIdleDisconnect();
    return;
  }
  const state = [...tabStates.values()].find((candidate) => candidate.jobId === String(message.jobId || ""));
  if (!state?.captureStarted || state.engine !== "local") return;
  if ((Number(message.mediaEpoch) || 0) !== (Number(state.mediaEpoch) || 0)) return;
  const nativeIdentity = sessionIdentity(state);
  const isCurrent = () => matchesSessionIdentity(state, nativeIdentity)
    && state.captureStarted && state.engine === "local" && !state.userStopped;
  if (message.type === "status") {
    if (state.localFallbackActive) {
      const alreadyLive = state.status === "live" || Number(state.localLiveSeq) > 0;
      state.status = message.stage === "stream-live" || alreadyLive ? "live" : "starting";
      state.stageDetail = alreadyLive
        ? "本地实时字幕运行中"
        : String(message.detail || "本地实时字幕处理中…");
      await clearMediaIssue(state);
      if (!isCurrent()) return;
      await persistStates();
      return;
    }
    // forward 只是在后台预取后续窗口；首批 cue 此时已经可播放，UI 不应
    // 再退回“准备中”。
    state.status = ["forward", "ready"].includes(message.stage) ? "live" : "starting";
    state.stageDetail = String(message.detail || "本地精准字幕处理中…");
    await clearMediaIssue(state);
    if (!isCurrent()) return;
    // Helper 报告本批字幕预置到哪个媒体时刻；播放逼近该边界时用它续批。
    const preparedUntilMs = Number(message.preparedUntilMs);
    if (Number.isFinite(preparedUntilMs) && preparedUntilMs > 0) {
      state.offlinePreparedUntilMs = Math.max(Number(state.offlinePreparedUntilMs) || 0, preparedUntilMs);
    }
    if (message.stage === "ready") {
      state.offlineRunActive = false;
      state.offlineMediaComplete = message.mediaComplete === true;
    }
    await persistStates();
    if (isCurrent() && message.stage === "ready") maybeExtendOfflinePrep(state);
    return;
  }
  if (message.type === "streamCues" && state.localFallbackActive) {
    await forwardLocalStreamCues(state, message, nativeIdentity);
    return;
  }
  if (message.type === "cues") {
    const durationMs = Number(state.offlineContext?.durationMs) || 0;
    const cues = (Array.isArray(message.cues) ? message.cues : [])
      .map((cue) => normalizeOfflineCue(cue, durationMs))
      .filter(Boolean);
    if (cues.length === 0) return;
    state.status = "live";
    state.stageDetail = "本地精准字幕已就绪";
    await clearMediaIssue(state);
    if (!isCurrent()) return;
    const revision = Math.max(
      (Number(state.offlineCueRevision) || 0) + 1,
      Math.max(0, Number(message.revision) || 0)
    );
    state.offlineCueRevision = revision;
    await sendToContent(state, {
      type: "OFFLINE_CUES",
      jobId: nativeIdentity.jobId,
      mediaEpoch: nativeIdentity.mediaEpoch,
      revision,
      cues
    });
    if (!isCurrent()) return;
    await persistStates();
    return;
  }
  if (message.type === "error") {
    const wasLocalLive = Boolean(state.localFallbackActive);
    const detail = String(message.error || "本地字幕处理失败");
    const issueCode = String(message.issueCode || "media_unreadable");
    state.captureStarted = false;
    state.status = "error";
    state.userStopped = true;
    resetOfflineBatchState(state);
    state.offlineSourceUrl = "";
    state.offlineContext = undefined;
    state.localFallbackActive = false;
    state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
    mediaCandidatesByTab.delete(nativeIdentity.tabId);
    state.stageDetail = detail;
    state.issueCode = issueCode;
    state.issueKind = "error";
    void appendLog({ event: "native-error", detail });
    if (captureTabId === nativeIdentity.tabId) captureTabId = null;
    if (wasLocalLive) {
      try {
        await chrome.runtime.sendMessage({
          type: "CAPTURE_STOP",
          ...nativeIdentity
        });
      } catch { /* offscreen unavailable */ }
    }
    await sendToContent(state, {
      type: wasLocalLive ? "LIVE_STOP" : "OFFLINE_ERROR",
      jobId: nativeIdentity.jobId,
      mediaEpoch: nativeIdentity.mediaEpoch,
      error: detail,
      issueCode
    });
    if (matchesSessionIdentity(state, nativeIdentity) && !state.captureStarted) {
      await clearPageMediaStatus(state);
      if (matchesSessionIdentity(state, nativeIdentity) && !state.captureStarted) await persistStates();
    }
    scheduleNativeIdleDisconnect();
  }
}

function normalizeOfflineCue(cue, durationMs = 0) {
  const startMs = Number(cue?.startMs);
  const endMs = Number(cue?.endMs);
  const text = String(cue?.text || "").trim();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || !text) return null;
  if (durationMs > 0 && startMs > durationMs + 1_000) return null;
  const clampedEndMs = durationMs > 0 ? Math.min(endMs, durationMs) : endMs;
  if (clampedEndMs <= startMs) return null;
  return {
    cueId: String(cue.cueId || `${Math.round(startMs)}-${Math.round(endMs)}`),
    startMs,
    endMs: clampedEndMs,
    text,
    translated: String(cue.translated || "").trim()
  };
}

function isLiveAllowed(source) {
  if (!source?.playing) return false;
  if (isAdSource(source.sourceUrl || "")) return false;
  // 静音播放器没有声音可采，等用户取消静音后再开始
  if (source.muted) return false;
  return true;
}

async function ensureCaptureAuthorized(state) {
  const pending = captureStartPromises.get(state.tabId);
  if (pending) return pending;

  const attempt = runCaptureAuthorization(state);
  captureStartPromises.set(state.tabId, attempt);
  try {
    return await attempt;
  } finally {
    if (captureStartPromises.get(state.tabId) === attempt) {
      captureStartPromises.delete(state.tabId);
    }
  }
}

async function runCaptureAuthorization(state) {
  // 用户主动停止后绝不自动重开：
  // content.js 每 3 秒发 PAGE_READY → ensureLiveCaptions → 这里。
  // 点"停止"按钮本身就是用户手势（5 秒窗口），getMediaStreamId 会成功，
  // 不在这里拦的话停止后字幕会悄悄又开起来（"根本停不下来"）。
  if (state.userStopped) return;
  // 麦克风来源不需要 tabCapture 授权手势：直接启动
  if (state.source === "mic") {
    await startCapture(state, "");
    return;
  }
  let streamId = captureStreamIds.get(state.tabId) || "";
  if (!streamId) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tabId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/gesture|invocation|permission|user gesture/i.test(message)) {
        // 用户刚主动停止过：不再弹“点击开启”的提示，直到切换视频或手动再开
        if (state.userStopped) return;
        state.captureNeedsGesture = true;
        state.status = "starting";
        state.stageDetail = "打开 Koe 控制器后点「继续开启字幕」";
        await publishMediaIssue(state, {
          kind: "action",
          issueCode: "needs_tab_audio",
          detail: state.stageDetail,
          status: "starting",
          captureNeedsGesture: true
        });
        return;
      }
      throw error;
    }
  }
  try {
    await startCapture(state, streamId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureStreamIds.delete(state.tabId);
    state.captureStarted = false;
    state.captureNeedsGesture = false;
    state.status = "error";
    state.stageDetail = message || "无法开始采集标签页声音。";
    await publishMediaIssue(state, {
      kind: "error",
      issueCode: "capture_failed",
      detail: state.stageDetail,
      status: "error",
      captureNeedsGesture: false
    });
    scheduleNativeIdleDisconnect();
  }
}
async function startCapture(state, streamId) {
  const startIdentity = sessionIdentity(state);
  const baseIntentId = captureIntentId;
  const attemptId = ++captureAttemptId;
  // 扩展重载后已打开的页面可能没有内容脚本，先补上视频探测脚本。
  await ensureContentScript(state.tabId, state.frameId || 0);
  if (!isCurrentCaptureAttempt(state, startIdentity, attemptId, baseIntentId)) return;
  const { koeApiKey } = await chrome.storage.local.get("koeApiKey");
  if (!isCurrentCaptureAttempt(state, startIdentity, attemptId, baseIntentId)) return;
  const apiKey = String(koeApiKey || "").trim();
  // 内置识别（Chrome 内置）不需要 DashScope Key；其余引擎需要
  const keyless = state.engine === "webspeech";
  if (!keyless && !apiKey) {
    throw new Error("请先在 Koe 中保存 DashScope API Key。");
  }
  await syncAuthorizationRule(apiKey);
  if (!isCurrentCaptureAttempt(state, startIdentity, attemptId, baseIntentId)) return;
  await ensureOffscreen();
  if (!isCurrentCaptureAttempt(state, startIdentity, attemptId, baseIntentId)) return;

  // 只有所有可能失败的预检都完成后才提交接管意图。较新的尝试如果预检失败，
  // 不会让已经 provisional-active 的旧标签页在 await 返回后自行退出。
  const intentId = commitCaptureIntent(state, startIdentity, attemptId, baseIntentId);
  if (!intentId) return;

  const previous = captureTabId ? tabStates.get(captureTabId) : null;
  if (previous && previous.tabId !== state.tabId && previous.captureStarted) {
    // 与本地模式相同，先阻止旧页自动重启，再进行会让出事件循环的停止。
    previous.userStopped = true;
    await stopCapture(previous);
    if (!isCurrentCaptureIntent(state, startIdentity, intentId)) return;
    previous.status = "idle";
    previous.stageDetail = "字幕已切换到另一个标签页";
    previous.captureNeedsGesture = false;
  }

  // 在启动 offscreen 前建立路由。连接建立期间积压的首批音频可能很快返回，
  // 不能等 CAPTURE_START 响应后才设置 captureTabId，否则开头字幕会被丢弃。
  await clearMediaIssue(state);
  if (!isCurrentCaptureIntent(state, startIdentity, intentId)) return;
  state.captureStarted = true;
  state.captureNeedsGesture = false;
  state.status = "starting";
  state.stageDetail = "正在连接 DashScope…";
  state.mediaEpoch = Number(state.mediaEpoch) || 0;
  state.captureStartIntentId = intentId;
  captureTabId = state.tabId;
  await clearTranscript();
  if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
    await abandonProvisionalCapture(state, startIdentity, intentId);
    return;
  }
  await persistStates();
  if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
    await abandonProvisionalCapture(state, startIdentity, intentId);
    return;
  }
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    translate: state.translate,
    audioPositionMs: 0
  });
  if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
    await abandonProvisionalCapture(state, startIdentity, intentId, { sessionAnnounced: true });
    return;
  }

  let response;
  let startSubmitted = false;
  try {
    startSubmitted = true;
    response = await chrome.runtime.sendMessage({
      type: "CAPTURE_START",
      streamId: streamId || "",
      apiKey,
      translate: state.translate,
      ...translationPolicyFields(state),
      source: state.source || "tab",
      engine: state.engine || "dashscope",
      tabId: state.tabId,
      jobId: state.jobId,
      mediaEpoch: state.mediaEpoch
    });
    if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
      await abandonProvisionalCapture(state, startIdentity, intentId, {
        sessionAnnounced: true,
        startSubmitted
      });
      return;
    }
    if (!response?.ok) throw new Error(response?.error || "无法开始采集标签页声音。");
  } catch (error) {
    if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
      await abandonProvisionalCapture(state, startIdentity, intentId, {
        sessionAnnounced: true,
        startSubmitted
      });
      return;
    }
    state.captureStarted = false;
    state.captureStartIntentId = 0;
    state.status = "error";
    state.stageDetail = error instanceof Error ? error.message : String(error);
    if (captureTabId === state.tabId) captureTabId = null;
    await publishMediaIssue(state, {
      kind: "error",
      issueCode: "capture_failed",
      detail: state.stageDetail,
      status: "error",
      captureNeedsGesture: false
    });
    throw error;
  }

  state.status = "live";
  state.stageDetail = "";
  await clearMediaIssue(state);
  if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
    await abandonProvisionalCapture(state, startIdentity, intentId, {
      sessionAnnounced: true,
      startSubmitted: true
    });
    return;
  }
  // 只启用该标签页的侧边栏入口，不主动打开；页面字幕是主显示，
  // 记录与设置面板仅在用户明确需要时占用屏幕。
  try {
    await chrome.sidePanel.setOptions({ tabId: state.tabId, path: "sidepanel.html", enabled: true });
  } catch {
    // 无手势或版本不支持时忽略
  }
  if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
    await abandonProvisionalCapture(state, startIdentity, intentId, {
      sessionAnnounced: true,
      startSubmitted: true
    });
    return;
  }
  await persistStates();
  if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)) {
    await abandonProvisionalCapture(state, startIdentity, intentId, {
      sessionAnnounced: true,
      startSubmitted: true
    });
    return;
  }
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: startIdentity.jobId,
    mediaEpoch: startIdentity.mediaEpoch,
    translate: state.translate,
    audioPositionMs: Number(response.audioPositionMs) || 0
  });
  // tabs.sendMessage 本身也会让出事件循环。若别的标签页恰好在消息投递期间
  // 接管，补发旧身份 STOP，保证页面最终顺序不会停在迟到的 LIVE_SESSION。
  // 同一 tab/job/epoch 的更新启动会自行发最终会话，不用旧任务误停它。
  if (!isCurrentCaptureIntent(state, startIdentity, intentId, true)
      && !isCurrentSession(state, startIdentity, true)) {
    await sendToContent(state, {
      type: "LIVE_STOP",
      jobId: startIdentity.jobId,
      mediaEpoch: startIdentity.mediaEpoch
    });
  }
}

async function syncAuthorizationRule(apiKey) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [AUTH_RULE_ID],
    addRules: [{
      id: AUTH_RULE_ID,
      priority: 10,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Authorization", operation: "set", value: `Bearer ${apiKey}` }]
      },
      condition: {
        urlFilter: "||dashscope.aliyuncs.com/api-ws/",
        resourceTypes: ["websocket"],
        initiatorDomains: [chrome.runtime.id]
      }
    }]
  });
}

async function resetCaptureSession(state) {
  const identity = sessionIdentity(state);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_RESET",
      translate: state.translate,
      ...translationPolicyFields(state),
      source: state.source,
      engine: state.engine,
      tabId: state.tabId,
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0
    });
    if (!response?.ok || response.ignored) throw new Error(response?.error || "capture_reset_ignored");
    if (!isCurrentSession(state, identity, true)) return null;
    return response;
  } catch {
    // 离屏页丢失：用现有流 ID 完整重启采集
    if (!isCurrentSession(state, identity, true)) return null;
    const streamId = state.source === "mic" ? "" : captureStreamIds.get(state.tabId);
    if (state.source === "mic" || streamId) {
      try {
        await startCapture(state, streamId);
      } catch {
        // 保留旧状态，用户可再点一次图标
      }
    } else {
      state.captureStarted = false;
      state.localFallbackActive = false;
      if (captureTabId === state.tabId) captureTabId = null;
      await publishMediaIssue(state, {
        kind: "action",
        issueCode: "needs_tab_audio",
        detail: "播放器已经切换，需要重新读取一次标签页声音。",
        status: "starting",
        captureNeedsGesture: true
      });
    }
  }
  return null;
}

async function stopCapture(state) {
  if (!state?.captureStarted) return;
  const stopIdentity = sessionIdentity(state);
  const stopEngine = state.engine;
  const wasLocalLive = stopEngine === "local" && Boolean(state.localFallbackActive);
  state.captureStarted = false;
  state.captureStartIntentId = 0;
  state.status = "starting";
  if (captureTabId === state.tabId) captureTabId = null;
  if (stopEngine === "local") {
    try {
      postNativeMessage({
        type: wasLocalLive ? "streamStop" : "cancel",
        jobId: stopIdentity.jobId,
        mediaEpoch: stopIdentity.mediaEpoch
      });
    } catch {
      // Helper 已断开时任务自然终止。
    }
    if (wasLocalLive) {
      try {
        await chrome.runtime.sendMessage({
          type: "CAPTURE_STOP",
          ...stopIdentity
        });
      } catch {
        // 离屏采集页可能已经结束。
      }
    }
    // 等待 offscreen 期间同一标签页可能已被用户以新 job/epoch 重开。
    // 只清理仍属于本次停止的旧状态，不能覆盖新的会话字段。
    if (tabStates.get(stopIdentity.tabId) === state
        && state.jobId === stopIdentity.jobId
        && (Number(state.mediaEpoch) || 0) === stopIdentity.mediaEpoch
        && !state.captureStarted) {
      resetOfflineBatchState(state);
      state.offlineSourceUrl = "";
      state.offlineContext = undefined;
      state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
      state.localFallbackActive = false;
      state.localCueSequences = undefined;
      state.localCueOriginals = undefined;
      state.localCueTranslations = undefined;
      state.localAudioPositionMs = 0;
      mediaCandidatesByTab.delete(stopIdentity.tabId);
    }
  } else {
    try {
      await chrome.runtime.sendMessage({
        type: "CAPTURE_STOP",
        ...stopIdentity
      });
    } catch {
      // 后台可能刚唤醒，离屏采集页尚未就绪
    }
  }
  try {
    await chrome.runtime.sendMessage({ type: "LIVE_STOP", ...stopIdentity });
  } catch {
    // 侧边栏未打开时忽略
  }
  await sendToContent(state, {
    type: stopEngine === "local" && !wasLocalLive ? "OFFLINE_STOP" : "LIVE_STOP",
    jobId: stopIdentity.jobId,
    mediaEpoch: stopIdentity.mediaEpoch
  });
  scheduleNativeIdleDisconnect();
}

// 点图标时后台决定“该捕获谁”：本页有正在播放的主视频 → 本页；
// 否则跟随正在发声的标签页（优先当前窗口）；都没有 → tabId: null（弹窗给提示）
// 环形日志缓冲：offscreen 打点 → KOE_LOG 存这里（最多 600 条），
// 侧边栏「复制日志」→ GET_LOGS 取走。
const LOG_LIMIT = 600;
// 日志写入串行化：并发 appendLog 各自 get→set 会互相覆盖丢日志
// （同一时刻多条 KOE_LOG 到达时，前一条被后一条的读取结果覆盖）。
// 用 promise 链把写入排成队列，保证每条都落盘。
let logWriteChain = Promise.resolve();
function appendLog({ event, detail = "", ts = Date.now() }) {
  const entry = { ts: Number(ts) || Date.now(), event: String(event || ""), detail: String(detail || "") };
  logWriteChain = logWriteChain
    .then(async () => {
      const { koeLogs = [] } = await chrome.storage.local.get("koeLogs");
      koeLogs.push(entry);
      while (koeLogs.length > LOG_LIMIT) koeLogs.shift();
      await chrome.storage.local.set({ koeLogs });
    })
    .catch(() => {
      // 日志存储失败不影响主流程
    });
  return { ok: true };
}

async function getLogs() {
  try {
    const { koeLogs = [] } = await chrome.storage.local.get("koeLogs");
    return { ok: true, logs: koeLogs };
  } catch {
    return { ok: true, logs: [] };
  }
}

async function clearLogs() {
  try {
    await chrome.storage.local.set({ koeLogs: [] });
  } catch {
    // 清空失败不影响主流程
  }
  return { ok: true };
}

// ===== 字幕记录持久化（侧边栏每 tab 一实例，切 tab 时恢复历史）=====
// 存 session（SW 休眠不丢、不落盘），最近 300 行。
const TRANSCRIPT_LIMIT = 300;
let transcriptWriteChain = Promise.resolve();
let transcriptCache = [];
let transcriptHydrated = false;

async function hydrateTranscript() {
  if (transcriptHydrated) return;
  const { koeTranscript = [] } = await chrome.storage.session.get("koeTranscript");
  transcriptCache = Array.isArray(koeTranscript) ? koeTranscript.map((row) => ({ ...row })) : [];
  transcriptHydrated = true;
}

function normalizeTranscriptUpdate(entry, existing = null) {
  const update = { ...entry };
  const hasBegin = Object.prototype.hasOwnProperty.call(update, "beginTimeMs");
  const hasEnd = Object.prototype.hasOwnProperty.call(update, "endTimeMs");
  if (hasBegin) {
    const value = Number(update.beginTimeMs);
    if (Number.isFinite(value)) update.beginTimeMs = value;
    else delete update.beginTimeMs;
  }
  if (hasEnd) {
    const value = Number(update.endTimeMs);
    if (Number.isFinite(value)) update.endTimeMs = value;
    else delete update.endTimeMs;
  }
  const validBeginUpdate = Object.prototype.hasOwnProperty.call(update, "beginTimeMs");
  const validEndUpdate = Object.prototype.hasOwnProperty.call(update, "endTimeMs");
  const begin = Number(validBeginUpdate
    ? update.beginTimeMs
    : existing?.beginTimeMs);
  const end = Number(validEndUpdate
    ? update.endTimeMs
    : existing?.endTimeMs);
  const invalidNegative = (Number.isFinite(begin) && begin < 0) || (Number.isFinite(end) && end < 0);
  if (invalidNegative || (Number.isFinite(begin) && Number.isFinite(end) && end < begin)) {
    if (validBeginUpdate) delete update.beginTimeMs;
    if (validEndUpdate) delete update.endTimeMs;
  }
  return update;
}

function recordTranscript(entry) {
  transcriptWriteChain = transcriptWriteChain
    .then(async () => {
      await hydrateTranscript();
      const seq = Number(entry.seq);
      const epoch = Number(entry.mediaEpoch) || 0;
      const jobId = String(entry.jobId || "");
      let existing = transcriptCache.find((row) => Number(row.seq) === seq
        && (Number(row.mediaEpoch) || 0) === epoch
        && String(row.jobId || "") === jobId);
      const incomingText = String(entry.text || "").trim();
      const existingText = String(existing?.text || "").trim();
      // 同一键出现不同原文表示上游发生了序号碰撞。不能把新原文与旧译文/时间
      // 拼成一行；替换整条记录，让损坏局限在当前消息。
      if (existing && incomingText && existingText && incomingText !== existingText) {
        transcriptCache.splice(transcriptCache.indexOf(existing), 1);
        existing = null;
      }
      const update = normalizeTranscriptUpdate(entry, existing);
      if (existing) Object.assign(existing, update);
      else transcriptCache.push({ ...update, seq, mediaEpoch: epoch, jobId });
      while (transcriptCache.length > TRANSCRIPT_LIMIT) transcriptCache.shift();
      await chrome.storage.session.set({ koeTranscript: transcriptCache });
    })
    .catch(() => {});
}

function clearTranscript() {
  transcriptWriteChain = transcriptWriteChain
    .then(async () => {
      // 与旧会话正在排队的写入共用同一条链：旧写入先落完，再由这个
      // 原子清空收尾，不能让旧字幕在新会话清空之后反向写回来。
      transcriptCache = [];
      transcriptHydrated = true;
      await chrome.storage.session.set({ koeTranscript: [] });
    })
    .catch(() => {});
  return transcriptWriteChain;
}

function removeTranscriptRange(fromSeq, toSeq, mediaEpoch = 0, jobId = "") {
  transcriptWriteChain = transcriptWriteChain
    .then(async () => {
      await hydrateTranscript();
      const from = Number(fromSeq) || 0;
      const to = Number(toSeq) || from;
      const epoch = Number(mediaEpoch) || 0;
      const targetJobId = String(jobId || "");
      transcriptCache = transcriptCache.filter((row) => {
        const seq = Number(row.seq) || 0;
        const sameJob = !targetJobId || String(row.jobId || "") === targetJobId;
        return !sameJob || (Number(row.mediaEpoch) || 0) !== epoch || seq < from || seq > to;
      });
      await chrome.storage.session.set({ koeTranscript: transcriptCache });
    })
    .catch(() => {});
  return transcriptWriteChain;
}

async function getTranscript() {
  try {
    await transcriptWriteChain;
    const { koeTranscript = [] } = await chrome.storage.session.get("koeTranscript");
    return { ok: true, rows: koeTranscript };
  } catch {
    return { ok: true, rows: [] };
  }
}

async function recommendCaptureTab(tabId) {
  // 麦克风模式不需要页面里有视频，直接推荐当前页即可
  const { koeCaptureSource, koeAsrEngine } = await chrome.storage.local
    .get(["koeCaptureSource", "koeAsrEngine"]).catch(() => ({}));
  if (koeCaptureSource === "mic") return { ok: true, tabId: tabId || null };
  if (tabId) {
    const source = await discoverVideoSource(tabId, "", { allowPaused: koeAsrEngine === "local" }).catch(() => null);
    if (source?.hasVideo && (koeAsrEngine === "local" || (source.playing && source.sourceUrl))
        && !isAdSource(source.sourceUrl || "")) {
      return { ok: true, tabId };
    }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const audible = await chrome.tabs.query({ audible: true }).catch(() => []);
  const pick = audible.find((tab) => tab.id === active?.id) || audible[0] || null;
  return { ok: true, tabId: pick?.id || null };
}

async function startCaptureForTab({ tabId, streamId, pageUrl = "" }) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return { ok: false, error: "没有找到当前标签页。" };
  // 手动开启（弹窗/侧边栏按钮）= 用户明确意图：无论有没有 streamId
  // （mic 模式无 streamId）都重置 userStopped，让后续授权能走通
  const preState = tabStates.get(id);
  if (preState) preState.userStopped = false;
  if (streamId) {
    captureStreamIds.set(id, streamId);
    if (preState) {
      preState.captureNeedsGesture = false;
      preState.status = "starting";
      preState.stageDetail = preState.engine === "local"
        ? "正在启动本地字幕…"
        : "正在连接 DashScope…";
    }
  }
  // 自动本地回退已经等在浏览器手势时，用户这次点击只需补上 streamId；
  // 不再重新跑一轮 HLS 探测，点击后立即开始本机实时识别。
  if (streamId && preState?.captureStarted && preState.engine === "local"
      && (preState.captureNeedsGesture || preState.offlineMissingMediaSince)) {
    const started = await startLocalLiveFallback(preState, streamId);
    if (started) return { ok: true, state: publicState(preState) };
  }
  await ensureLiveCaptions({ tabId: id, pageUrl, forceReset: true });
  const state = tabStates.get(id);
  if (state?.captureStarted) return { ok: true, state: publicState(state) };
  if (state?.captureNeedsGesture) return { ok: false, error: state.stageDetail || "需要再点击一次以授权声音采集。" };
  if (state?.status === "error") return { ok: false, error: state.stageDetail || "实时字幕已断开。" };
  // 其他标签页正在发声时提示用户回到控制器明确选择开启。
  const audibleElsewhere = await chrome.tabs.query({ audible: true })
    .then((tabs) => tabs.some((tab) => tab.id !== id))
    .catch(() => false);
  if (audibleElsewhere) {
    return { ok: false, error: "当前页面没有正在播放的视频；检测到其他标签页有声音，请在 Koe 控制器中再点一次开启。" };
  }
  return { ok: false, error: "当前页面没有正在播放、未静音的视频（先播放视频再试）。" };
}

async function stopCaptureForTab(request) {
  const tabId = request && typeof request === "object" ? request.tabId : request;
  const jobId = request && typeof request === "object" ? String(request.jobId || "") : "";
  const id = Number(tabId);
  const active = captureTabId ? tabStates.get(captureTabId) : null;
  // 弹窗/侧边栏可能还拿着交接前的状态。旧 STOP(A) 绝不能把刚启动的
  // 全局会话 B 的 offscreen 音频杀掉；让 UI 刷新后再针对 B 明确停止。
  if (jobId && (!active || active.jobId !== jobId || active.tabId !== id)) {
    return { ok: true, stale: true, state: publicState(active) };
  }
  // 用户明确停止会作废所有仍在等待异步授权/交接的旧启动。
  captureAttemptId += 1;
  captureIntentId += 1;
  const state = active?.tabId === id ? active : tabStates.get(id);
  if (!state) {
    // 仅在后台确实没有任何已知会话时做恢复性全局停止。
    try { await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", force: true }); } catch { /* offscreen 未就绪 */ }
    return { ok: true, state: publicState(null) };
  }
  if (state.captureStarted) {
    await stopCapture(state);
    state.status = "idle";
    state.stageDetail = "";
    state.captureNeedsGesture = false;
  } else {
    // SW 恢复后状态可能先显示未运行，而独立 offscreen 仍持有音频流；
    // 只有已核对为当前目标的停止请求可以执行这次恢复性全局停止。
    try {
      await chrome.runtime.sendMessage({
        type: "CAPTURE_STOP",
        tabId: state.tabId,
        jobId: state.jobId,
        mediaEpoch: Number(state.mediaEpoch) || 0
      });
    } catch { /* offscreen 未就绪 */ }
    if (captureTabId === id) captureTabId = null;
    state.status = "idle";
    state.stageDetail = "";
    state.captureNeedsGesture = false;
  }
  // 停止是最终的 OFF 状态：不能让之前的授权提示或终止错误继续把主按钮
  // 渲染成“继续/重试”。同时通知页面撤掉残留的媒体状态提示。
  await clearMediaIssue(state);
  if (state.engine === "local") {
    resetOfflineBatchState(state);
    state.offlineSourceUrl = "";
    state.offlineContext = undefined;
    state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
    mediaCandidatesByTab.delete(id);
  }
  // 主动停止 = 彻底释放：清掉缓存的音频流 id（流已释放，旧 id 不应残留）
  captureStreamIds.delete(id);
  // 主动停止 = 不再打扰：换页、换视频和播放事件都不再提示或启动，直到手动再开。
  state.userStopped = true;
  await persistStates();
  scheduleNativeIdleDisconnect();
  return { ok: true, state: publicState(tabStates.get(id)) };
}

// 识别修正撤回：offscreen 发现服务端把已上屏的句子整体换词时，
// 通知侧边栏删掉对应行（按 seq 匹配），避免“奥凯尤尔资产/识别你的资产”这类错行并存。
async function forwardRevoke(message) {
  const { fromSeq = 0, toSeq = 0, text = "" } = message;
  const state = resolveCaptureState(message);
  if (!state?.captureStarted || !state.jobId) return { ok: true, ignored: true };
  if (Number(message.mediaEpoch) !== (Number(state.mediaEpoch) || 0)) return { ok: true, ignored: true };
  await removeTranscriptRange(fromSeq, toSeq, message.mediaEpoch, state.jobId);
  const payload = {
    type: "LIVE_REVOKE",
    jobId: state.jobId,
    mediaEpoch: Number(message.mediaEpoch) || 0,
    fromSeq: Number(fromSeq) || 0,
    toSeq: Number(toSeq) || 0,
    text: String(text || "")
  };
  try {
    await chrome.runtime.sendMessage(payload);
  } catch {
    // 侧边栏未打开时忽略
  }
  await sendToContent(state, payload);
  return { ok: true };
}

async function forwardCaptureLines(message, type) {
  const state = resolveCaptureState(message);
  if (!state?.captureStarted || !state.jobId) return { ok: true, ignored: true };
  if (Number(message.mediaEpoch) !== (Number(state.mediaEpoch) || 0)) return { ok: true, ignored: true };
  const lines = Array.isArray(message.lines) ? message.lines : [];
  // 字幕记录持久化：侧边栏是"每 tab 一个实例"，切 tab 时面板重新加载、
  // 历史清空。把最近的字幕行存到后台（session），新实例接管时拉回恢复。
  if (type === "LIVE_SUBTITLES") {
    recordTranscript({
      seq: message.seq,
      text: lines[0]?.text,
      jobId: state.jobId,
      mediaEpoch: message.mediaEpoch,
      beginTimeMs: message.beginTimeMs,
      endTimeMs: message.endTimeMs,
      sentenceId: message.sentenceId
    });
  } else if (type === "LIVE_TRANSLATED" && !message.streaming) {
    recordTranscript({
      seq: message.seq,
      translated: lines[0]?.translated,
      jobId: state.jobId,
      mediaEpoch: message.mediaEpoch,
      beginTimeMs: message.beginTimeMs,
      endTimeMs: message.endTimeMs,
      sentenceId: message.sentenceId
    });
  }
  const payload = {
    type,
    jobId: state.jobId,
    lines,
    seq: message.seq,
    unit: message.unit,
    streaming: Boolean(message.streaming),
    mediaEpoch: Number(message.mediaEpoch) || 0,
    beginTimeMs: message.beginTimeMs,
    endTimeMs: message.endTimeMs,
    audioPositionMs: message.audioPositionMs,
    mediaTimed: message.mediaTimed === true,
    sentenceId: message.sentenceId
  };
  // 同一条字幕同时送给页面画面字幕与侧边栏记录。
  try {
    await chrome.runtime.sendMessage(payload);
  } catch {
    // 侧边栏未打开时忽略
  }
  await sendToContent(state, payload);
  return { ok: true };
}

async function handleCaptureError(message) {
  const state = resolveCaptureState(message);
  if (!state) return { ok: true, ignored: true };
  const errorIdentity = sessionIdentity(state);
  const wasLocalLive = state.engine === "local" && Boolean(state.localFallbackActive);
  const detail = "实时字幕已断开 · 打开 Koe 控制器后点「重新尝试」";
  if (captureTabId === errorIdentity.tabId) captureTabId = null;
  state.captureStarted = false;
  state.captureStartIntentId = 0;
  state.status = "error";
  state.captureNeedsGesture = true;
  state.stageDetail = detail;
  state.issueKind = "error";
  state.issueCode = "capture_failed";
  if (wasLocalLive) {
    try {
      postNativeMessage({
        type: "streamStop",
        jobId: errorIdentity.jobId,
        mediaEpoch: errorIdentity.mediaEpoch
      });
    } catch { /* Helper unavailable */ }
    state.localFallbackActive = false;
  }
  captureStreamIds.delete(errorIdentity.tabId);
  try {
    // 终止错误来自 offscreen；后台必须明确释放出错时的精确采集身份。
    await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", ...errorIdentity });
  } catch {
    // offscreen 可能已经自行关闭。
  }
  try {
    await chrome.runtime.sendMessage({ type: "LIVE_STOP", ...errorIdentity });
  } catch {
    // 侧边栏未打开时忽略
  }
  await sendToContent(state, { type: "LIVE_STOP", ...errorIdentity });
  // 等待 offscreen/页面期间用户可能已经在同一 state 对象上重开新会话。
  // 旧错误只能落盘自己的封存状态，不能再覆盖新的 job/epoch。
  if (!matchesSessionIdentity(state, errorIdentity) || state.captureStarted) {
    scheduleNativeIdleDisconnect();
    return { ok: true, stale: true };
  }
  await clearPageMediaStatus(state);
  if (matchesSessionIdentity(state, errorIdentity) && !state.captureStarted) await persistStates();
  scheduleNativeIdleDisconnect();
  return { ok: true };
}

async function setTranslate(tabId, translate) {
  const state = tabStates.get(tabId);
  if (!state) return { ok: true, ignored: true };
  const allowed = state.engine === "local"
    ? (nativeTranslationAvailable !== false && Boolean(translate))
    : Boolean(translate);
  state.translate = allowed;
  if (state.captureStarted && state.engine === "local") {
    if (state.localFallbackActive) {
      await resetLocalLiveSession(state, "translate");
      return { ok: true, state: publicState(state) };
    }
    // Helper 只在 start 时读取 translate。切换翻译时重跑一次 offline epoch，
    // 让 Helper 用新的开关重新开始，并作废旧任务的排队结果。
    resetOfflineBatchState(state, { preserveRevision: true });
    await beginOfflineEpoch(state);
    await sendToContent(state, {
      type: "OFFLINE_SESSION",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      translate: state.translate,
      discontinuityId: Number(state.lastDiscontinuityId) || 0
    });
    await persistStates();
    return { ok: true, state: publicState(state) };
  }
  // 翻译队列可能还有旧模式的请求在飞。提升 epoch 后重连，既清掉队列，
  // 也让页面立即按新模式渲染，旧译文晚到不会污染当前字幕。
  if (state.captureStarted) {
    state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
    const resetIdentity = sessionIdentity(state);
    const resetTranslate = state.translate;
    await sendToContent(state, {
      type: "LIVE_RESET",
      jobId: state.jobId,
      mediaEpoch: state.mediaEpoch,
      reason: "translate"
    });
    if (!isCurrentSession(state, resetIdentity, true)) {
      return { ok: true, state: publicState(state), superseded: true };
    }
    const response = await resetCaptureSession(state);
    if (!isCurrentSession(state, resetIdentity, true)) {
      return { ok: true, state: publicState(state), superseded: true };
    }
    await sendToContent(state, {
      type: "LIVE_SESSION",
      jobId: resetIdentity.jobId,
      mediaEpoch: resetIdentity.mediaEpoch,
      translate: resetTranslate,
      audioPositionMs: Number(response?.audioPositionMs) || 0
    });
  }
  await persistStates();
  return { ok: true, state: publicState(state) };
}

async function setSkipSameLanguage(tabId, skipSameLanguage) {
  const state = tabStates.get(tabId);
  if (!state) return { ok: true, ignored: true };
  const nextSkip = Boolean(skipSameLanguage);
  const nextPreferredLanguage = currentPreferredLanguage();
  const changed = state.skipSameLanguage !== nextSkip
    || String(state.preferredLanguage || "") !== nextPreferredLanguage;
  state.skipSameLanguage = nextSkip;
  state.preferredLanguage = nextPreferredLanguage;

  // 翻译关闭、会话未运行或值没有变化时，只需保存偏好快照。以后启动时
  // start/CAPTURE_START 会携带最新策略，不应为了一个无效变化打断播放。
  if (!changed || !state.captureStarted || !state.translate) {
    await persistStates();
    return { ok: true, state: publicState(state) };
  }

  if (state.engine === "local") {
    if (state.localFallbackActive) {
      await resetLocalLiveSession(state, "language-policy");
      return { ok: true, state: publicState(state) };
    }
    // Helper 在一批任务开始时冻结语言策略。作废旧 epoch 后重开，避免旧翻译
    // 晚到并覆盖“同语言只显示原文”的新结果。
    const previousEpoch = Number(state.mediaEpoch) || 0;
    try {
      postNativeMessage({ type: "cancel", jobId: state.jobId, mediaEpoch: previousEpoch });
    } catch {
      // Helper 断开时仍可完成页面状态切换，后续错误由原通道统一呈现。
    }
    state.mediaEpoch = previousEpoch + 1;
    resetOfflineBatchState(state, { preserveRevision: true });
    await sendToContent(state, {
      type: "OFFLINE_RESET",
      jobId: state.jobId,
      mediaEpoch: state.mediaEpoch,
      reason: "language-policy"
    });
    await persistStates();
    await beginOfflineEpoch(state);
    return { ok: true, state: publicState(state) };
  }

  // 云端识别/翻译同样存在飞行中的请求；使用新 epoch 重连，保证新旧策略
  // 的结果不会交叉写入同一条字幕时间线。
  state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
  const resetIdentity = sessionIdentity(state);
  const resetTranslate = state.translate;
  await sendToContent(state, {
    type: "LIVE_RESET",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    reason: "language-policy"
  });
  if (!isCurrentSession(state, resetIdentity, true)) {
    return { ok: true, state: publicState(state), superseded: true };
  }
  const response = await resetCaptureSession(state);
  if (!isCurrentSession(state, resetIdentity, true)) {
    return { ok: true, state: publicState(state), superseded: true };
  }
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: resetIdentity.jobId,
    mediaEpoch: resetIdentity.mediaEpoch,
    translate: resetTranslate,
    audioPositionMs: Number(response?.audioPositionMs) || 0
  });
  await persistStates();
  return { ok: true, state: publicState(state) };
}

// 声音来源 / 识别引擎切换：更新配置并重连（来源切换需要一次新的麦克风授权，无需手势）
async function setCaptureConfig(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return { ok: true, ignored: true };
  const previousSource = state.source;
  const previousEngine = state.engine;
  let nextSource = previousSource;
  let nextEngine = previousEngine;
  try {
    const { koeCaptureSource, koeAsrEngine } = await chrome.storage.local.get(["koeCaptureSource", "koeAsrEngine"]);
    nextSource = koeCaptureSource === "mic" ? "mic" : "tab";
    nextEngine = ["local", "webspeech"].includes(koeAsrEngine) ? koeAsrEngine : "dashscope";
  } catch {
    // 读取失败时保持原配置
  }
  if (nextSource === previousSource && nextEngine === previousEngine) return { ok: true, state: publicState(state) };

  const wasActive = state.captureStarted;
  // 先用旧 engine 停旧任务，再写入新 engine；否则 live→local 会漏掉
  // CAPTURE_STOP，local→live 会漏掉 Helper cancel。
  if (wasActive) await stopCapture(state);
  state.source = nextSource;
  state.engine = nextEngine;
  state.sessionMode = nextEngine === "local" ? "offline" : "live";
  state.jobId = `${state.engine === "local" ? "offline" : "live"}-${state.tabId}-${Date.now()}`;
  state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
  state.captureStarted = false;
  resetOfflineBatchState(state);
  state.offlineSourceUrl = "";
  state.offlineContext = undefined;
  state.mediaIdentity = createMediaIdentity();
  mediaCandidatesByTab.delete(state.tabId);
  if (!wasActive) {
    await persistStates();
    return { ok: true, state: publicState(state) };
  }
  state.userStopped = false;
  if (state.engine !== "local" && state.source === "tab" && !captureStreamIds.get(state.tabId)) {
    state.status = "starting";
    state.captureNeedsGesture = true;
    state.stageDetail = "模式已切换 · 打开 Koe 控制器后点开启，重新授权标签页声音";
    await persistStates();
    return { ok: true, state: publicState(state) };
  }
  try {
    if (state.engine === "local") await startOfflineSession(state);
    else await startCapture(state, state.source === "tab" ? captureStreamIds.get(state.tabId) : "");
  } catch (error) {
    state.captureStarted = false;
    state.status = "error";
    state.stageDetail = error instanceof Error ? error.message : String(error);
  }
  await persistStates();
  return { ok: true, state: publicState(state) };
}

async function mediaDiscontinuity(message, sender) {
  const tabId = Number(sender?.tab?.id);
  const state = tabStates.get(tabId);
  if (!state?.captureStarted || state.tabId !== captureTabId) return { ok: true, ignored: true };
  if (Number(sender?.frameId || 0) !== Number(state.frameId || 0)) return { ok: true, ignored: true };
  if (message.jobId && message.jobId !== state.jobId) return { ok: true, ignored: true };
  // 换源后晚到的旧 seek 仍可能携带更大的 discontinuityId。必须先校验
  // 它观察到的媒体代次，否则会把新时间线再次推进并从旧位置启动 Helper。
  if (message.mediaEpoch !== undefined
      && (Number(message.mediaEpoch) || 0) !== (Number(state.mediaEpoch) || 0)) {
    return { ok: true, ignored: true };
  }
  const incomingDiscontinuityId = Number(message.discontinuityId)
    || (Number(state.lastDiscontinuityId) || 0) + 1;
  if (incomingDiscontinuityId <= (Number(state.lastDiscontinuityId) || 0)) {
    return { ok: true, ignored: true };
  }
  state.lastDiscontinuityId = incomingDiscontinuityId;
  if (state.engine === "local" && state.localFallbackActive) {
    await resetLocalLiveSession(state, String(message.reason || "media"), {
      currentTimeMs: Math.max(0, Number(message.currentTime) || 0) * 1_000,
      playbackRate: normalizeLocalPlaybackRate(message.playbackRate, state.localPlaybackRate)
    });
    return { ok: true, mediaEpoch: state.mediaEpoch };
  }
  const previousEpoch = Number(state.mediaEpoch) || 0;
  state.mediaEpoch = previousEpoch + 1;
  if (state.engine === "local") {
    try { postNativeMessage({ type: "cancel", jobId: state.jobId, mediaEpoch: previousEpoch }); } catch { /* disconnected */ }
    resetOfflineBatchState(state);
    // HLS 地址通常带短时签名。拖动进度条后重新向页面取一次当前地址，
    // 避免 Helper 在旧签名上等待超时，也避免旧视频候选重新胜出。
    state.offlineSourceUrl = "";
    mediaCandidatesByTab.delete(tabId);
    state.offlineContext = {
      ...(state.offlineContext || {}),
      currentTimeMs: Math.max(0, Number(message.currentTime) || 0) * 1_000
    };
    await sendToContent(state, {
      type: "OFFLINE_RESET",
      jobId: state.jobId,
      mediaEpoch: state.mediaEpoch,
      reason: String(message.reason || "media")
    });
    await persistStates();
    await requestOfflineMediaContext(state);
    return { ok: true, mediaEpoch: state.mediaEpoch };
  }
  const resetIdentity = sessionIdentity(state);
  const resetTranslate = state.translate;
  await sendToContent(state, {
    type: "LIVE_RESET",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    reason: String(message.reason || "media")
  });
  if (!isCurrentSession(state, resetIdentity, true)) {
    return { ok: true, ignored: true, mediaEpoch: Number(state.mediaEpoch) || 0 };
  }
  const response = await resetCaptureSession(state);
  if (!isCurrentSession(state, resetIdentity, true)) {
    return { ok: true, ignored: true, mediaEpoch: Number(state.mediaEpoch) || 0 };
  }
  await persistStates();
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: resetIdentity.jobId,
    mediaEpoch: resetIdentity.mediaEpoch,
    translate: resetTranslate,
    audioPositionMs: Number(response?.audioPositionMs) || 0
  });
  return { ok: true, mediaEpoch: state.mediaEpoch };
}

async function recordOfflineVisible(message, sender) {
  const tabId = Number(sender?.tab?.id);
  const state = tabStates.get(tabId);
  if (!state?.captureStarted || state.engine !== "local" || state.localFallbackActive) {
    return { ok: true, ignored: true };
  }
  if (Number(sender?.frameId || 0) !== Number(state.frameId || 0)) return { ok: true, ignored: true };
  if (String(message.jobId || "") !== state.jobId) return { ok: true, ignored: true };
  const epoch = Number(message.mediaEpoch) || 0;
  if (epoch !== (Number(state.mediaEpoch) || 0)) return { ok: true, ignored: true };
  const durationMs = Number(state.offlineContext?.durationMs) || 0;
  const cue = normalizeOfflineCue(message.cue, durationMs);
  if (!cue) return { ok: true, ignored: true };
  const currentTimeMs = Math.max(0, Number(message.currentTimeMs) || 0);
  if (currentTimeMs + 250 < cue.startMs || currentTimeMs >= cue.endMs + 250) {
    return { ok: true, ignored: true };
  }
  const seq = Math.max(1, Math.round(cue.startMs) + 1);
  recordTranscript({
    seq,
    text: cue.text,
    translated: cue.translated || undefined,
    jobId: state.jobId,
    mediaEpoch: epoch,
    beginTimeMs: cue.startMs,
    endTimeMs: cue.endMs,
    sentenceId: cue.cueId
  });
  try {
    await chrome.runtime.sendMessage({
      type: "OFFLINE_VISIBLE",
      jobId: state.jobId,
      mediaEpoch: epoch,
      seq,
      lines: [{ text: cue.text, translated: cue.translated || "" }],
      beginTimeMs: cue.startMs,
      endTimeMs: cue.endMs,
      sentenceId: cue.cueId
    });
  } catch {
    // 侧边栏未打开时，字幕仍会保存在 session 记录中。
  }
  return { ok: true };
}

async function ensureOffscreen() {
  if (offscreenCreationPromise) return offscreenCreationPromise;
  const pending = (async () => {
    const url = chrome.runtime.getURL("offscreen.html");
    try {
      const contexts = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).catch(() => []);
      if (contexts?.some((context) => context.documentUrl === url)) return;
    } catch {
      // 环境不支持 getContexts 时直接尝试创建
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "捕获当前标签页正在播放的声音，用于实时字幕与翻译"
    });
  })();
  offscreenCreationPromise = pending;
  try {
    await pending;
  } finally {
    if (offscreenCreationPromise === pending) offscreenCreationPromise = null;
  }
}

function mediaIssueTitle(issueCode, kind = "error") {
  if (kind === "action") return "需要点一下 Koe 继续";
  if (["protected_media", "unsupported_audio", "unsupported_media"].includes(issueCode)) {
    return "这个视频暂不支持直接分析";
  }
  if (["helper_unavailable", "helper_incompatible"].includes(issueCode)) {
    return "本地字幕服务不可用";
  }
  return "Koe 暂时无法分析这个视频";
}

async function publishMediaIssue(state, {
  kind = "error",
  issueCode = "media_unreadable",
  detail = "",
  status,
  captureNeedsGesture
} = {}) {
  if (!state) return;
  state.issueKind = kind;
  state.issueCode = issueCode;
  if (status) state.status = status;
  if (captureNeedsGesture !== undefined) state.captureNeedsGesture = Boolean(captureNeedsGesture);
  if (detail) state.stageDetail = detail;
  // 状态保留给弹窗与侧边栏；页面只收到 clear，用来清掉升级前内容脚本
  // 可能已经挂在视频上的旧提示卡。
  await clearPageMediaStatus(state);
  await persistStates();
}

async function clearPageMediaStatus(state) {
  await sendToContent(state, {
    type: "KOE_MEDIA_STATUS",
    kind: "clear",
    issueCode: "",
    title: "",
    detail: ""
  });
}

async function clearMediaIssue(state, { notify = true } = {}) {
  if (!state) return;
  const hadIssue = Boolean(state.issueKind || state.issueCode);
  state.issueKind = "";
  state.issueCode = "";
  if (!notify || !hadIssue) return;
  await clearPageMediaStatus(state);
}

async function resumeLocalTab(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return;
  const state = tabStates.get(id);
  if (!state?.captureStarted || state.engine !== "local" || state.userStopped) return;
  const active = captureTabId === null ? null : tabStates.get(captureTabId);
  if (active?.captureStarted && active.tabId !== id && active.status !== "error") return;
  if (typeof chrome.tabs.get !== "function") return;
  const tab = await chrome.tabs.get(id).catch(() => null);
  const pageUrl = String(tab?.url || state.pageUrl || "");
  if (!/^https?:/i.test(pageUrl)) return;
  await ensureLiveCaptions({ tabId: id, pageUrl });
}

function cleanupTab(tabId) {
  const state = tabStates.get(tabId);
  if (state?.captureStarted) void stopCapture(state);
  tabStates.delete(tabId);
  if (captureTabId === tabId) captureTabId = null;
  captureStreamIds.delete(tabId);
  captureStartPromises.delete(tabId);
  localFallbackPromises.delete(tabId);
  mediaCandidatesByTab.delete(tabId);
  void persistStates();
  scheduleNativeIdleDisconnect();
}

function actionIndicatorForState(state) {
  const idle = { text: "", color: "", title: "Koe" };
  if (!state) return idle;
  const status = String(state.status || "idle");
  const detail = String(state.stageDetail || "").trim();
  if (status === "idle" || (state.userStopped && !state.captureStarted && status !== "error")) {
    return idle;
  }
  if (status === "error") {
    return {
      text: "!",
      color: "#B3261E",
      title: `Koe · ${detail || "字幕启动失败，点击查看详情"}`
    };
  }
  if (state.captureNeedsGesture) {
    return {
      text: "··",
      color: "#5F6368",
      title: `Koe · ${detail || "点一次 Koe 继续本地字幕"}`
    };
  }
  if (status === "live" && state.captureStarted) {
    return {
      text: "ON",
      color: "#237B4B",
      title: state.engine === "local" ? "Koe · 本地精准字幕运行中" : "Koe · 实时字幕运行中"
    };
  }
  if (state.captureStarted || status === "starting") {
    return {
      text: "··",
      color: "#5F6368",
      title: `Koe · ${detail || "字幕准备中"}`
    };
  }
  return idle;
}

function currentActionState() {
  const active = captureTabId === null ? null : tabStates.get(captureTabId);
  if (active) return active;
  return [...tabStates.values()].sort((left, right) => (
    (Number(right.startedAt) || 0) - (Number(left.startedAt) || 0)
  ))[0] || null;
}

function invokeActionUpdate(updates, method, details) {
  if (typeof method !== "function") return;
  try {
    updates.push(Promise.resolve(method.call(chrome.action, details)));
  } catch {
    // 状态装饰不应影响字幕会话本身。
  }
}

async function syncActionIndicator(indicator = actionIndicatorForState(currentActionState())) {
  const action = chrome.action;
  if (!action) return;
  const updates = [];
  invokeActionUpdate(updates, action.setBadgeText, { text: indicator.text });
  invokeActionUpdate(updates, action.setTitle, { title: indicator.title });
  if (indicator.text) {
    invokeActionUpdate(updates, action.setBadgeBackgroundColor, { color: indicator.color });
    invokeActionUpdate(updates, action.setBadgeTextColor, { color: "#FFFFFF" });
  }
  await Promise.allSettled(updates);
}

function persistStates() {
  // 在进入串行写队列前冻结本次状态，避免紧邻的异步状态变化让徽标跳过中间阶段。
  const indicator = actionIndicatorForState(currentActionState());
  stateWriteChain = stateWriteChain
    .then(async () => {
      await syncActionIndicator(indicator);
      const entries = [...tabStates.entries()].map(([tabId, state]) => ({
        tabId,
        jobId: state.jobId,
        frameId: state.frameId,
        pageUrl: state.pageUrl,
        sourceUrl: normalizeSourceKey(state.sourceUrl || ""),
        translate: state.translate,
        skipSameLanguage: state.skipSameLanguage !== false,
        preferredLanguage: String(state.preferredLanguage || currentPreferredLanguage()),
        source: state.source,
        engine: state.engine,
        sessionMode: state.sessionMode || (state.engine === "local" ? "offline" : "live"),
        mediaEpoch: Number(state.mediaEpoch) || 0,
        captureStarted: Boolean(state.captureStarted),
        captureNeedsGesture: Boolean(state.captureNeedsGesture),
        localFallbackActive: Boolean(state.localFallbackActive),
        status: state.status,
        stageDetail: String(state.stageDetail || ""),
        issueKind: String(state.issueKind || ""),
        issueCode: String(state.issueCode || ""),
        mediaIdentity: String(state.mediaIdentity || ""),
        userStopped: Boolean(state.userStopped),
        startedAt: state.startedAt,
        liveOnly: true
      }));
      await chrome.storage.session.set({ koeTabs: entries });
    })
    .catch(() => {});
  return stateWriteChain;
}

async function restoreStates() {
  const coldRestore = tabStates.size === 0;
  let entries = [];
  try {
    const stored = await chrome.storage.session.get(["koeTabs", "koeTranscript"]);
    entries = stored.koeTabs;
    if (!transcriptHydrated) {
      transcriptCache = Array.isArray(stored.koeTranscript) ? stored.koeTranscript.map((row) => ({ ...row })) : [];
      transcriptHydrated = true;
    }
  } catch {
    return;
  }
  const localResumeCandidates = [];
  const activeCandidates = [];
  const restoredTabIds = new Set();
  for (const entry of entries || []) {
    const tabId = Number(entry.tabId);
    if (!Number.isInteger(tabId) || tabStates.has(tabId)) continue;
    const jobId = String(entry.jobId || "");
    const local = entry.engine === "local" || jobId.startsWith("offline-");
    const live = jobId.startsWith("live-") && entry.liveOnly === true;
    if (!local && !live) continue;
    const wasActive = entry.captureStarted === true;
    const userStopped = Boolean(entry.userStopped);
    const state = {
      tabId,
      frameId: entry.frameId || 0,
      jobId: jobId || `${local ? "offline" : "live"}-${tabId}-${Date.now()}`,
      status: local && wasActive ? "starting" : (wasActive ? "live" : (entry.status || "starting")),
      translate: entry.translate !== false,
      skipSameLanguage: entry.skipSameLanguage !== false,
      preferredLanguage: String(entry.preferredLanguage || currentPreferredLanguage()),
      source: entry.source === "mic" ? "mic" : "tab",
      engine: local ? "local" : (entry.engine === "webspeech" ? "webspeech" : "dashscope"),
      sessionMode: local ? "offline" : "live",
      mediaEpoch: Number(entry.mediaEpoch) || 0,
      sourceUrl: entry.sourceUrl || "",
      pageUrl: entry.pageUrl || "",
      liveOnly: !local,
      captureStarted: wasActive,
      // A worker restart invalidates an in-memory tabCapture stream id. HLS can
      // resume immediately; a non-HLS player will surface one explicit click.
      localFallbackActive: false,
      captureNeedsGesture: wasActive ? false : Boolean(entry.captureNeedsGesture),
      userStopped,
      stageDetail: local && wasActive
        ? "浏览器后台已恢复，正在重新连接本地字幕…"
        : String(entry.stageDetail || (wasActive ? "" : "打开 Koe 控制器后点开启")),
      issueKind: local && wasActive ? "" : String(entry.issueKind || ""),
      issueCode: local && wasActive ? "" : String(entry.issueCode || ""),
      mediaIdentity: String(entry.mediaIdentity || "") || (local ? createMediaIdentity() : ""),
      startedAt: Number(entry.startedAt) || Date.now()
    };
    tabStates.set(tabId, state);
    restoredTabIds.add(tabId);
    if (wasActive && !userStopped) {
      activeCandidates.push(state);
      if (local) localResumeCandidates.push(state);
    }
  }
  const restoredActive = activeCandidates
    .sort((left, right) => (Number(right.startedAt) || 0) - (Number(left.startedAt) || 0))[0];
  if (restoredActive) captureTabId = restoredActive.tabId;

  // Native Port 随旧 service worker 结束，但 USER_MEDIA offscreen 可能仍在
  // 捕获并持有标签页声音。冷恢复时先读取它的权威身份并精确释放；随后用户
  // 先前已开启的 HLS 会话可以续上，非 HLS 页面则明确提示重新授权。
  if (coldRestore) {
    const offscreenStatus = await chrome.runtime.sendMessage({ type: "CAPTURE_STATUS" }).catch(() => null);
    if (offscreenStatus?.active) {
      const owner = tabStates.get(Number(offscreenStatus.tabId));
      const ownerMatches = Boolean(owner?.captureStarted)
        && !owner.userStopped
        && owner.jobId === String(offscreenStatus.jobId || "");
      const restoredLocalOwner = offscreenStatus.engine === "local"
        && restoredTabIds.has(Number(offscreenStatus.tabId));
      const mustRelease = restoredLocalOwner || !ownerMatches;
      if (mustRelease) {
        await chrome.runtime.sendMessage({
          type: "CAPTURE_STOP",
          tabId: Number(offscreenStatus.tabId) || 0,
          jobId: String(offscreenStatus.jobId || ""),
          mediaEpoch: Number(offscreenStatus.mediaEpoch) || 0
        }).catch(() => undefined);
      }
    }
  }
  // 周期恢复只补齐状态；上面的精确清理仅发生在新的 worker 冷启动。
  await syncActionIndicator();
  const activeLocal = localResumeCandidates
    .filter((state) => state.tabId === captureTabId)
    .sort((left, right) => (Number(right.startedAt) || 0) - (Number(left.startedAt) || 0))[0];
  if (activeLocal) await resumeLocalTab(activeLocal.tabId);
}

// ===== 找正在播放的主视频（只用来判断该不该开、有没有切视频） =====
async function listVideos(tabId) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => [...document.querySelectorAll("video")].map((video, index) => {
      const rect = video.getBoundingClientRect();
      const viewportWidth = Math.max(0, Number(window.innerWidth) || 0);
      const viewportHeight = Math.max(0, Number(window.innerHeight) || 0);
      const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      const ancestry = [video, video.parentElement, video.parentElement?.parentElement]
        .map((node) => `${node?.id || ""} ${node?.className || ""}`).join(" ");
      return {
        index,
        pageUrl: location.href,
        hasVideo: true,
        sourceUrl: video.currentSrc || video.src || video.querySelector("source")?.src || "",
        currentTimeMs: Math.max(0, Number(video.currentTime) || 0) * 1_000,
        playbackRate: Math.max(0.25, Math.min(4, Number(video.playbackRate) || 1)),
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1_000) : null,
        width: Math.max(Number(video.videoWidth || 0), Number(rect.width || 0)),
        height: Math.max(Number(video.videoHeight || 0), Number(rect.height || 0)),
        viewportArea: visibleWidth * visibleHeight,
        inViewport: visibleWidth >= 80 && visibleHeight >= 60,
        playing: Boolean(!video.paused && video.readyState >= 2),
        muted: Boolean(video.muted),
        adLike: /(^|[\s_-])(ad|ads|advert|preroll|postroll|pauseroll|gifvideo)([\s_-]|$)/i.test(ancestry)
      };
    })
  });
  const videos = [];
  for (const frame of frames) {
    for (const video of frame.result || []) videos.push({ ...video, frameId: frame.frameId });
  }
  return videos;
}

async function discoverVideoSource(tabId, pageUrl, { allowPaused = false } = {}) {
  const videos = await listVideos(tabId);
  const candidates = videos.filter((video) => !video.adLike && !isAdSource(video.sourceUrl || ""));
  const scored = [...candidates].sort((left, right) => videoScore(right) - videoScore(left));
  const source = scored.find((video) => video.playing) || (allowPaused ? scored[0] : null);
  // listVideos 的页面脚本会带 hasVideo；这里仍统一补成 true，避免调用方
  // 依赖执行脚本的内部字段，也让降级/测试来源保持同一返回契约。
  return source ? { ...source, hasVideo: true, pageUrl: pageUrl || source.pageUrl } : { hasVideo: false };
}

function videoScore(video) {
  if (video.adLike || isAdSource(video.sourceUrl || "")) return -1_000_000_000_000;
  // 大画面、正在播放、未静音的主播放器优先；
  // 小广告和隐藏预览必须明显降权，避免选错 frame。
  let score = Number(video.width || 0) * Number(video.height || 0);
  score += Number(video.viewportArea || 0) * 2;
  if (video.inViewport === false) score -= 800_000_000;
  if (Number(video.width) > 0 && (Number(video.width) < 320 || Number(video.height) < 180)) {
    score -= 500_000_000;
  }
  if (video.playing) score += 100_000_000;
  if (video.muted) score -= 100_000;
  score += Math.min(Number(video.durationMs || 0) / 1_000, 600) * 100;
  return score;
}

async function discoverPageMediaDefinitions(tabId, frameId = 0) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [Number(frameId) || 0] },
    world: "MAIN",
    func: () => {
      const output = [];
      for (const key of Object.keys(window)) {
        if (!/^flashvars_/i.test(key)) continue;
        let definitions;
        try { definitions = window[key]?.mediaDefinitions; } catch { continue; }
        if (!Array.isArray(definitions)) continue;
        for (const item of definitions) {
          const url = String(item?.videoUrl || "");
          let valid = false;
          try {
            const parsed = new URL(url);
            valid = /^https?:$/i.test(parsed.protocol) && /\.m3u8$/i.test(parsed.pathname);
          } catch {
            valid = false;
          }
          if (!valid) continue;
          output.push({ url, quality: Math.max(0, Number(item?.quality) || 0) });
        }
      }
      return output.slice(0, 16);
    }
  });
  return Array.isArray(result?.result) ? result.result : [];
}

function isAdSource(sourceUrl) {
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, "");
    return AD_HOSTS.some((pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`));
  } catch {
    return false;
  }
}

const AD_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
  "outbrain.com", "taboola.com", "adnxs.com", "adsrvr.org", "criteo.com", "amazon-adsystem.com",
  "rubiconproject.com", "appnexus.com", "pubmatic.com", "openx.net", "casalemedia.com",
  "smartadserver.com", "mopub.com", "adcolony.com", "yieldmo.com", "sharethrough.com",
  "districtm.io", "adform.net", "indexww.com", "sovrn.com", "spotx.tv", "instreamatic.com",
  "adroll.com", "quantserve.com", "scorecardresearch.com", "krxd.net", "moatads.com",
  "serving-sys.com", "contextweb.com", "lijit.com", "tribalfusion.com", "media.net",
  "adtech.com", "advertising.com", "z5x.net", "ad-srv.net", "adserver.com", "sinaimg.cn"
];

function normalizeSourceKey(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    // 媒体查询串经常装着短期签名（hdnea/hash/自定义 token 名称）。逐项黑名单
    // 无法保证不漏；source key 只需要稳定地识别资源路径，因此一律不持久化查询串。
    url.search = "";
    return url.toString();
  } catch {
    return String(value || "");
  }
}

function normalizePageKey(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function ensureContentScript(tabId, frameId = 0) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ["media-discovery.js", "content.js"]
  });
}

async function refreshKnownContentScripts() {
  const targets = [...tabStates.values()].map((state) => ({
    tabId: state.tabId,
    frameId: Number(state.frameId) || 0
  }));
  await Promise.allSettled(targets.map(({ tabId, frameId }) => ensureContentScript(tabId, frameId)));
}

function resolveCaptureState(message = {}) {
  const messageTabId = Number(message.tabId);
  const messageJobId = String(message.jobId || "");
  let state = Number.isInteger(messageTabId) ? tabStates.get(messageTabId) : null;
  if (!state && messageJobId) {
    state = [...tabStates.values()].find((candidate) => candidate.jobId === messageJobId) || null;
  }
  if (!state && captureTabId) state = tabStates.get(captureTabId) || null;
  if (!state) return null;
  if (messageJobId && state.jobId !== messageJobId) return null;
  if (message.mediaEpoch !== undefined
      && (Number(message.mediaEpoch) || 0) !== (Number(state.mediaEpoch) || 0)) return null;
  // 停止后的 WebSocket/翻译结果可能迟到。它们绝不能把会话从 idle 复活。
  if (!state.captureStarted) return null;
  state.status = "live";
  state.captureNeedsGesture = false;
  captureTabId = state.tabId;
  return state;
}

async function sendToContent(state, message) {
  if (!state?.tabId) return;
  try {
    await chrome.tabs.sendMessage(state.tabId, message, { frameId: Number(state.frameId) || 0 });
  } catch {
    // 页面已关闭、受限或内容脚本尚未注入时，侧边栏仍可继续工作。
  }
}

function publicState(state) {
  if (!state) return { status: "idle" };
  return {
    status: state.status,
    jobId: state.jobId,
    translate: state.translate,
    skipSameLanguage: state.skipSameLanguage !== false,
    preferredLanguage: String(state.preferredLanguage || currentPreferredLanguage()),
    engine: state.engine,
    sessionMode: state.sessionMode || (state.engine === "local" ? "offline" : "live"),
    captureActive: Boolean(state.captureStarted),
    captureNeedsGesture: Boolean(state.captureNeedsGesture),
    localFallbackActive: Boolean(state.localFallbackActive),
    stageDetail: state.stageDetail,
    issueKind: String(state.issueKind || ""),
    issueCode: String(state.issueCode || ""),
    issueTitle: state.issueKind ? mediaIssueTitle(state.issueCode, state.issueKind) : "",
    nativeTranslation: nativeTranslationAvailable,
    tabId: state.tabId,
    mediaEpoch: Number(state.mediaEpoch) || 0
  };
}
