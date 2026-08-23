// Koe 侧边栏：控制 + 滚动字幕流。
// 参考 Mimi 的字幕模型：已确认的短句一行行累积成历史（可回看），
// 正在识别的草稿作为最后一行实时刷新——字幕只增不减，不再被新内容冲掉。
// UI 精简版：状态卡已移除，状态用圆点 + 按钮 + 底部提示表达；复杂设置收起为单一下拉。

let activeTab;
let currentState = { status: "idle" };
let hasApiKey = false;
let translatePreference = true;
let hideOriginalPreference = false;
let activeJobId = "";
let activeMediaEpoch = 0;
let captureEnded = false;
let lastUnitSeq = 0;
let lastDraftSeq = 0;
let draftEl = null;
// 草稿行当前形态："raw"（原文草稿，弱化显示）| "translated"（译文草稿）
let draftKind = "";
let draftTranslatedAt = 0;
// 翻译偏好自动同步节流：会话与开关不一致时最多 10 秒补发一次 SET_TRANSLATE
let lastTranslateSyncAt = 0;
let lastStatusHint = "";
const pendingOriginalUnits = new Map();
const MAX_ROWS = 120;

// 字幕模式：只保留本地精准（可本地翻译）与 DashScope 两种，去掉麦克风/Chrome 内置。
const CAPTURE_MODES = {
  "tab-local": { source: "tab", engine: "local" },
  "tab-dashscope": { source: "tab", engine: "dashscope" }
};

const AUTH_RULE_ID = 9001;
const elements = {
  version: document.querySelector("#version"),
  statusDot: document.querySelector("#status-dot"),
  startButton: document.querySelector("#start-button"),
  translateLabel: document.querySelector("#translate-label"),
  translateToggle: document.querySelector("#translate-toggle"),
  hideOriginalToggle: document.querySelector("#hide-original-toggle"),
  dashscopeOnly: document.querySelector("#dashscope-only"),
  captureMode: document.querySelector("#capture-mode"),
  overlayEnabled: document.querySelector("#overlay-enabled"),
  overlaySize: document.querySelector("#overlay-size"),
  apiKey: document.querySelector("#api-key"),
  saveKey: document.querySelector("#save-key"),
  hint: document.querySelector("#hint"),
  settings: document.querySelector("#settings"),
  settingsSummary: document.querySelector("#settings-summary"),
  feed: document.querySelector("#feed"),
  copyAll: document.querySelector("#copy-all"),
  clearFeed: document.querySelector("#clear-feed"),
  copyLogs: document.querySelector("#copy-logs"),
  clearLogs: document.querySelector("#clear-logs"),
  scrollBottom: document.querySelector("#scroll-bottom")
};

// 兜底：任何未捕获的脚本/异步错误都显示在底部提示里，杜绝“点了没反应”
window.addEventListener("error", (event) => {
  if (elements.hint) elements.hint.textContent = `脚本错误：${event.message || "未知"}`;
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (elements.hint) elements.hint.textContent = `异步错误：${reason}`;
});

document.addEventListener("DOMContentLoaded", init);
elements.startButton.addEventListener("click", () => {
  if (currentState.captureActive) void stopForTab();
  else void startForTab();
});
elements.saveKey.addEventListener("click", () => void saveApiKey());
elements.translateToggle.addEventListener("change", async () => {
  const translate = elements.translateToggle.checked;
  translatePreference = translate;
  await chrome.storage.local.set({ koeTranslate: translate });
  // 翻译开关更新的是"正在捕获的会话"（可能在别的标签页），不是当前 tab——
  // 否则在其他 tab 上切开关，视频 tab 的字幕翻译永远不更新（"唯独视频没翻译"）。
  const targetTabId = currentState.tabId || activeTab?.id;
  if (targetTabId) {
    await chrome.runtime.sendMessage({ type: "SET_TRANSLATE", tabId: targetTabId, translate }).catch(() => undefined);
  }
  applyTranslationPrivacy();
  elements.hint.textContent = translate ? "中文翻译已开启 · 正在重连识别…" : "中文翻译已关闭 · 只显示原文";
});
elements.hideOriginalToggle.addEventListener("change", async () => {
  const hide = elements.hideOriginalToggle.checked;
  hideOriginalPreference = hide;
  await chrome.storage.local.set({ koeHideOriginal: hide });
  elements.hint.textContent = hide ? "已隐藏原文 · 只显示中文" : "已恢复显示原文与中文";
});
elements.captureMode.addEventListener("change", () => void saveCaptureMode());
elements.overlayEnabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ koeOverlayEnabled: elements.overlayEnabled.checked });
  elements.hint.textContent = elements.overlayEnabled.checked ? "页面字幕已开启" : "页面字幕已关闭 · 侧边栏记录仍会保留";
});
elements.overlaySize.addEventListener("change", async () => {
  await chrome.storage.local.set({ koeOverlaySize: elements.overlaySize.value });
  elements.hint.textContent = "页面字幕大小已更新";
});
elements.copyAll.addEventListener("click", () => void copyTranscript());
elements.clearFeed.addEventListener("click", () => {
  resetFeed();
  elements.hint.textContent = "字幕记录已清空";
});
elements.copyLogs.addEventListener("click", () => void copyDiagnosticLogs());
elements.clearLogs.addEventListener("click", () => void clearDiagnosticLogs());
elements.scrollBottom.addEventListener("click", () => smoothScrollToBottom());
elements.feed.addEventListener("scroll", () => {
  const nearBottom = elements.feed.scrollTop + elements.feed.clientHeight >= elements.feed.scrollHeight - 48;
  elements.scrollBottom.hidden = nearBottom;
});
chrome.tabs.onActivated.addListener(async () => {
  // 切换标签页时刷新状态与字幕流归属；不在切换时自动开启
  await refreshActiveTab();
});

