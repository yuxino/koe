// Koe 字幕后台：实时模式捕获标签页声音；本地精准模式只把媒体定位信息
// 通过 Chrome Native Messaging 交给本机 Helper，音视频不离开电脑。

const AUTH_RULE_ID = 9001;
const NATIVE_HOST_NAME = "app.yuxino.koe.helper";
const NATIVE_PROTOCOL_VERSION = 1;
const MEDIA_CANDIDATE_TTL_MS = 60_000;
const OFFLINE_REFILL_LEAD_MS = 45_000;
const tabStates = new Map();
const captureStreamIds = new Map();
const captureStartPromises = new Map();
const mediaCandidatesByTab = new Map();
let captureTabId = null;
let bootPromise;
let nativePort = null;
let nativeTranslationAvailable = false;
let stateWriteChain = Promise.resolve();
let mediaIdentityCounter = 0;

function createMediaIdentity() {
  mediaIdentityCounter += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `media-${Date.now()}-${mediaIdentityCounter}-${Math.random().toString(36).slice(2)}`;
}

function resetOfflineBatchState(state) {
  if (!state) return;
  state.offlineStartedEpoch = undefined;
  state.offlineRunActive = false;
  state.offlinePreparedUntilMs = 0;
  state.offlineCueRevision = 0;
}

installMediaRequestObserver();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => { bootPromise = boot(); });
chrome.runtime.onInstalled.addListener(() => { bootPromise = boot(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "koe-restore") void restoreStates();
});
bootPromise = boot();

// 点击工具栏图标现在打开弹窗（default_popup），弹窗里的按钮点击是
// 本地实测唯一稳定有效的 tabCapture 授权手势；action.onClicked 不再触发，
// 故入口只有：弹窗按钮、Alt+K 快捷键、右键菜单。

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

function isDirectMediaUrl(value) {
  try {
    return /\.(?:m3u8|mp4|m4v|mov|webm)$/i.test(new URL(String(value || "")).pathname);
  } catch {
    return false;
  }
}

