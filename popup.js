// Koe 弹窗：打开后只显示当前状态，由用户明确点击主按钮控制字幕开关。
// 侧边栏仍是可选的记录与设置面板，只有明确点击时才占用屏幕空间。

let activeTab;
let lastWindowId = null;   // 最近一次拿到的窗口 id，供"点击时同步开面板"使用
let currentState = { status: "idle" };

const elements = {
  version: document.querySelector("#version"),
  statusDot: document.querySelector("#status-dot"),
  startButton: document.querySelector("#start-button"),
  openPanel: document.querySelector("#open-panel"),
  statusText: document.querySelector("#status-text")
};

document.addEventListener("DOMContentLoaded", init);
elements.startButton.addEventListener("click", () => {
  const view = describeState(currentState);
  if (currentState.captureActive && view.kind !== "action" && view.kind !== "error") void stop();
  else void startRecommended();
});
elements.openPanel.addEventListener("click", () => {
  void (async () => {
    if (await openPanelAndClose()) window.close();
    else setStatus("记录面板没有打开，请再点一次", true);
  })();
});

async function init() {
  if (elements.version) elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  await refreshActiveTab();
  await refreshState();
}

async function openPanelAndClose() {
  // 优先用缓存的 windowId；没有缓存才异步查（异步段手势可能失效，但总比不开强）
  let tab = activeTab;
  if (!tab?.windowId && !lastWindowId) {
    try {
      const [window] = await chrome.windows.getLastFocused().catch(() => []);
      [tab] = window?.id
        ? await chrome.tabs.query({ active: true, windowId: window.id })
        : await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      return false;
    }
  }
  const windowId = tab?.windowId || lastWindowId;
  if (!windowId) return false;
  try {
    await chrome.sidePanel.open({ windowId });
    return true;
  } catch {
    return false;
  }
}

async function refreshActiveTab() {
  try {
    const [window] = await chrome.windows.getLastFocused().catch(() => []);
    [activeTab] = window?.id
      ? await chrome.tabs.query({ active: true, windowId: window.id })
      : await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  }
  if (activeTab?.windowId) lastWindowId = activeTab.windowId;
}

async function refreshState() {
  // 字幕捕获是全局单会话（一次只跑一个）：按钮状态跟随“正在捕获的会话”，
  // 而不是当前标签页——否则字幕还在别的标签页跑着，切个 tab 按钮却变回“开启”。
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => null);
  currentState = response?.state || { status: "idle" };
  render();
}

// 用户点开启后再问后台“该捕获谁”：当前页没在播时跟随正在发声的标签页。
async function startRecommended() {
  if (!activeTab?.id) {
    setStatus("没有定位到标签页，请切到视频标签页再试", true);
    return;
  }
  let targetId = activeTab.id;
  try {
    const rec = await chrome.runtime.sendMessage({ type: "RECOMMEND_TAB", tabId: activeTab.id });
    if (rec?.tabId) targetId = rec.tabId;
  } catch {
    // 后台暂不可用：仍按当前页尝试
  }
  await start(targetId);
}

async function start(targetIdOverride) {
  // 目标可能不是当前激活页（跟随其他标签页的声音）：就地取目标信息
  let tab = activeTab;
  if (targetIdOverride && targetIdOverride !== tab?.id) {
    tab = (await chrome.tabs.get(targetIdOverride).catch(() => null)) || tab;
  }
  if (!tab?.id) {
    setStatus("没有定位到标签页，请切到视频标签页再试", true);
    return;
  }
  currentState = {
    ...currentState,
    status: "starting",
    captureNeedsGesture: false,
    issueKind: "",
    issueCode: "",
    stageDetail: "正在连接当前视频…"
  };
  render();
  setBusy(true);
  try {
    // 本地模式会优先直接读取 HLS；遇到 DASH / blob / 普通 MP4 时才使用这份
    // 手势授权好的标签页音频流做本地实时回退。提前取到它不会上传或启动采集。
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: tab.id,
      streamId,
      pageUrl: tab.url
    });
    if (!response?.ok) {
      if (response?.state) currentState = response.state;
      throw new Error(response?.error || "无法启动实时字幕。");
    }
    currentState = response.state || { status: "live" };
    render();
    // 页面字幕已接管显示，保持视频可视区域不被侧边栏挤压。
    window.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/gesture|invocation|permission|user gesture/i.test(message)) {
      currentState = {
        ...currentState,
        status: "waiting-media",
        captureNeedsGesture: true,
        issueKind: "action",
        issueCode: "needs_tab_audio",
        stageDetail: "点一下「继续开启字幕」，允许 Koe 读取这个标签页的声音。"
      };
    } else {
      currentState = {
        ...currentState,
        status: "error",
        captureNeedsGesture: false,
        issueKind: "error",
        issueCode: currentState.issueCode || "capture_failed",
        stageDetail: currentState.stageDetail && currentState.issueKind === "error"
          ? currentState.stageDetail
          : message
      };
    }
    setBusy(false);
    render();
  }
}