// 后台转发的字幕消息（LIVE_PARTIAL / LIVE_SUBTITLES / LIVE_TRANSLATED / LIVE_STOP）
chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === "LIVE_STATE") return false; // 状态以 GET_STATE 轮询为准
  if (message.type === "LIVE_STOP") {
    clearDraft();
    return false;
  }
  // 自愈：还没接管任何会话时，直接从消息携带的 jobId 接管（后台只在捕获中转发，
  // 消息里的 jobId 一定是当前会话的），不依赖 GET_STATE 轮询的时机
  if (!activeJobId && !captureEnded && message.jobId) {
    activeJobId = String(message.jobId);
    resetFeed();
  }
  if (!belongsToSession(message)) return false;
  try {
    if (message.type === "OFFLINE_VISIBLE") {
      const epoch = Number(message.mediaEpoch) || 0;
      if (epoch !== activeMediaEpoch) {
        activeMediaEpoch = epoch;
        lastUnitSeq = 0;
      }
      if (!acceptUnitSeq(message.seq)) return false;
      const line = lastLine(message.lines);
      const text = displayValue(line);
      if (text) appendRow(text, "", message.seq);
      return false;
    }
    if (message.type === "LIVE_REVOKE") {
      revokeRow(message.fromSeq, message.toSeq);
      return false;
    }
    if (message.type === "LIVE_PARTIAL") {
      const text = lastLine(message.lines)?.text;
      if (!text) return false;
      if (translateOn()) {
        // 翻译模式：先显示弱化的原文草稿做即时反馈，译文到达后替换。
        // 原文不占 seq 门控（译文同 seq 由 LIVE_TRANSLATED 负责），
        // 译文展示期间原文不打扰（5 秒内不覆盖），避免原文/译文来回闪。
        if (hideOriginalOn()) return false; // 隐藏原文时不显示西文草稿，等译文
        if (draftKind === "translated" && Date.now() - draftTranslatedAt < 5_000) return false;
        setDraft(text, "raw");
      } else {
        if (!acceptDraftSeq(message.seq)) return false;
        setDraft(text, "raw");
      }
    } else if (message.type === "LIVE_SUBTITLES") {
      const text = lastLine(message.lines)?.text;
      if (translateOn()) {
        if (text) pendingOriginalUnits.set(Number(message.seq) || 0, text);
        return false;
      }
      if (!acceptUnitSeq(message.seq)) return false;
      if (text) promoteDraftOrAppend(text, message.seq);
    } else if (message.type === "LIVE_TRANSLATED") {
      if (!translateOn()) return false;
      if (message.unit && message.streaming) {
        const text = lastLine(message.lines)?.translated;
        if (!text) return false;
        if (!acceptDraftSeq(message.seq, { allowEqual: true })) return false;
        setDraft(text, "translated");
      } else if (message.unit) {
        const seq = Number(message.seq) || 0;
        const line = lastLine(message.lines);
        // 翻译偶发失败时稳定行退回原文，而不是整句消失。
        const text = String(line?.translated || (hideOriginalOn() ? "" : (pendingOriginalUnits.get(seq) || line?.text)) || "").trim();
        pendingOriginalUnits.delete(seq);
        if (!text) return false;
        if (!acceptUnitSeq(message.seq)) return false;
        promoteDraftOrAppend(text, message.seq);
      } else {
        const text = lastLine(message.lines)?.translated;
        if (!text) return false;
        if (!acceptDraftSeq(message.seq, { allowEqual: Boolean(message.streaming) })) return false;
        setDraft(text, "translated");
      }
    }
  } catch {
    // 显示失败不影响主流程
  }
  return false;
});