function rememberMediaCandidate(tabId, candidate) {
  const id = Number(tabId);
  const url = String(candidate?.url || "");
  if (!Number.isInteger(id) || !isDirectMediaUrl(url) || isAdSource(url)) return;
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
  if (isDirectMediaUrl(direct)) {
    rememberMediaCandidate(id, { url: direct, frameId, seenAt: now, source: "video" });
    // currentSrc 是播放器此刻明确使用的资源，必须压过旧视频留下的 HLS 缓存。
    return { url: direct, frameId, seenAt: now, source: "video" };
  }
  for (const item of Array.isArray(context.resourceUrls) ? context.resourceUrls : []) {
    const url = typeof item === "string" ? item : String(item?.url || "");
    const observedAt = typeof item === "string" ? now : Number(item?.observedAt) || now;
    if (isHlsUrl(url)) rememberMediaCandidate(id, { url, frameId, seenAt: observedAt, source: "performance" });
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
  if (candidate.source === "page-definition") {
    score += 900;
    // 识别只需要音轨，优先最低画质能显著减少本地分片下载量。
    score += Math.max(0, 1_200 - (Number(candidate.quality) || 1_200));
  }
  score += Math.max(-60, Math.min(0, ((Number(candidate.seenAt) || 0) - Date.now()) / 1_000));
  return score;
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
// 正确做法：打开弹窗——弹窗是验证过的手势源，打开后会自动为当前/发声标签页
// 开启字幕并打开侧边栏，一条链路全部走通。
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
  // 弹窗打开后会自动开启字幕；这里不再直接尝试 getMediaStreamId（无手势必失败）
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
  await bootPromise;
  const tabId = Number(message.tabId ?? sender?.tab?.id);
  if (message.type === "PAGE_READY") return pageReady(sender);
  if (message.type === "VIDEO_CHANGED") return videoChanged(sender);
  if (message.type === "MEDIA_CONTEXT") return receiveMediaContext(message, sender);
  if (message.type === "MEDIA_DISCONTINUITY") return mediaDiscontinuity(message, sender);
  if (message.type === "OFFLINE_VISIBLE_REPORT") return recordOfflineVisible(message, sender);
  if (message.type === "GET_STATE") {
    // 不带 tabId 时返回“正在捕获的会话”状态（侧边栏字幕流跟随捕获目标，而不是激活页）
    const state = tabStates.get(tabId) || (message.tabId === undefined ? tabStates.get(captureTabId) : null);
    return { ok: true, state: publicState(state) };
  }
  if (message.type === "CAPTURE_LINES") return forwardCaptureLines(message, "LIVE_SUBTITLES");
  if (message.type === "CAPTURE_PARTIAL") return forwardCaptureLines(message, "LIVE_PARTIAL");
  if (message.type === "CAPTURE_TRANSLATED") return forwardCaptureLines(message, "LIVE_TRANSLATED");
  if (message.type === "CAPTURE_REVOKE") return forwardRevoke(message);
  if (message.type === "CAPTURE_ERROR") return handleCaptureError(message);
  if (message.type === "START_CAPTURE") return startCaptureForTab(message);
  if (message.type === "RECOMMEND_TAB") return recommendCaptureTab(Number(message.tabId));
  if (message.type === "KOE_LOG") return appendLog(message);
  if (message.type === "GET_LOGS") return getLogs();
  if (message.type === "CLEAR_LOGS") return clearLogs();
  if (message.type === "GET_TRANSCRIPT") return getTranscript();
  if (message.type === "STOP_CAPTURE") return stopCaptureForTab({
    tabId: Number(message.tabId),
    jobId: String(message.jobId || "")
  });
  if (message.type === "SET_TRANSLATE") return setTranslate(tabId, Boolean(message.translate));
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

async function videoChanged(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, skipped: true };
  const pageUrl = String(sender.tab?.url || "");
  if (!/^https?:/i.test(pageUrl)) return { ok: true, skipped: true };
  // 页内切视频：让“视频源是否真的变了”来判断要不要重连识别会话，
  // 避免 CDN 换签名、同一视频重载这类情况把字幕打断
  return ensureLiveCaptions({ tabId, pageUrl, mediaChanged: true });
}

// ===== 实时字幕核心：找到正在播放的主视频 → 开启/保持标签页声音捕获 =====
async function ensureLiveCaptions({ tabId, pageUrl = "", translate, forceReset = false, mediaChanged = false }) {
  tabId = Number(tabId);
  if (!Number.isInteger(tabId)) return { ok: true, skipped: true };
  let captureSource = "tab";
  let captureEngine = "dashscope";
  if (translate === undefined) {
    try {
      ({ koeTranslate: translate, koeCaptureSource: captureSource, koeAsrEngine: captureEngine } = await chrome.storage.local.get([
        "koeTranslate", "koeCaptureSource", "koeAsrEngine"
      ]));
    } catch {
      translate = undefined;
    }
  }
  const sourceMode = captureSource === "mic" ? "mic" : "tab";
  const engineMode = ["local", "webspeech"].includes(captureEngine) ? captureEngine : "dashscope";
  const sessionMode = engineMode === "local" ? "offline" : "live";
  if (engineMode === "local" && !nativeTranslationAvailable) translate = false;

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
  let state = tabStates.get(tabId);

  // PAGE_READY 会来自所有打开的视频页。本地模式读取媒体并运行大模型，
  // 必须只在用户明确点启动后建立新会话，不能因为任意网页播放就自动分析。
  if (engineMode === "local" && !state && !forceReset) {
    return { ok: true, skipped: true };
  }

  // “停止/报错 → 用户明确再开”必须得到新的会话身份。若沿用旧 job/epoch，
  // 停止前已经排队的 Helper/WebSocket 消息会在新会话激活后重新通过校验。
  if (forceReset && state && !state.captureStarted) {
    state.jobId = `${sessionMode}-${tabId}-${Date.now()}`;
    state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
    state.lastDiscontinuityId = 0;
    state.offlineStartedEpoch = undefined;
    state.offlineSourceUrl = "";
    state.offlineContext = undefined;
    mediaCandidatesByTab.delete(tabId);
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
  } else if (forceReset || mediaChanged || (sourceKey && sourceKey !== normalizeSourceKey(state.sourceUrl || "")) || state.source !== sourceMode || state.engine !== engineMode) {
    const previousSourceKey = normalizeSourceKey(state.sourceUrl || "");
    const mediaIdentityChanged = mediaChanged
      || Boolean(sourceKey && sourceKey !== previousSourceKey)
      || state.engine !== engineMode;
    // 只有 forceReset（Alt+K / 右键 / 手动按钮 = 用户明确要开）才清除 userStopped；
    // 视频源变化（广告/CDN 换源等）绝不能重置——用户明确停止后，换视频也不能悄悄重开字幕。
    if (forceReset) state.userStopped = false;
    state.frameId = source.frameId || state.frameId;
    state.pageUrl = pageUrl || source.pageUrl;
    state.sourceUrl = source.sourceUrl || "";
    state.source = sourceMode;
    state.engine = engineMode;
    state.sessionMode = sessionMode;
    state.translate = translate !== undefined ? Boolean(translate) : state.translate;
    if (sessionMode === "offline" && mediaIdentityChanged) {
      // 只传给 Helper 一个不含 URL 的媒体代号：换视频重新检测语言，seek 保留。
      state.mediaIdentity = createMediaIdentity();
    }
    // 换视频/强制刷新是新的媒体时间线。先提升 epoch 并清掉页面旧字幕，
    // 再重连识别；这样旧 WebSocket 或翻译请求即使晚到，也会被后台拒绝。
    if (state.captureStarted && sessionMode === "live") {
      state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
      await sendToContent(state, {
        type: "LIVE_RESET",
        jobId: state.jobId,
        mediaEpoch: state.mediaEpoch,
        reason: forceReset ? "manual" : "source"
      });
      const response = await resetCaptureSession(state);
      await sendToContent(state, {
        type: "LIVE_SESSION",
        jobId: state.jobId,
        mediaEpoch: state.mediaEpoch,
        translate: state.translate,
        audioPositionMs: Number(response?.audioPositionMs) || 0
      });
      await persistStates();
    } else if (state.captureStarted && sessionMode === "offline") {
      const previousEpoch = Number(state.mediaEpoch) || 0;
      try {
        postNativeMessage({ type: "cancel", jobId: state.jobId, mediaEpoch: previousEpoch });
      } catch {
        // Helper 缺失/断开时仍要完成页面时间线切换。
      }
      state.mediaEpoch = previousEpoch + 1;
      state.offlineStartedEpoch = undefined;
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

  state = tabStates.get(tabId);
  if (!state) return { ok: true };
  if (state.engine === "local") {
    if (!state.captureStarted) {
      await startOfflineSession(state);
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

async function startOfflineSession(state) {
  // 本地模式和实时模式一样尊重用户的明确停止。只有 START_CAPTURE
  // 会先清除此标记；页面自己的 PAGE_READY/播放事件不得偷偷重启。
  if (!state || state.userStopped) return;
  try {
    connectNativeHelper();
  } catch (error) {
    state.captureStarted = false;
    state.status = "error";
    state.stageDetail = error instanceof Error ? error.message : String(error);
    await persistStates();
    return;
  }
  const previous = captureTabId ? tabStates.get(captureTabId) : null;
  if (previous && previous.tabId !== state.tabId && previous.captureStarted) {
    await stopCapture(previous);
    // 单会话切到新标签页后，旧页仍会周期发送 PAGE_READY。把它标成
    // 已交接，直到用户再次明确点击旧页，避免两个标签页互相抢占。
    previous.userStopped = true;
    previous.status = "idle";
    previous.stageDetail = "字幕已切换到另一个标签页";
    previous.captureNeedsGesture = false;
  }
  state.captureStarted = true;
  state.captureNeedsGesture = false;
  state.status = "starting";
  state.stageDetail = "正在定位视频媒体…";
  state.offlineStartedEpoch = undefined;
  captureTabId = state.tabId;
  const startIdentity = sessionIdentity(state);
  await clearTranscript();
  if (!isCurrentSession(state, startIdentity, true)) return;
  await persistStates();
  if (!isCurrentSession(state, startIdentity, true)) return;
  await sendToContent(state, {
    type: "OFFLINE_SESSION",
    jobId: state.jobId,
    mediaEpoch: Number(state.mediaEpoch) || 0,
    translate: state.translate,
    discontinuityId: Number(state.lastDiscontinuityId) || 0
  });
  if (!isCurrentSession(state, startIdentity, true)) {
    await sendToContent(state, {
      type: "OFFLINE_STOP",
      jobId: startIdentity.jobId,
      mediaEpoch: startIdentity.mediaEpoch
    });
    return;
  }
  postNativeMessage({ type: "hello", protocolVersion: NATIVE_PROTOCOL_VERSION });
  await requestOfflineMediaContext(state);
}

function sessionIdentity(state) {
  return {
    tabId: Number(state?.tabId),
    jobId: String(state?.jobId || ""),
    mediaEpoch: Number(state?.mediaEpoch) || 0
  };
}

function isCurrentSession(state, identity, requireActive = false) {
  if (!state || !identity || tabStates.get(identity.tabId) !== state || state.userStopped) return false;
  if (state.jobId !== identity.jobId || (Number(state.mediaEpoch) || 0) !== identity.mediaEpoch) return false;
  return !requireActive || (state.captureStarted && captureTabId === identity.tabId);
}

async function requestOfflineMediaContext(state) {
  if (!state?.captureStarted || state.engine !== "local") return;
  await sendToContent(state, {
    type: "OFFLINE_DISCOVER",
    jobId: state.jobId,
    mediaEpoch: Number(state.mediaEpoch) || 0
  });
}

async function receiveMediaContext(message, sender) {
  const tabId = Number(sender?.tab?.id);
  const state = tabStates.get(tabId);
  if (!state?.captureStarted || state.engine !== "local") return { ok: true, ignored: true };
  if (String(message.jobId || "") !== state.jobId) return { ok: true, ignored: true };
  if ((Number(message.mediaEpoch) || 0) !== (Number(state.mediaEpoch) || 0)) return { ok: true, ignored: true };
  const frameId = Number(sender?.frameId) || 0;
  if (frameId !== Number(state.frameId || 0)) return { ok: true, ignored: true };
  const identity = sessionIdentity(state);
  const context = {
    frameId,
    currentSrc: String(message.currentSrc || ""),
    resourceUrls: Array.isArray(message.resourceUrls)
      ? message.resourceUrls.slice(-24).map((item) => typeof item === "string"
        ? item
        : { url: String(item?.url || ""), observedAt: Number(item?.observedAt) || Date.now() })
      : [],
    currentTimeMs: Math.max(0, Number(message.currentTimeMs) || 0),
    durationMs: Math.max(0, Number(message.durationMs) || 0),
    playbackRate: Math.max(0.25, Math.min(4, Number(message.playbackRate) || 1))
  };
  const pageDefinitions = await discoverPageMediaDefinitions(tabId, frameId).catch(() => []);
  // executeScript 期间可能发生 seek / 换源 / 停止。旧页面返回的签名地址和
  // 时间点绝不能覆盖新 epoch，也不能把已停止的会话重新启动。
  if (!isCurrentSession(state, identity, true) || state.engine !== "local") {
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
    state.status = "starting";
    state.stageDetail = "暂未找到视频媒体，播放几秒后会自动重试…";
    await persistStates();
    return { ok: true, pending: true };
  }
  state.offlineSourceUrl = candidate.url;
  state.offlineContext = context;
  await beginOfflineEpoch(state);
  maybeExtendOfflinePrep(state);
  return { ok: true };
}

// 本地精准只在启动时预置[当前位置, +120s]一批。播放推进到接近该批边界时，
// 重跑一次 beginOfflineEpoch 续下一批（复用同一 job/epoch，网页按 cueId 合并去重，
// Helper 会先取消旧任务再重新预处理）。避免“播放一阵子就没字幕”。
function maybeExtendOfflinePrep(state) {
  if (!state?.captureStarted || state.engine !== "local") return;
  const epoch = Number(state.mediaEpoch) || 0;
  if (state.offlineStartedEpoch !== epoch) return;              // 本批尚未启动
  const currentMs = Number(state.offlineContext?.currentTimeMs) || 0;
  const preparedUntilMs = Number(state.preparedUntilMs) || 0;
  const durationMs = Number(state.offlineContext?.durationMs) || 0;
  if (preparedUntilMs <= currentMs) return;                     // 没有预置边界
  if (currentMs < preparedUntilMs - 60_000) return;             // 距边界还远，不急着续
  if (durationMs > 0 && currentMs >= durationMs - 1_000) return; // 已到片尾
  state.offlineStartedEpoch = undefined;                        // 允许重跑本批
  void beginOfflineEpoch(state);
}

async function beginOfflineEpoch(state) {
  const epoch = Number(state.mediaEpoch) || 0;
  if (!state?.captureStarted || state.engine !== "local" || state.offlineStartedEpoch === epoch) return;
  const identity = sessionIdentity(state);
  if (!state.mediaIdentity) state.mediaIdentity = createMediaIdentity();
  const sourceUrl = String(state.offlineSourceUrl || "");
  if (!isDirectMediaUrl(sourceUrl)) return;
  const context = state.offlineContext || {};
  const pageUrl = String(state.pageUrl || "");
  let origin = "";
  try { origin = new URL(pageUrl).origin; } catch { /* optional */ }
  state.offlineStartedEpoch = epoch;
  state.status = "starting";
  state.stageDetail = "本地 Helper 正在准备当前位置…";
  await persistStates();
  if (!isCurrentSession(state, identity, true)
      || state.engine !== "local"
      || state.offlineStartedEpoch !== epoch
      || state.offlineSourceUrl !== sourceUrl) return;
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
    translate: Boolean(state.translate)
  });
}

function connectNativeHelper() {
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
      state.captureStarted = false;
      state.status = "error";
      state.userStopped = true;
      state.offlineStartedEpoch = undefined;
      state.offlineSourceUrl = "";
      state.offlineContext = undefined;
      state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
      mediaCandidatesByTab.delete(state.tabId);
      state.stageDetail = /native messaging host|not found/i.test(detail)
        ? `未安装本地 Koe Helper：${String(detail)}`
        : `本地 Koe Helper 已断开：${String(detail)}`;
      void sendToContent(state, { type: "OFFLINE_STOP", jobId: state.jobId, mediaEpoch: state.mediaEpoch });
    }
    void persistStates();
  });
  return port;
}

function postNativeMessage(message) {
  const port = connectNativeHelper();
  port.postMessage(message);
}

async function handleNativeMessage(message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "ready") {
    // Helper 通过 hello 握手上报本地翻译能力（macOS 26+ 且支持简体中文目标）。
    nativeTranslationAvailable = Boolean(message.nativeTranslation);
    void appendLog({ event: "native-ready", detail: `nativeTranslation=${nativeTranslationAvailable}` });
    return;
  }
  const state = [...tabStates.values()].find((candidate) => candidate.jobId === String(message.jobId || ""));
  if (!state?.captureStarted || state.engine !== "local") return;
  if ((Number(message.mediaEpoch) || 0) !== (Number(state.mediaEpoch) || 0)) return;
  if (message.type === "status") {
    // forward 只是在后台预取后续窗口；首批 cue 此时已经可播放，UI 不应
    // 再退回“准备中”。
    state.status = ["forward", "ready"].includes(message.stage) ? "live" : "starting";
    state.stageDetail = String(message.detail || "本地精准字幕处理中…");
    // Helper 报告本批字幕预置到哪个媒体时刻；播放逼近该边界时用它续批。
    state.preparedUntilMs = Number(message.preparedUntilMs) || 0;
    await persistStates();
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
    await sendToContent(state, {
      type: "OFFLINE_CUES",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      revision: Number(message.revision) || 0,
      cues
    });
    await persistStates();
    return;
  }
  if (message.type === "error") {
    state.captureStarted = false;
    state.status = "error";
    state.userStopped = true;
    state.offlineStartedEpoch = undefined;
    state.offlineSourceUrl = "";
    state.offlineContext = undefined;
    state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
    mediaCandidatesByTab.delete(state.tabId);
    state.stageDetail = String(message.error || "本地字幕处理失败");
    if (captureTabId === state.tabId) captureTabId = null;
    await sendToContent(state, {
      type: "OFFLINE_ERROR",
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      error: state.stageDetail
    });
    await persistStates();
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
        state.stageDetail = "点击 Koe 图标（弹窗一键开启）或按 Alt+K";
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
  }
}
async function startCapture(state, streamId) {
  const startIdentity = sessionIdentity(state);
  // 扩展重载后已打开的页面可能没有内容脚本，先补上视频探测脚本。
  await ensureContentScript(state.tabId, state.frameId || 0);
  if (!isCurrentSession(state, startIdentity)) return;
  const { koeApiKey } = await chrome.storage.local.get("koeApiKey");
  if (!isCurrentSession(state, startIdentity)) return;
  const apiKey = String(koeApiKey || "").trim();
  // 内置识别（Chrome 内置）不需要 DashScope Key；其余引擎需要
  const keyless = state.engine === "webspeech";
  if (!keyless && !apiKey) {
    throw new Error("请先在 Koe 中保存 DashScope API Key。");
  }
  await syncAuthorizationRule(apiKey);
  if (!isCurrentSession(state, startIdentity)) return;
  await ensureOffscreen();
  if (!isCurrentSession(state, startIdentity)) return;

  const previous = captureTabId ? tabStates.get(captureTabId) : null;
  if (previous && previous.tabId !== state.tabId && previous.captureStarted) {
    await stopCapture(previous);
    previous.userStopped = true;
    previous.status = "idle";
    previous.stageDetail = "字幕已切换到另一个标签页";
    previous.captureNeedsGesture = false;
  }

  // 在启动 offscreen 前建立路由。连接建立期间积压的首批音频可能很快返回，
  // 不能等 CAPTURE_START 响应后才设置 captureTabId，否则开头字幕会被丢弃。
  state.captureStarted = true;
  state.captureNeedsGesture = false;
  state.status = "starting";
  state.stageDetail = "正在连接 DashScope…";
  state.mediaEpoch = Number(state.mediaEpoch) || 0;
  captureTabId = state.tabId;
  await clearTranscript();
  if (!isCurrentSession(state, startIdentity, true)) return;
  await persistStates();
  if (!isCurrentSession(state, startIdentity, true)) return;
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    translate: state.translate,
    audioPositionMs: 0
  });
  if (!isCurrentSession(state, startIdentity, true)) {
    await sendToContent(state, { type: "LIVE_STOP", jobId: startIdentity.jobId, mediaEpoch: startIdentity.mediaEpoch });
    return;
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "CAPTURE_START",
      streamId: streamId || "",
      apiKey,
      translate: state.translate,
      source: state.source || "tab",
      engine: state.engine || "dashscope",
      tabId: state.tabId,
      jobId: state.jobId,
      mediaEpoch: state.mediaEpoch
    });
    if (!isCurrentSession(state, startIdentity, true)) {
      try { await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" }); } catch { /* 已停止 */ }
      return;
    }
    if (!response?.ok) throw new Error(response?.error || "无法开始采集标签页声音。");
  } catch (error) {
    if (!isCurrentSession(state, startIdentity, true)) return;
    state.captureStarted = false;
    state.status = "error";
    state.stageDetail = error instanceof Error ? error.message : String(error);
    if (captureTabId === state.tabId) captureTabId = null;
    await persistStates();
    throw error;
  }

  state.status = "live";
  state.stageDetail = "";
  // 只启用该标签页的侧边栏入口，不主动打开；页面字幕是主显示，
  // 记录与设置面板仅在用户明确需要时占用屏幕。
  try {
    await chrome.sidePanel.setOptions({ tabId: state.tabId, path: "sidepanel.html", enabled: true });
  } catch {
    // 无手势或版本不支持时忽略
  }
  await persistStates();
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    translate: state.translate,
    audioPositionMs: Number(response.audioPositionMs) || 0
  });
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
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_RESET",
      translate: state.translate,
      source: state.source,
      engine: state.engine,
      tabId: state.tabId,
      jobId: state.jobId,
      mediaEpoch: Number(state.mediaEpoch) || 0
    });
    if (!response?.ok) throw new Error(response?.error || "capture_reset_failed");
    return response;
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
  return null;
}

