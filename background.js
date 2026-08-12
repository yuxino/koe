// Koe 实时字幕：只做一件事——捕获当前标签页正在播放的声音，
// 交给本地助手实时识别 + 中文翻译，再显示成字幕。
// 不再下载视频、不再 ffmpeg、不再有“分析中 x%”的进度任务。

const SERVER_URL = "http://127.0.0.1:8787";
const tabStates = new Map();
const captureStreamIds = new Map();
let captureTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => void boot());
chrome.runtime.onInstalled.addListener(() => void boot());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "koe-restore") void restoreStates();
});

// 快捷键 = 一次用户手势：授权后自动捕获当前标签页声音，本页内切视频继续出字幕
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-tab") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await ensureLiveCaptions({ tabId: tab.id, pageUrl: tab.url, forceReset: true });
});

chrome.tabs.onRemoved.addListener((tabId) => cleanupTab(tabId));

async function boot() {
  try {
    await chrome.alarms.create("koe-restore", { periodInMinutes: 0.5 });
  } catch {
    // 个别环境不支持 alarms 时仅保留内存状态
  }
  await restoreStates();
}

async function handle(message, sender) {
  if (!message || typeof message.type !== "string") return { ok: true };
  const tabId = Number(message.tabId ?? sender?.tab?.id);
  if (message.type === "PAGE_READY") return pageReady(sender);
  if (message.type === "VIDEO_CHANGED") return videoChanged(sender);
  if (message.type === "GET_STATE") return { ok: true, state: publicState(tabStates.get(tabId)) };
  if (message.type === "CAPTURE_LINES") return forwardCaptureLines(message, "LIVE_SUBTITLES");
  if (message.type === "CAPTURE_PARTIAL") return forwardCaptureLines(message, "LIVE_PARTIAL");
  if (message.type === "CAPTURE_TRANSLATED") return forwardCaptureLines(message, "LIVE_TRANSLATED");
  if (message.type === "CAPTURE_ERROR") return handleCaptureError(message);
  if (message.type === "START_CAPTURE") return startCaptureForTab(message);
  if (message.type === "STOP_CAPTURE") return stopCaptureForTab(Number(message.tabId));
  if (message.type === "SET_TRANSLATE") return setTranslate(tabId, Boolean(message.translate));
  if (message.type === "CONTENT_ACK") {
    trace(tabId, "content-ack", `${String(message.stage || "")} frame=${sender?.frameId ?? ""}`);
    return { ok: true };
  }
  return { ok: true };
}

async function pageReady(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, skipped: true };
  const pageUrl = String(sender.tab?.url || "");
  if (!/^https?:/i.test(pageUrl)) return { ok: true, skipped: true };
  return ensureLiveCaptions({ tabId, pageUrl });
}

async function videoChanged(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, skipped: true };
  const pageUrl = String(sender.tab?.url || "");
  if (!/^https?:/i.test(pageUrl)) return { ok: true, skipped: true };
  // 页内切视频：让“视频源是否真的变了”来判断要不要重连识别会话，
  // 避免 CDN 换签名、同一视频重载这类情况把字幕打断
  return ensureLiveCaptions({ tabId, pageUrl });
}