async function init() {
  if (elements.version) elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  await initPrefs();
  await refreshActiveTab();
  await refreshState();
  window.setInterval(() => { void refreshState(); }, 1_000);
}

async function initPrefs() {
  const { koeTranslate, koeHideOriginal, koeApiKey, koeCaptureSource, koeAsrEngine, koeOverlayEnabled, koeOverlaySize } = await chrome.storage.local.get([
    "koeTranslate", "koeHideOriginal", "koeApiKey", "koeCaptureSource", "koeAsrEngine", "koeOverlayEnabled", "koeOverlaySize"
  ]);
  translatePreference = koeTranslate !== undefined ? Boolean(koeTranslate) : true;
  elements.translateToggle.checked = translatePreference;
  hideOriginalPreference = koeHideOriginal !== undefined ? Boolean(koeHideOriginal) : false;
  elements.hideOriginalToggle.checked = hideOriginalPreference;
  const sourceValue = koeCaptureSource === "mic" ? "mic" : "tab";
  const engineValue = ["local", "webspeech"].includes(koeAsrEngine) ? koeAsrEngine : "dashscope";
  const modeKey = Object.keys(CAPTURE_MODES)
    .find((key) => CAPTURE_MODES[key].source === sourceValue && CAPTURE_MODES[key].engine === engineValue)
    || "tab-dashscope";
  elements.captureMode.value = modeKey;
  // 旧配置（麦克风 / Chrome 内置）已下线：归一化回有效的 tab 模式，避免启动读到过时值
  const chosen = CAPTURE_MODES[modeKey];
  if (chosen.source !== sourceValue || chosen.engine !== engineValue) {
    await chrome.storage.local.set({ koeCaptureSource: chosen.source, koeAsrEngine: chosen.engine });
  }
  applyTranslationPrivacy();
  elements.overlayEnabled.checked = koeOverlayEnabled !== false;
  elements.overlaySize.value = ["small", "medium", "large"].includes(koeOverlaySize) ? koeOverlaySize : "medium";
  hasApiKey = Boolean(String(koeApiKey || "").trim());
  // 本地模式不需要 API Key：设置默认收起；DashScope 且未保存 Key 才展开提示。
  elements.settings.open = !hasApiKey && currentMode().engine === "dashscope";
  updateSettingsSummary();
  if (hasApiKey) elements.apiKey.placeholder = "已保存 · 输入新 Key 可替换";
  await syncAuthRule(String(koeApiKey || "").trim());
}

function currentMode() {
  return CAPTURE_MODES[elements.captureMode.value] || CAPTURE_MODES["tab-dashscope"];
}

async function saveCaptureMode() {
  const mode = currentMode();
  await chrome.storage.local.set({ koeCaptureSource: mode.source, koeAsrEngine: mode.engine });
  applyTranslationPrivacy();
  // 切到 DashScope 且未保存 Key：展开设置，让用户看到输入框。
  if (mode.engine === "dashscope" && !hasApiKey) elements.settings.open = true;
  const targetTabId = currentState.tabId || activeTab?.id;
  if (targetTabId) {
    const response = await chrome.runtime.sendMessage({ type: "SET_CAPTURE", tabId: targetTabId }).catch(() => null);
    if (response?.state) currentState = response.state;
  }
  elements.hint.textContent = mode.engine === "local"
    ? "已切换本地精准字幕 · 原文识别与显示全程在本机"
    : `已切换模式：${elements.captureMode.options[elements.captureMode.selectedIndex].textContent}`;
}

function applyTranslationPrivacy() {
  // 本地精准默认只出原文；仅当本机具备本地翻译能力（macOS 26+ 且支持简体中文）时才放开开关。
  const localOriginalOnly = currentMode().engine === "local" && !Boolean(currentState.nativeTranslation);
  elements.translateToggle.disabled = localOriginalOnly;
  if (localOriginalOnly) {
    elements.translateToggle.checked = false;
    if (elements.translateLabel) elements.translateLabel.textContent = "中文翻译（本地精准暂为原文）";
  } else {
    elements.translateToggle.checked = translatePreference;
    if (elements.translateLabel) elements.translateLabel.textContent = "显示中文翻译";
  }
  // 隐藏原文只在开了翻译时才有意义；本地无法翻译时一并禁用。
  if (elements.hideOriginalToggle) {
    elements.hideOriginalToggle.disabled = localOriginalOnly || !elements.translateToggle.checked;
  }
  // API Key 只对 DashScope 模式需要；本地模式隐藏，精简页面。
  const isDashScope = currentMode().engine === "dashscope";
  if (elements.dashscopeOnly) elements.dashscopeOnly.hidden = !isDashScope;
}