async function stopCapture(state) {
  if (!state?.captureStarted) return;
  state.captureStarted = false;
  state.status = "starting";
  if (captureTabId === state.tabId) captureTabId = null;
  if (state.engine === "local") {
    try {
      postNativeMessage({ type: "cancel", jobId: state.jobId, mediaEpoch: Number(state.mediaEpoch) || 0 });
    } catch {
      // Helper 已断开时任务自然终止。
    }
    state.offlineStartedEpoch = undefined;
    state.offlineSourceUrl = "";
    state.offlineContext = undefined;
    state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
    mediaCandidatesByTab.delete(state.tabId);
  } else {
    try {
      await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
    } catch {
      // 后台可能刚唤醒，离屏采集页尚未就绪
    }
  }
  try {
    await chrome.runtime.sendMessage({ type: "LIVE_STOP", jobId: state.jobId });
  } catch {
    // 侧边栏未打开时忽略
  }
  await sendToContent(state, {
    type: state.engine === "local" ? "OFFLINE_STOP" : "LIVE_STOP",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch
  });
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
      preState.stageDetail = "正在连接 DashScope…";
    }
  }
  await ensureLiveCaptions({ tabId: id, pageUrl, forceReset: true });
  const state = tabStates.get(id);
  if (state?.captureStarted) return { ok: true, state: publicState(state) };
  if (state?.captureNeedsGesture) return { ok: false, error: state.stageDetail || "需要再点击一次以授权声音采集。" };
  if (state?.status === "error") return { ok: false, error: state.stageDetail || "实时字幕已断开。" };
  // 其他标签页正在发声时给出“跟随”提示：按 Alt+K 即可把捕获目标切过去
  const audibleElsewhere = await chrome.tabs.query({ audible: true })
    .then((tabs) => tabs.some((tab) => tab.id !== id))
    .catch(() => false);
  if (audibleElsewhere) {
    return { ok: false, error: "当前页面没有正在播放的视频；检测到其他标签页有声音，按 Alt+K 跟随它。" };
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
  const state = active?.tabId === id ? active : tabStates.get(id);
  if (!state) {
    // 仅在后台确实没有任何已知会话时做恢复性全局停止。
    try { await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" }); } catch { /* offscreen 未就绪 */ }
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
    try { await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" }); } catch { /* offscreen 未就绪 */ }
    if (captureTabId === id) captureTabId = null;
    state.status = "idle";
    state.stageDetail = "";
    state.captureNeedsGesture = false;
  }
  if (state.engine === "local") {
    state.offlineStartedEpoch = undefined;
    state.offlineSourceUrl = "";
    state.offlineContext = undefined;
    state.sourceUrl = normalizeSourceKey(state.sourceUrl || "");
    mediaCandidatesByTab.delete(id);
  }
  // 主动停止 = 彻底释放：清掉缓存的音频流 id（流已释放，旧 id 不应残留）
  captureStreamIds.delete(id);
  // 主动停止 = 不再打扰：本页不再弹“点击开启”，直到切换视频或手动再开
  state.userStopped = true;
  await persistStates();
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
  const tabId = state.tabId;
  if (captureTabId === tabId) captureTabId = null;
  state.captureStarted = false;
  state.status = "error";
  state.captureNeedsGesture = true;
  state.stageDetail = "实时字幕已断开 · 点击 Koe 图标或按 Alt+K 重试";
  captureStreamIds.delete(tabId);
  try {
    await chrome.runtime.sendMessage({ type: "LIVE_STOP", jobId: state.jobId });
  } catch {
    // 侧边栏未打开时忽略
  }
  await sendToContent(state, { type: "LIVE_STOP", jobId: state.jobId, mediaEpoch: state.mediaEpoch });
  await persistStates();
  return { ok: true };
}

async function setTranslate(tabId, translate) {
  const state = tabStates.get(tabId);
  if (!state) return { ok: true, ignored: true };
  const allowed = state.engine === "local"
    ? (nativeTranslationAvailable && Boolean(translate))
    : Boolean(translate);
  state.translate = allowed;
  if (state.captureStarted && state.engine === "local") {
    // Helper 只在 start 时读取 translate。切换翻译时重跑一次 offline epoch，
    // 让 Helper 用新的开关重新开始，并作废旧任务的排队结果。
    state.offlineStartedEpoch = undefined;
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
    await sendToContent(state, {
      type: "LIVE_RESET",
      jobId: state.jobId,
      mediaEpoch: state.mediaEpoch,
      reason: "translate"
    });
    const response = await resetCaptureSession(state);
    await sendToContent(state, {
      type: "LIVE_SESSION",
      jobId: state.jobId,
      mediaEpoch: state.mediaEpoch,
      translate: state.translate,
      audioPositionMs: Number(response?.audioPositionMs) || 0
    });
  }
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
  state.offlineStartedEpoch = undefined;
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
    state.stageDetail = "模式已切换 · 点击 Koe 图标或按 Alt+K 重新授权标签页声音";
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
  const previousEpoch = Number(state.mediaEpoch) || 0;
  state.mediaEpoch = previousEpoch + 1;
  if (state.engine === "local") {
    try { postNativeMessage({ type: "cancel", jobId: state.jobId, mediaEpoch: previousEpoch }); } catch { /* disconnected */ }
    state.offlineStartedEpoch = undefined;
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
  await sendToContent(state, {
    type: "LIVE_RESET",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    reason: String(message.reason || "media")
  });
  const response = await resetCaptureSession(state);
  await persistStates();
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    translate: state.translate,
    audioPositionMs: Number(response?.audioPositionMs) || 0
  });
  return { ok: true, mediaEpoch: state.mediaEpoch };
}

async function recordOfflineVisible(message, sender) {
  const tabId = Number(sender?.tab?.id);
  const state = tabStates.get(tabId);
  if (!state?.captureStarted || state.engine !== "local") return { ok: true, ignored: true };
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
  captureStartPromises.delete(tabId);
  mediaCandidatesByTab.delete(tabId);
  void persistStates();
}

function persistStates() {
  stateWriteChain = stateWriteChain
    .then(async () => {
      const entries = [...tabStates.entries()].map(([tabId, state]) => ({
        tabId,
        jobId: state.jobId,
        frameId: state.frameId,
        pageUrl: state.pageUrl,
        sourceUrl: normalizeSourceKey(state.sourceUrl || ""),
        translate: state.translate,
        source: state.source,
        engine: state.engine,
        sessionMode: state.sessionMode || (state.engine === "local" ? "offline" : "live"),
        mediaEpoch: Number(state.mediaEpoch) || 0,
        captureStarted: Boolean(state.captureStarted),
        status: state.status,
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
  for (const entry of entries || []) {
    // 只恢复有效的实时字幕状态。
    if (!String(entry.jobId || "").startsWith("live-") || entry.liveOnly !== true) continue;
    if (tabStates.has(entry.tabId)) continue;
    tabStates.set(entry.tabId, {
      tabId: entry.tabId,
      frameId: entry.frameId || 0,
      jobId: entry.jobId || `live-${entry.tabId}-${Date.now()}`,
      status: entry.captureStarted === true ? "live" : (entry.status || "starting"),
      translate: entry.translate !== false,
      source: entry.source === "mic" ? "mic" : "tab",
      engine: entry.engine === "webspeech" ? "webspeech" : "dashscope",
      mediaEpoch: Number(entry.mediaEpoch) || 0,
      sourceUrl: entry.sourceUrl || "",
      pageUrl: entry.pageUrl || "",
      liveOnly: true,
      captureStarted: entry.captureStarted === true,
      captureNeedsGesture: entry.captureStarted !== true,
      userStopped: Boolean(entry.userStopped),
      stageDetail: entry.captureStarted === true ? "" : "点击 Koe 图标（弹窗一键开启）或按 Alt+K",
      startedAt: Number(entry.startedAt) || Date.now()
    });
    if (entry.captureStarted === true) captureTabId = entry.tabId;
  }
  // 定时恢复只重建状态；停止采集只能由明确的 STOP_CAPTURE 触发。
}

// ===== 找正在播放的主视频（只用来判断该不该开、有没有切视频） =====
async function listVideos(tabId) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => [...document.querySelectorAll("video")].map((video, index) => {
      const rect = video.getBoundingClientRect();
      const ancestry = [video, video.parentElement, video.parentElement?.parentElement]
        .map((node) => `${node?.id || ""} ${node?.className || ""}`).join(" ");
      return {
        index,
        pageUrl: location.href,
        hasVideo: true,
        sourceUrl: video.currentSrc || video.src || video.querySelector("source")?.src || "",
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1_000) : null,
        width: Math.max(Number(video.videoWidth || 0), Number(rect.width || 0)),
        height: Math.max(Number(video.videoHeight || 0), Number(rect.height || 0)),
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
            valid = /^https?:$/i.test(parsed.protocol) && /\.(?:m3u8|mp4|m4v|mov|webm)$/i.test(parsed.pathname);
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

async function ensureContentScript(tabId, frameId = 0) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
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
    engine: state.engine,
    sessionMode: state.sessionMode || (state.engine === "local" ? "offline" : "live"),
    captureActive: Boolean(state.captureStarted),
    captureNeedsGesture: Boolean(state.captureNeedsGesture),
    stageDetail: state.stageDetail,
    nativeTranslation: nativeTranslationAvailable,
    tabId: state.tabId
  };
}