// ===== 实时字幕核心：找到正在播放的主视频 → 开启/保持标签页声音捕获 =====
async function ensureLiveCaptions({ tabId, pageUrl = "", translate, forceReset = false }) {
  tabId = Number(tabId);
  if (!Number.isInteger(tabId)) return { ok: true, skipped: true };
  if (translate === undefined) {
    try {
      ({ koeTranslate: translate } = await chrome.storage.local.get("koeTranslate"));
    } catch {
      translate = undefined;
    }
  }
  const source = await discoverVideoSource(tabId, pageUrl).catch(() => null);
  const sourceKey = source?.sourceUrl ? normalizeSourceKey(source.sourceUrl) : "";
  let state = tabStates.get(tabId);

  if (!source?.hasVideo || !isLiveAllowed(source, pageUrl)) {
    // 没有正在播放的主视频，或只是静音/广告/背景视频：不打扰，也不清掉已有会话
    return { ok: true, skipped: true };
  }
  await ensureContentScript(tabId, source.frameId || 0);

  const startedHere = !state || state.liveOnly !== true;
  if (startedHere) {
    if (state?.captureStarted) await stopCapture(state);
    state = {
      tabId,
      frameId: source.frameId || 0,
      status: "starting",
      jobId: `live-${tabId}-${Date.now()}`,
      translate: translate !== undefined ? Boolean(translate) : true,
      sourceUrl: source.sourceUrl || "",
      pageUrl: pageUrl || source.pageUrl,
      liveOnly: true,
      captureStarted: false,
      captureNeedsGesture: false,
      stageDetail: "准备实时字幕…",
      startedAt: Date.now()
    };
    tabStates.set(tabId, state);
    await persistStates();
    await pushState(state);
  } else if (forceReset || (sourceKey && sourceKey !== normalizeSourceKey(state.sourceUrl || ""))) {
    state.frameId = source.frameId || state.frameId;
    state.pageUrl = pageUrl || source.pageUrl;
    state.sourceUrl = source.sourceUrl || "";
    state.translate = translate !== undefined ? Boolean(translate) : state.translate;
    // 换了视频：保持已授权的音频流不断，只重连识别会话
    if (state.captureStarted) await resetCaptureSession(state);
    else await pushState(state);
  }

  state = tabStates.get(tabId);
  if (!state || state.captureStarted) return { ok: true };
  await ensureCaptureAuthorized(state);
  return { ok: true };
}

function isLiveAllowed(source, pageUrl) {
  if (!source?.playing) return false;
  if (isAdSource(source.sourceUrl || "")) return false;
  // 静音播放器没有声音可采，等用户取消静音后再开始
  if (source.muted) return false;
  return true;
}

async function ensureCaptureAuthorized(state) {
  let streamId = captureStreamIds.get(state.tabId) || "";
  if (!streamId) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tabId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/gesture|invocation|permission|user gesture/i.test(message)) {
        state.captureNeedsGesture = true;
        state.stageDetail = "点一下 Koe 图标，立即开始实时字幕";
        await pushState(state);
        return;
      }
      throw error;
    }
  }
  try {
    await startCapture(state, streamId);
  } catch (error) {
    // 流 ID 失效或采集失败：清掉，提示用户再点一次图标重新授权
    captureStreamIds.delete(state.tabId);
    state.captureNeedsGesture = true;
    state.stageDetail = "点一下 Koe 图标，立即开始实时字幕";
    await pushState(state);
  }
}

async function startCapture(state, streamId) {
  // 扩展重载后已打开的页面可能没有内容脚本，先把字幕显示脚本注入进去，
  // 否则识别通道通了、字幕却没地方显示
  await ensureContentScript(state.tabId, state.frameId || 0);
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    type: "CAPTURE_START",
    streamId,
    serverUrl: SERVER_URL,
    translate: state.translate
  });
  if (!response?.ok) throw new Error(response?.error || "无法开始采集标签页声音。");
  state.captureStarted = true;
  state.captureNeedsGesture = false;
  state.status = "live";
  state.stageDetail = "";
  captureTabId = state.tabId;
  await pushState(state);
  await persistStates();
  trace(state.tabId, "capture-started", `${response.mode || "pcm"} frame=${state.frameId || 0} src=${String(state.sourceUrl || "").slice(0, 60)}`);
}

async function resetCaptureSession(state) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_RESET",
      serverUrl: SERVER_URL,
      translate: state.translate
    });
    if (!response?.ok) throw new Error(response?.error || "capture_reset_failed");
  } catch {
    // 离屏页丢失：用现有流 ID 完整重启采集
    const streamId = captureStreamIds.get(state.tabId);
    if (streamId) {
      try {
        await startCapture(state, streamId);
      } catch {
        // 保留旧状态，用户可再点一次图标
      }
    }
  }
}

async function stopCapture(state) {
  if (!state?.captureStarted) return;
  state.captureStarted = false;
  state.status = "starting";
  if (captureTabId === state.tabId) captureTabId = null;
  try {
    await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
  } catch {
    // 后台可能刚唤醒，离屏采集页尚未就绪
  }
  await forwardToTab(state.tabId, { type: "LIVE_STOP", jobId: state.jobId }, state.frameId);
  await pushState(state);
}