function updateSettingsSummary() {
  elements.settingsSummary.textContent = hasApiKey ? "字幕模式与设置 · 已保存 API Key" : "字幕模式与设置";
}

async function syncAuthRule(apiKey) {
  const removeRuleIds = [AUTH_RULE_ID];
  if (!apiKey) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [] });
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: [{
      id: AUTH_RULE_ID,
      priority: 10,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{
          header: "Authorization",
          operation: "set",
          value: `Bearer ${apiKey}`
        }]
      },
      condition: {
        urlFilter: "||dashscope.aliyuncs.com/api-ws/",
        resourceTypes: ["websocket"],
        initiatorDomains: [chrome.runtime.id]
      }
    }]
  });
}

async function saveApiKey() {
  const apiKey = String(elements.apiKey.value || "").trim();
  if (!apiKey) {
    elements.hint.textContent = "请输入 DashScope API Key。";
    elements.apiKey.focus();
    return;
  }
  await chrome.storage.local.set({ koeApiKey: apiKey });
  await syncAuthRule(apiKey);
  hasApiKey = true;
  elements.apiKey.value = "";
  elements.apiKey.placeholder = "已保存 · 输入新 Key 可替换";
  elements.settings.open = false;
  updateSettingsSummary();
  elements.hint.textContent = "API Key 已保存，正在开启字幕…";
  renderState();
  // 保存动作本身是一次用户手势：直接为当前标签页开启字幕
  void startForTab();
}