async function stop() {
  // 停的是“正在捕获的会话”，可能在别的标签页
  const tabId = currentState.tabId || activeTab?.id;
  if (!tabId) return;
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "STOP_CAPTURE",
      tabId,
      jobId: currentState.jobId || ""
    });
    currentState = response?.state || { status: "idle" };
    setStatus("已停止");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
    render();
  }
}

function setBusy(busy) {
  elements.startButton.disabled = Boolean(busy);
}

function setStatus(text, isError = false, isAction = false) {
  elements.statusText.textContent = text;
  elements.statusText.classList.toggle("error", isError);
  elements.statusText.classList.toggle("action", isAction);
}

function render() {
  const status = currentState.status || "idle";
  const live = status === "live";
  const captureActive = Boolean(currentState.captureActive);
  const local = currentState.engine === "local";
  const view = describeState(currentState);
  const error = view.kind === "error";
  const action = view.kind === "action";
  const starting = view.kind === "starting";
  elements.statusDot.className = `dot ${error ? "bad" : live ? "ok" : action || starting ? "busy" : ""}`;
  elements.startButton.textContent = error
    ? "重新尝试"
    : action
      ? "继续开启字幕"
      : captureActive
        ? (local ? "停止本地字幕" : "停止实时字幕")
        : starting
          ? "正在开启…"
          : (local ? "开启本地精准字幕" : "开启实时字幕");
  elements.startButton.classList.toggle("active", captureActive);
  elements.startButton.classList.toggle("retry", error);
  elements.startButton.classList.toggle("needs-action", action);
  setStatus(view.text, error, action);
}

function describeState(state) {
  const status = String(state?.status || "idle");
  const issueKind = String(state?.issueKind || "");
  const issueCode = String(state?.issueCode || "");
  const detail = String(state?.stageDetail || "").trim();
  if (status === "error" || issueKind === "error") {
    const title = issueTitle(issueCode);
    return { kind: "error", title, text: detail ? `${title} · ${detail}` : title };
  }
  if (state?.captureNeedsGesture || issueKind === "action") {
    const title = issueCode === "needs_tab_audio" ? "点一下 Koe 继续" : "需要你的操作";
    return {
      kind: "action",
      title,
      text: detail ? `${title} · ${detail}` : `${title}，允许读取当前标签页的声音`
    };
  }
  if (status === "live") {
    const otherTab = state?.tabId && activeTab?.id && state.tabId !== activeTab.id;
    const local = state?.engine === "local";
    return {
      kind: "live",
      title: "字幕已开启",
      text: otherTab
        ? "字幕运行于其他标签页 · 停止按钮可关闭"
        : local ? "本地精准字幕已开启 · 音视频不会上传" : "字幕已开启 · 显示在视频画面上"
    };
  }
  if (status !== "idle" || state?.captureActive) {
    return { kind: "starting", title: "正在准备字幕", text: detail || "正在读取当前视频…" };
  }
  return { kind: "idle", title: "字幕已关闭", text: detail || "字幕已关闭 · 点上方按钮开启" };
}

function issueTitle(issueCode) {
  return ({
    protected_media: "此视频受保护，暂不支持",
    unsupported_audio: "暂不支持此音轨",
    unsupported_media: "暂不支持此视频",
    media_unreadable: "暂时无法读取这个视频",
    helper_unavailable: "Koe 本地服务没有连接",
    helper_incompatible: "Koe 需要更新",
    capture_failed: "字幕启动失败"
  })[issueCode] || "字幕暂不可用";
}