async function startCaptureForTab({ tabId, streamId, pageUrl = "" }) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return { ok: false, error: "没有找到当前标签页。" };
  if (streamId) captureStreamIds.set(id, streamId);
  await ensureLiveCaptions({ tabId: id, pageUrl });
  const state = tabStates.get(id);
  if (state?.captureStarted) return { ok: true, state: publicState(state) };
  if (state?.captureNeedsGesture) return { ok: false, error: state.stageDetail || "需要再点击一次以授权声音采集。" };
  if (state?.status === "error") return { ok: false, error: state.stageDetail || "实时字幕已断开。" };
  return { ok: false, error: "当前标签页没有正在播放、未静音的视频。" };
}

async function stopCaptureForTab(tabId) {
  const state = tabStates.get(Number(tabId));
  if (state?.captureStarted) {
    await stopCapture(state);
    state.status = "idle";
    state.stageDetail = "";
    state.captureNeedsGesture = false;
    await pushState(state);
  }
  return { ok: true, state: publicState(tabStates.get(Number(tabId))) };
}

async function forwardCaptureLines(message, type) {
  const tabId = captureTabId;
  const state = tabId ? tabStates.get(tabId) : null;
  if (!state?.captureStarted || !state.jobId) return { ok: true, ignored: true };
  const lines = Array.isArray(message.lines) ? message.lines : [];
  const sent = await forwardToTab(tabId, {
    type,
    jobId: state.jobId,
    lines,
    seq: message.seq
  }, state.frameId);
  if (sent?.ignored && !state.contentScriptPinged) {
    // 页面里还没有字幕脚本（比如扩展重载后没刷新页面）：
    // 现补注入一次，并把状态推过去
    state.contentScriptPinged = true;
    await ensureContentScript(state.tabId, state.frameId || 0);
    trace(state.tabId, "content-inject", `frame=${state.frameId || 0}`);
    await pushState(state);
  }
  trace(tabId, type === "LIVE_SUBTITLES" ? "capture-lines" : "capture-partial", `n=${lines.length} ignored=${Boolean(sent?.ignored)}`);
  return { ok: true };
}

async function handleCaptureError({ error }) {
  const tabId = captureTabId;
  const state = tabId ? tabStates.get(tabId) : null;
  captureTabId = null;
  if (!state) return { ok: true, ignored: true };
  state.captureStarted = false;
  state.status = "error";
  state.captureNeedsGesture = true;
  state.stageDetail = "实时字幕已断开 · 点一下图标或按 Alt+K 重试";
  captureStreamIds.delete(tabId);
  trace(tabId, "capture-error", String(error || ""));
  await forwardToTab(tabId, { type: "LIVE_STOP", jobId: state.jobId }, state.frameId);
  await pushState(state);
  return { ok: true };
}

async function setTranslate(tabId, translate) {
  const state = tabStates.get(tabId);
  if (!state) return { ok: true, ignored: true };
  state.translate = Boolean(translate);
  // 重连识别会话，让之后推送的字幕带/不带翻译
  if (state.captureStarted) await resetCaptureSession(state);
  await pushState(state);
  return { ok: true };
}

async function ensureOffscreen() {
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
}

function cleanupTab(tabId) {
  const state = tabStates.get(tabId);
  if (state?.captureStarted) void stopCapture(state);
  tabStates.delete(tabId);
  if (captureTabId === tabId) captureTabId = null;
  captureStreamIds.delete(tabId);
  void persistStates();
}

async function persistStates() {
  try {
    const entries = [...tabStates.entries()].map(([tabId, state]) => ({
      tabId,
      jobId: state.jobId,
      frameId: state.frameId,
      pageUrl: state.pageUrl,
      sourceUrl: state.sourceUrl,
      translate: state.translate,
      liveOnly: true
    }));
    await chrome.storage.session.set({ koeTabs: entries });
  } catch {
    // 会话存储不可用时仅保留内存状态
  }
}