async function refreshActiveTab() {
  // 侧边栏页面不属于任何标签页：tabs.query({currentWindow:true}) 可能返回空。
  // 先用 getLastFocused 拿到最近聚焦的窗口，再查它的激活标签页。
  try {
    const [window] = await chrome.windows.getLastFocused().catch(() => []);
    if (window?.id) {
      [activeTab] = await chrome.tabs.query({ active: true, windowId: window.id });
    } else {
      [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
  } catch {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  }
  await refreshState();
}

async function refreshState() {
  // 字幕捕获是全局单会话：按钮状态跟随“正在捕获的会话”，
  // 而不是当前标签页——否则字幕在别的标签页跑着，这里却显示“开启”。
  const captureStateResponse = await chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => null);
  // 后台休眠唤醒的瞬态：GET_STATE 失败时直接跳过本次刷新，
  // 绝不能当成 idle——否则 activeJobId 被清空、下一轮轮询误判会话变化，
  // resetFeed 把整个字幕记录清掉（切 tab 丢字幕的根因）。
  if (!captureStateResponse) return;
  const captureState = captureStateResponse.state || { status: "idle" };
  currentState = captureState;
  // 本地翻译能力来自 Helper 握手，可能在轮询后才就绪；每次刷新按当前能力重放翻译开关。
  applyTranslationPrivacy();
  // 开关 = 用户偏好（koeTranslate），永远不被会话值改掉（否则"每次切过去开关被重置"）。
  // 若会话翻译与偏好不一致（如历史遗留、会话重启读到旧值），自动把偏好同步到会话，
  // 但节流到 10 秒一次，避免每 1 秒轮询触发一次重连识别。
  if (captureState.captureActive
    && typeof captureState.translate === "boolean"
    && captureState.translate !== elements.translateToggle.checked
    && Date.now() - lastTranslateSyncAt > 10_000) {
    lastTranslateSyncAt = Date.now();
    const targetTabId = captureState.tabId || activeTab?.id;
    if (targetTabId) {
      await chrome.runtime.sendMessage({
        type: "SET_TRANSLATE",
        tabId: targetTabId,
        translate: elements.translateToggle.checked
      }).catch(() => undefined);
    }
  }
  const jobId = String(captureState.jobId || "");
  if (captureState.captureActive && jobId && jobId !== activeJobId) {
    activeJobId = jobId;
    activeMediaEpoch = Number(captureState.mediaEpoch) || 0;
    captureEnded = false;
    resetFeed();
    // 侧边栏是"每 tab 一个实例"：切 tab 后新实例接管会话时，
    // 从后台拉回本次会话已上屏的字幕历史（避免记录清空）
    void restoreTranscript();
  } else if (!captureState.captureActive && activeJobId) {
    // 捕获已结束：停止接收该会话的字幕，保留已有历史
    captureEnded = true;
    activeJobId = "";
    clearDraft();
  }
  renderState();
  updateStatusHint();
  // 空字幕流时的统一占位：未开启提示点按钮；捕获中提示等待识别结果
  if (elements.feed.children.length === 0 && !draftEl) {
    appendRow(
      captureState.captureActive
        ? "正在等待识别结果…视频有声音时，字幕会出现在这里"
        : "点击「开启实时字幕」，字幕会持续滚动显示在这里",
      "placeholder"
    );
  }
}

// 状态变化时把一句话写进底部提示；空闲时恢复默认提示（不覆盖按钮启动的分步提示）
function updateStatusHint() {
  const status = currentState.status || "idle";
  let next = "";
  if (status === "live") next = "live";
  else if (status === "error") next = "error";
  else if (status === "idle") next = "idle";
  if (!next || next === lastStatusHint) return;
  lastStatusHint = next;
  if (next === "live") {
    const otherTab = currentState.tabId && activeTab?.id && currentState.tabId !== activeTab.id;
    elements.hint.textContent = otherTab ? "字幕运行于其他标签页 · 点击「停止」可关闭" : "字幕已开启 · 内容持续滚动在下方";
  } else if (next === "error") {
    elements.hint.textContent = currentState.stageDetail || "已断开 · 点击「开启实时字幕」重试";
  } else if (next === "idle" && !String(elements.hint.textContent).startsWith("①")) {
    elements.hint.textContent = "Alt+K：开启并跟随正在发声的标签页";
  }
}

// 侧边栏里的点击不被 Chrome 认可为 tabCapture 授权手势（此版本已实测），
// 所以不再自动尝试开启；标签页模式需走工具栏图标点击或 Alt+K。

async function startForTab() {
  // 全程可见进度：每一步都把状态写进 hint，任何失败都能被看到并定位
  if (!activeTab?.id) {
    elements.hint.textContent = "① 没有定位到当前标签页，请切到视频标签页后再试。";
    await refreshActiveTab();
    return;
  }
  let busyTimer = 0;
  try {
    elements.hint.textContent = "① 正在读取设置…";
    const { koeApiKey } = await chrome.storage.local.get("koeApiKey");
    const apiKey = String(koeApiKey || "").trim();
    const mode = currentMode();
    const micMode = mode.source === "mic";
    const localMode = mode.engine === "local";
    const keyless = mode.engine !== "dashscope";
    if (!keyless && !apiKey) {
      elements.settings.open = true;
      elements.hint.textContent = "② DashScope 模式需要 API Key；或把字幕模式切换为「Chrome 内置」。";
      elements.apiKey.focus();
      return;
    }
    elements.hint.textContent = "② 正在同步请求头规则…";
    await syncAuthRule(apiKey);
    setButtonBusy(true);
    // 兜底：15 秒后强制恢复按钮，避免卡死成“点了没反应”
    busyTimer = window.setTimeout(() => {
      setButtonBusy(false);
      elements.hint.textContent = "操作超时，请再点一次「开启实时字幕」。";
    }, 15_000);
    let streamId = "";
    if (!micMode && !localMode) {
      elements.hint.textContent = `③ 正在为标签页 ${activeTab.id} 获取音频流授权…`;
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    } else if (localMode) {
      elements.hint.textContent = "③ 正在连接本地 Koe Helper，无需标签页录音授权…";
    } else {
      elements.hint.textContent = "③ 麦克风模式：无需手势授权（首次使用浏览器会询问麦克风权限）…";
    }
    elements.hint.textContent = "④ 正在启动识别会话…";
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: activeTab.id,
      streamId,
      pageUrl: activeTab.url
    });
    if (!response?.ok) throw new Error(response?.error || "无法启动实时字幕。");
    currentState = response.state || { status: "live" };
    lastStatusHint = "";
    elements.hint.textContent = "⑤ 字幕已开启 · 识别内容会持续滚动在下方";
    renderState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/gesture|invocation|permission|user gesture/i.test(message)) {
      elements.hint.textContent = "需要先点一次工具栏 Koe 图标（弹窗里一键开启）或按 Alt+K 授权。也可以把字幕模式切成麦克风，完全不需要手势。";
    } else {
      elements.hint.textContent = `启动失败：${message}`;
    }
  } finally {
    if (busyTimer) window.clearTimeout(busyTimer);
    setButtonBusy(false);
    await refreshState();
  }
}

async function stopForTab() {
  // 停的是“正在捕获的会话”，可能在别的标签页
  const tabId = currentState.tabId || activeTab?.id;
  if (!tabId) return;
  setButtonBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "STOP_CAPTURE",
      tabId,
      jobId: currentState.jobId || ""
    });
    currentState = response?.state || { status: "idle" };
    lastStatusHint = "";
    elements.hint.textContent = "已停止 · 字幕流保留";
  } catch (error) {
    elements.hint.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setButtonBusy(false);
    await refreshState();
  }
}

