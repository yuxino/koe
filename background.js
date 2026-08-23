// Koe 实时字幕：只做一件事——捕获当前标签页正在播放的声音，
// 交给 DashScope 实时识别 + 翻译，再显示成字幕。
// 不下载视频、不需要本地助手、没有“分析中 x%”的进度任务。

const AUTH_RULE_ID = 9001;
const tabStates = new Map();
const captureStreamIds = new Map();
const captureStartPromises = new Map();
let captureTabId = null;
let bootPromise;

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
  if (message.type === "MEDIA_DISCONTINUITY") return mediaDiscontinuity(message, sender);
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
  if (message.type === "STOP_CAPTURE") return stopCaptureForTab(Number(message.tabId));
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
  return ensureLiveCaptions({ tabId, pageUrl });
}

// ===== 实时字幕核心：找到正在播放的主视频 → 开启/保持标签页声音捕获 =====
async function ensureLiveCaptions({ tabId, pageUrl = "", translate, forceReset = false }) {
  tabId = Number(tabId);
  if (!Number.isInteger(tabId)) return { ok: true, skipped: true };
  let captureSource = "tab";
  let captureEngine = "dashscope";
  if (translate === undefined) {
    try {
      ({ koeTranslate: translate, koeCaptureSource: captureSource, koeAsrEngine: captureEngine } = await chrome.storage.local.get(["koeTranslate", "koeCaptureSource", "koeAsrEngine"]));
    } catch {
      translate = undefined;
    }
  }
  const sourceMode = captureSource === "mic" ? "mic" : "tab";
  const engineMode = ["webspeech"].includes(captureEngine) ? captureEngine : "dashscope";

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
    source = await discoverVideoSource(tabId, pageUrl).catch(() => null);
  }
  const sourceKey = source?.sourceUrl ? normalizeSourceKey(source.sourceUrl) : "";
  let state = tabStates.get(tabId);

  if (sourceMode !== "mic" && (!source?.hasVideo || !isLiveAllowed(source))) {
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
      source: sourceMode,
      engine: engineMode,
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
  } else if (forceReset || (sourceKey && sourceKey !== normalizeSourceKey(state.sourceUrl || "")) || state.source !== sourceMode || state.engine !== engineMode) {
    // 只有 forceReset（Alt+K / 右键 / 手动按钮 = 用户明确要开）才清除 userStopped；
    // 视频源变化（广告/CDN 换源等）绝不能重置——用户明确停止后，换视频也不能悄悄重开字幕。
    if (forceReset) state.userStopped = false;
    state.frameId = source.frameId || state.frameId;
    state.pageUrl = pageUrl || source.pageUrl;
    state.sourceUrl = source.sourceUrl || "";
    state.source = sourceMode;
    state.engine = engineMode;
    state.translate = translate !== undefined ? Boolean(translate) : state.translate;
    // 换视频/强制刷新是新的媒体时间线。先提升 epoch 并清掉页面旧字幕，
    // 再重连识别；这样旧 WebSocket 或翻译请求即使晚到，也会被后台拒绝。
    if (state.captureStarted) {
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
    }
  }

  state = tabStates.get(tabId);
  if (!state) return { ok: true };
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
  // 扩展重载后已打开的页面可能没有内容脚本，先补上视频探测脚本。
  await ensureContentScript(state.tabId, state.frameId || 0);
  const { koeApiKey } = await chrome.storage.local.get("koeApiKey");
  const apiKey = String(koeApiKey || "").trim();
  // 内置识别（Chrome 内置）不需要 DashScope Key；其余引擎需要
  const keyless = state.engine === "webspeech";
  if (!keyless && !apiKey) {
    throw new Error("请先在 Koe 中保存 DashScope API Key。");
  }
  await syncAuthorizationRule(apiKey);
  await ensureOffscreen();

  const previous = captureTabId ? tabStates.get(captureTabId) : null;
  if (previous && previous.tabId !== state.tabId && previous.captureStarted) {
    await stopCapture(previous);
    previous.status = "idle";
    previous.stageDetail = "";
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
  transcriptCache = [];
  transcriptHydrated = true;
  await chrome.storage.session.set({ koeTranscript: [] }).catch(() => undefined);
  await persistStates();
  await sendToContent(state, {
    type: "LIVE_SESSION",
    jobId: state.jobId,
    mediaEpoch: state.mediaEpoch,
    translate: state.translate,
    audioPositionMs: 0
  });

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
    if (!response?.ok) throw new Error(response?.error || "无法开始采集标签页声音。");
  } catch (error) {
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
  try {
    await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
  } catch {
    // 后台可能刚唤醒，离屏采集页尚未就绪
  }
  try {
    await chrome.runtime.sendMessage({ type: "LIVE_STOP", jobId: state.jobId });
  } catch {
    // 侧边栏未打开时忽略
  }
  await sendToContent(state, { type: "LIVE_STOP", jobId: state.jobId, mediaEpoch: state.mediaEpoch });
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

function recordTranscript(entry) {
  transcriptWriteChain = transcriptWriteChain
    .then(async () => {
      await hydrateTranscript();
      const seq = Number(entry.seq);
      const epoch = Number(entry.mediaEpoch) || 0;
      const existing = transcriptCache.find((row) => Number(row.seq) === seq && (Number(row.mediaEpoch) || 0) === epoch);
      if (existing) Object.assign(existing, entry);
      else transcriptCache.push({ ...entry, seq, mediaEpoch: epoch });
      while (transcriptCache.length > TRANSCRIPT_LIMIT) transcriptCache.shift();
      await chrome.storage.session.set({ koeTranscript: transcriptCache });
    })
    .catch(() => {});
}

function removeTranscriptRange(fromSeq, toSeq, mediaEpoch = 0) {
  transcriptWriteChain = transcriptWriteChain
    .then(async () => {
      await hydrateTranscript();
      const from = Number(fromSeq) || 0;
      const to = Number(toSeq) || from;
      const epoch = Number(mediaEpoch) || 0;
      transcriptCache = transcriptCache.filter((row) => {
        const seq = Number(row.seq) || 0;
        return (Number(row.mediaEpoch) || 0) !== epoch || seq < from || seq > to;
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
  const { koeCaptureSource } = await chrome.storage.local.get("koeCaptureSource").catch(() => ({}));
  if (koeCaptureSource === "mic") return { ok: true, tabId: tabId || null };
  if (tabId) {
    const source = await discoverVideoSource(tabId).catch(() => null);
    if (source?.playing && source.sourceUrl && !isAdSource(source.sourceUrl)) {
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
  await ensureLiveCaptions({ tabId: id, pageUrl });
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

async function stopCaptureForTab(tabId) {
  const id = Number(tabId);
  const state = tabStates.get(id);
  // 无条件先通知 offscreen 停止（幂等，没在跑也无害）：
  // SW 休眠后 captureTabId 内存丢失、GET_STATE 返回 idle、tabStates 可能无此记录，
  // 若依赖 state 存在才发 CAPTURE_STOP，会出现"点停止但采集还在跑"。
  try {
    await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
  } catch {
    // offscreen 未就绪时忽略
  }
  if (!state) return { ok: true, state: publicState(state) };
  if (state.captureStarted) {
    await stopCapture(state);
    state.status = "idle";
    state.stageDetail = "";
    state.captureNeedsGesture = false;
  } else {
    if (captureTabId === id) captureTabId = null;
    state.status = "idle";
    state.stageDetail = "";
    state.captureNeedsGesture = false;
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
  await removeTranscriptRange(fromSeq, toSeq, message.mediaEpoch);
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
      mediaEpoch: message.mediaEpoch,
      beginTimeMs: message.beginTimeMs,
      endTimeMs: message.endTimeMs,
      sentenceId: message.sentenceId
    });
  } else if (type === "LIVE_TRANSLATED" && !message.streaming) {
    recordTranscript({
      seq: message.seq,
      translated: lines[0]?.translated,
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
  state.translate = Boolean(translate);
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
  try {
    const { koeCaptureSource, koeAsrEngine } = await chrome.storage.local.get(["koeCaptureSource", "koeAsrEngine"]);
    state.source = koeCaptureSource === "mic" ? "mic" : "tab";
    state.engine = ["webspeech"].includes(koeAsrEngine) ? koeAsrEngine : "dashscope";
  } catch {
    // 读取失败时保持原配置
  }
  if (state.source === previousSource && state.engine === previousEngine) return { ok: true, state: publicState(state) };
  if (!state.captureStarted) return { ok: true, state: publicState(state) };

  await stopCapture(state);
  state.jobId = `live-${state.tabId}-${Date.now()}`;
  state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
  state.captureStarted = false;
  state.userStopped = false;
  if (state.source === "tab" && !captureStreamIds.get(state.tabId)) {
    state.status = "starting";
    state.captureNeedsGesture = true;
    state.stageDetail = "模式已切换 · 点击 Koe 图标或按 Alt+K 重新授权标签页声音";
    await persistStates();
    return { ok: true, state: publicState(state) };
  }
  try {
    await startCapture(state, state.source === "tab" ? captureStreamIds.get(state.tabId) : "");
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
  state.mediaEpoch = (Number(state.mediaEpoch) || 0) + 1;
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
      source: state.source,
      engine: state.engine,
      mediaEpoch: Number(state.mediaEpoch) || 0,
      captureStarted: Boolean(state.captureStarted),
      status: state.status,
      userStopped: Boolean(state.userStopped),
      startedAt: state.startedAt,
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
  state.captureStarted = true;
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
    captureActive: Boolean(state.captureStarted),
    captureNeedsGesture: Boolean(state.captureNeedsGesture),
    stageDetail: state.stageDetail,
    tabId: state.tabId
  };
}