async function restoreStates() {
  let entries = [];
  try {
    ({ koeTabs: entries } = await chrome.storage.session.get("koeTabs"));
  } catch {
    return;
  }
  for (const entry of entries || []) {
    // 只恢复新版实时字幕状态；旧版残留的下载任务状态直接丢弃
    if (!String(entry.jobId || "").startsWith("live-") || entry.liveOnly !== true) continue;
    if (tabStates.has(entry.tabId)) continue;
    tabStates.set(entry.tabId, {
      tabId: entry.tabId,
      frameId: entry.frameId || 0,
      jobId: entry.jobId || `live-${entry.tabId}-${Date.now()}`,
      status: "starting",
      translate: entry.translate !== false,
      sourceUrl: entry.sourceUrl || "",
      pageUrl: entry.pageUrl || "",
      liveOnly: true,
      captureStarted: false,
      captureNeedsGesture: true,
      stageDetail: "点一下 Koe 图标，立即开始实时字幕",
      startedAt: Date.now()
    });
  }
}

// ===== 找正在播放的主视频（只用来判断该不该开、有没有切视频） =====
async function listVideos(tabId) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => [...document.querySelectorAll("video")].map((video, index) => ({
      index,
      pageUrl: location.href,
      hasVideo: true,
      sourceUrl: video.currentSrc || video.src || video.querySelector("source")?.src || "",
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1_000) : null,
      width: Number(video.videoWidth || 0),
      height: Number(video.videoHeight || 0),
      playing: Boolean(!video.paused && video.readyState >= 2),
      muted: Boolean(video.muted)
    }))
  });
  const videos = [];
  for (const frame of frames) {
    for (const video of frame.result || []) videos.push({ ...video, frameId: frame.frameId });
  }
  return videos;
}

async function discoverVideoSource(tabId, pageUrl) {
  const videos = await listVideos(tabId);
  const candidates = videos.filter((video) => !isAdSource(video.sourceUrl || ""));
  const scored = [...candidates].sort((left, right) => videoScore(right) - videoScore(left));
  const source = scored.find((video) => video.playing) || null;
  return source ? { ...source, pageUrl: pageUrl || source.pageUrl } : { hasVideo: false };
}

function videoScore(video) {
  if (isAdSource(video.sourceUrl || "")) return -1_000_000_000_000;
  // 大画面、正在播放、未静音的主播放器优先；
  // 之前评分太平均，可能选中小广告/隐藏预览，字幕被送到看不见的 frame
  let score = Number(video.width || 0) * Number(video.height || 0);
  if (Number(video.width) > 0 && (Number(video.width) < 320 || Number(video.height) < 180)) {
    score -= 500_000_000;
  }
  if (video.playing) score += 100_000_000;
  if (video.muted) score -= 100_000;
  score += Math.min(Number(video.durationMs || 0) / 1_000, 600) * 100;
  return score;
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
    const volatile = new Set([
      "secure", "token", "signature", "sig", "expires", "expiration", "expiry", "e",
      "key", "auth", "access_token", "x-id", "x-amz-signature", "x-amz-credential",
      "x-amz-date", "x-amz-expires", "x-amz-signedheaders", "x-amz-security-token",
      "awsaccesskeyid", "policy", "credential"
    ]);
    for (const param of [...url.searchParams.keys()]) {
      if (volatile.has(String(param).toLowerCase())) url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return String(value || "");
  }
}

async function ensureContentScript(tabId, frameId = 0) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" }, { frameId });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
  }
}

async function forwardToTab(tabId, message, frameId = 0) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: Number(frameId) || 0 });
  } catch {
    return { ok: false, ignored: true };
  }
}

async function pushState(state) {
  await forwardToTab(state.tabId, {
    type: "LIVE_STATE",
    jobId: state.jobId,
    translate: state.translate,
    status: state.status,
    captureActive: Boolean(state.captureStarted),
    captureNeedsGesture: Boolean(state.captureNeedsGesture),
    stageDetail: state.stageDetail
  }, state.frameId);
}

function publicState(state) {
  if (!state) return { status: "idle" };
  return {
    status: state.status,
    jobId: state.jobId,
    translate: state.translate,
    captureActive: Boolean(state.captureStarted),
    captureNeedsGesture: Boolean(state.captureNeedsGesture),
    stageDetail: state.stageDetail
  };
}

function trace(tabId, event, extra = "") {
  try {
    void fetch(`${SERVER_URL}/api/trace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId, event, extra })
    });
  } catch {
    // 追踪日志失败不影响主流程
  }
}