function setButtonBusy(busy) {
  elements.startButton.disabled = Boolean(busy);
}

function renderState() {
  const status = currentState.status || "idle";
  const live = status === "live";
  const captureActive = Boolean(currentState.captureActive);
  const local = currentState.engine === "local" || (!captureActive && currentMode().engine === "local");
  const gesture = Boolean(currentState.captureNeedsGesture);
  const error = status === "error";
  const starting = !live && !error && !gesture && status !== "idle";
  elements.statusDot.className = `dot ${error ? "bad" : live ? "ok" : gesture || starting ? "busy" : ""}`;
  elements.startButton.textContent = captureActive
    ? (local ? "停止本地字幕" : "停止实时字幕")
    : (local ? "开启本地精准字幕" : "开启实时字幕");
  elements.startButton.classList.toggle("active", captureActive);
}

// ===== 字幕流：历史行累积 + 草稿行实时刷新（Mimi 模型）=====
// 显示端切段（移植 Mimi 的 segmenter）：长字幕按句末标点 / 逗号等自然停顿 / 最大长度
// 切成短行，中文 28 字、英文 64 字符一行，避免一整坨糊在侧边栏里。
const SENTENCE_ENDINGS = new Set(["。", "！", "？", "!", "?", "；", ";", "\n"]);
const PREFERRED_BREAKS = new Set(["，", "、", ",", "：", ":", "—", "–", "-", " "]);

function isCjkText(text) {
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

function subtitleMaxChars(text) {
  return isCjkText(text) ? 28 : 64;
}

function segments(text, maximumCharacters) {
  const max = Math.max(4, maximumCharacters);
  const remaining = Array.from(String(text).trim());
  const result = [];
  while (remaining.length > 0) {
    while (remaining.length > 0 && /\s/.test(remaining[0])) remaining.shift();
    if (remaining.length === 0) break;
    const searchCount = Math.min(max, remaining.length);
    const sentenceEndIndex = remaining
      .slice(0, searchCount)
      .findIndex((ch) => SENTENCE_ENDINGS.has(ch));
    if (sentenceEndIndex >= 0) {
      appendSegment(remaining, sentenceEndIndex + 1, result);
      continue;
    }
    if (remaining.length <= max) {
      appendSegment(remaining, remaining.length, result);
      continue;
    }
    const minimumPreferredBreak = Math.max(1, Math.floor(max / 2));
    let preferredBreak = -1;
    for (let index = max - 1; index >= minimumPreferredBreak; index -= 1) {
      if (PREFERRED_BREAKS.has(remaining[index])) {
        preferredBreak = index;
        break;
      }
    }
    const end = preferredBreak >= 0
      ? (/\s/.test(remaining[preferredBreak]) ? preferredBreak : preferredBreak + 1)
      : max;
    appendSegment(remaining, Math.max(1, end), result);
  }
  return result;
}

function appendSegment(remaining, end, result) {
  const safeEnd = Math.min(Math.max(1, end), remaining.length);
  const segment = remaining.slice(0, safeEnd).join("").trim();
  remaining.splice(0, safeEnd);
  if (segment.length > 0) result.push(segment);
}

function translateOn() {
  return Boolean(elements.translateToggle.checked);
}

// 「隐藏原文」：仅当开着翻译时才隐藏原文（否则没有可显示的译文）。
function hideOriginalOn() {
  return Boolean(hideOriginalPreference) && translateOn();
}

// 一条字幕该显示什么：翻译优先（隐藏原文时绝不回落原文），否则原文。
function displayValue(line) {
  const translated = String(line?.translated || "").trim();
  if (translateOn()) return translated || (hideOriginalOn() ? "" : String(line?.text || "").trim());
  return String(line?.text || "").trim();
}

function belongsToSession(message) {
  // 会话已结束或尚未接管的字幕一律丢弃
  if (captureEnded) return false;
  const jobId = String(message.jobId || "");
  if (!jobId) return false;
  return jobId === activeJobId;
}

function lastLine(lines) {
  return Array.isArray(lines) ? lines[lines.length - 1] : null;
}

function acceptUnitSeq(seq) {
  const value = Number(seq);
  if (!Number.isFinite(value)) return true;
  if (value <= lastUnitSeq) return false;
  lastUnitSeq = value;
  return true;
}

function acceptDraftSeq(seq, { allowEqual = false } = {}) {
  const value = Number(seq);
  if (!Number.isFinite(value)) return true;
  if (value < lastDraftSeq || (!allowEqual && value === lastDraftSeq)) return false;
  lastDraftSeq = Math.max(lastDraftSeq, value);
  return true;
}

function resetFeed() {
  elements.feed.textContent = "";
  draftEl = null;
  lastUnitSeq = 0;
  lastDraftSeq = 0;
  pendingOriginalUnits.clear();
}

// 切 tab 后新面板实例接管会话：从后台拉回本次会话已上屏的字幕历史。
// 只恢复 unit 行（原文或译文按当前翻译开关显示），草稿行不恢复。
async function restoreTranscript() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_TRANSCRIPT" });
    const rows = (Array.isArray(response?.rows) ? response.rows : [])
      .filter((row) => !activeJobId || String(row?.jobId || "") === activeJobId);
    if (rows.length === 0) return;
    let maxSeq = 0;
    for (const row of rows) {
      const display = displayValue(row);
      if (!display) continue;
      appendRow(display, "", row.seq);
      const seq = Number(row.seq) || 0;
      if (seq > maxSeq) maxSeq = seq;
    }
    // 恢复的历史已消耗这些 seq：门控前移，避免新字幕被 seq 门控误拒
    if (maxSeq > lastUnitSeq) lastUnitSeq = maxSeq;
    elements.feed.querySelectorAll(".placeholder").forEach((node) => node.remove());
  } catch {
    // 后台暂不可用时跳过恢复
  }
}

function appendRow(text, className = "", seq = "") {
  elements.feed.querySelectorAll(".placeholder").forEach((node) => node.remove());
  const time = formatTime(new Date());
  const parts = segments(String(text), subtitleMaxChars(String(text)));
  for (const part of parts) {
    const row = document.createElement("div");
    row.className = `row ${className}`.trim();
    row.dataset.ts = time;
    row.dataset.text = part;
    if (seq) row.dataset.seq = String(seq);
    const timeEl = document.createElement("span");
    timeEl.className = "time";
    timeEl.textContent = time;
    const textEl = document.createElement("span");
    textEl.className = "text";
    textEl.textContent = part;
    row.appendChild(timeEl);
    row.appendChild(textEl);
    elements.feed.appendChild(row);
    while (elements.feed.children.length > MAX_ROWS) {
      elements.feed.firstElementChild.remove();
    }
  }
  smoothScrollToBottom();
}

// 识别修正撤回：删除 seq 落在 [fromSeq, toSeq] 的字幕行（原文行和它的译文行
// 同 seq，一起删），让修正后的正确文本重新累积，不再残留错行。
function revokeRow(fromSeq, toSeq) {
  clearDraft();
  const from = Number(fromSeq) || 0;
  const to = Number(toSeq) || from;
  if (!from) return;
  for (let seq = from; seq <= to; seq += 1) pendingOriginalUnits.delete(seq);
  const rows = [...elements.feed.children];
  let removed = 0;
  for (const row of rows) {
    const seq = Number(row.dataset.seq || 0);
    if (seq && seq >= from && seq <= to) {
      row.remove();
      removed += 1;
    }
  }
  // 行没带 seq 时兜底：删最后一条非草稿行
  if (removed === 0) {
    const units = [...elements.feed.children]
      .filter((row) => !row.classList.contains("placeholder") && !row.classList.contains("draft"));
    const last = units[units.length - 1];
    if (last) last.remove();
  }
}

let draftDebounceTimer = null;
let pendingDraftPayload = null;

// 草稿显示防抖：原文草稿 300ms 内稳定了才显示，避免识别修正时
// （"好"→"hooly"→"Holy shit"）草稿行快速跳变闪烁；
// 译文草稿（kind=translated）不防抖，译文到了立即显示。
function setDraft(text, kind = "raw") {
  pendingDraftPayload = { text: String(text), kind };
  if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
  if (kind === "translated") {
    draftDebounceTimer = null;
    applyDraft(pendingDraftPayload.text, pendingDraftPayload.kind);
    pendingDraftPayload = null;
    return;
  }
  draftDebounceTimer = window.setTimeout(() => {
    draftDebounceTimer = null;
    if (pendingDraftPayload) {
      const { text: value, kind: payloadKind } = pendingDraftPayload;
      pendingDraftPayload = null;
      applyDraft(value, payloadKind);
    }
  }, 300);
}

function applyDraft(text, kind = "raw") {
  elements.feed.querySelectorAll(".placeholder").forEach((node) => node.remove());
  // 草稿只显示最新两段，避免草稿行越长越高
  const value = String(text);
  const parts = segments(value, subtitleMaxChars(value)).slice(-2);
  const joined = parts.join(isCjkText(value) ? "" : " ");
  const existed = Boolean(draftEl && draftEl.isConnected);
  if (!existed) {
    draftEl = document.createElement("div");
    draftEl.className = "row draft";
    const timeEl = document.createElement("span");
    timeEl.className = "time";
    timeEl.textContent = formatTime(new Date());
    const textEl = document.createElement("span");
    textEl.className = "text";
    draftEl.appendChild(timeEl);
    draftEl.appendChild(textEl);
    elements.feed.appendChild(draftEl);
  }
  const textEl = draftEl.querySelector(".text");
  const oldText = textEl ? textEl.textContent : "";
  // 识别修正过渡：新文本与旧文本互不包含（服务端整句换词）时，
  // 先做一次淡入动画，避免草稿行“硬跳”造成的闪动感
  if (existed && oldText && !value.includes(oldText) && !oldText.includes(value)) {
    draftEl.classList.remove("correcting");
    void draftEl.offsetWidth; // 强制重排，确保动画重新触发
    draftEl.classList.add("correcting");
    window.setTimeout(() => {
      if (draftEl && draftEl.classList) draftEl.classList.remove("correcting");
    }, 320);
  }
  draftEl.dataset.kind = kind;
  draftKind = kind;
  if (kind === "translated") draftTranslatedAt = Date.now();
  if (textEl) textEl.textContent = joined;
  smoothScrollToBottom();
}

function clearDraft() {
  if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
  draftDebounceTimer = null;
  pendingDraftPayload = null;
  if (draftEl) {
    draftEl.remove();
    draftEl = null;
  }
  draftKind = "";
  draftTranslatedAt = 0;
}

// 字幕块提交时把草稿行原地“转正”：同一句话在记录里只出现一次，
// 不会出现“草稿一行 + 正式一行”的重复观感。
function promoteDraftOrAppend(text, seq = "") {
  const value = String(text);
  if (draftEl && draftEl.isConnected && segments(value, subtitleMaxChars(value)).length <= 1) {
    draftEl.className = "row";
    draftEl.dataset.text = value;
    if (seq) draftEl.dataset.seq = String(seq);
    const textEl = draftEl.querySelector(".text");
    if (textEl) textEl.textContent = value;
    draftEl = null;
    draftKind = "";
    draftTranslatedAt = 0;
    smoothScrollToBottom();
    return;
  }
  clearDraft();
  appendRow(value, "", seq);
}

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function smoothScrollToBottom() {
  if (typeof elements.feed.scrollTo === "function") {
    elements.feed.scrollTo({ top: elements.feed.scrollHeight, behavior: "smooth" });
  } else {
    elements.feed.scrollTop = elements.feed.scrollHeight;
  }
}

async function copyTranscript() {
  const lines = [...elements.feed.children]
    .filter((row) => !row.classList.contains("placeholder") && !row.classList.contains("draft"))
    .map((row) => `[${row.dataset.ts || ""}] ${row.dataset.text || ""}`)
    .filter((line) => line.trim().length > 2);
  if (lines.length === 0) {
    elements.hint.textContent = "还没有可复制的字幕";
    return;
  }
  const content = lines.join("\n");
  try {
    await navigator.clipboard.writeText(content);
    elements.hint.textContent = `已复制 ${lines.length} 条字幕`;
  } catch {
    elements.hint.textContent = "复制失败：请手动选中字幕记录";
  }
}

// 复制诊断日志：offscreen 全链路打点（识别/提交/翻译/重连），存于后台环形缓冲。
// 字幕“乱七八糟”时把这段日志发给开发者即可定位是识别、断句还是翻译的问题。
async function copyDiagnosticLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LOGS" });
    const logs = Array.isArray(response?.logs) ? response.logs : [];
    if (logs.length === 0) {
      elements.hint.textContent = "还没有日志：先开一会字幕再复制";
      return;
    }
    const content = logs
      .map((entry) => `${new Date(Number(entry.ts) || 0).toISOString().slice(11, 23)} ${entry.event} ${entry.detail}`)
      .join("\n");
    const withHeader = `Koe 诊断日志（${logs.length} 条）\n${content}`;
    await navigator.clipboard.writeText(withHeader);
    elements.hint.textContent = `已复制 ${logs.length} 条日志`;
  } catch {
    elements.hint.textContent = "获取日志失败，请重试";
  }
}

// 清空诊断日志：日志太多/太旧时从零开始记录，下次复制只含新内容
async function clearDiagnosticLogs() {
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
    elements.hint.textContent = "日志已清空";
  } catch {
    elements.hint.textContent = "清空日志失败，请重试";
  }
}
