// Koe 弹窗：点图标直接开启页面字幕。侧边栏退回为可选的记录与设置面板，
// 只有用户明确点「打开字幕记录与设置」时才占用屏幕空间。

let activeTab;
let lastWindowId = null;   // 最近一次拿到的窗口 id，供"点击时同步开面板"使用
let currentState = { status: "idle" };
let autoStartTried = false;

const elements = {
  version: document.querySelector("#version"),
  statusDot: document.querySelector("#status-dot"),
  startButton: document.querySelector("#start-button"),
  openPanel: document.querySelector("#open-panel"),
  statusText: document.querySelector("#status-text")
};

document.addEventListener("DOMContentLoaded", init);
elements.startButton.addEventListener("click", () => {
  if (currentState.captureActive) void stop();
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
  if (currentState.captureActive || currentState.status === "live") return;
  void tryAutoStart();
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

// 点图标 = 全自动：自动选目标（本页在播用本页，否则跟随正在发声的标签页），
// 自动授权、自动开启。只有实在没有声音来源时才让用户手动点。
async function tryAutoStart() {
  if (autoStartTried) return;
  autoStartTried = true;
  if (!activeTab?.id) return;
  if (currentState.captureActive || currentState.status === "live") return;
  await startRecommended();
}

// 先问后台“该捕获谁”，再开：当前页没在播时自动跟随正在发声的标签页
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
  setBusy(true);
  setStatus("正在开启…");
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
    if (!response?.ok) throw new Error(response?.error || "无法启动实时字幕。");
    currentState = response.state || { status: "live" };
    render();
    // 页面字幕已接管显示，保持视频可视区域不被侧边栏挤压。
    window.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/gesture|invocation|permission|user gesture/i.test(message)) {
      setStatus("点上面的「开启实时字幕」按钮（这一步需要浏览器授权）", true);
    } else {
      setStatus(`失败：${message}`, true);
    }
    setBusy(false);
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

function setStatus(text, isError = false) {
  elements.statusText.textContent = text;
  elements.statusText.classList.toggle("error", isError);
}

function render() {
  const status = currentState.status || "idle";
  const live = status === "live";
  const captureActive = Boolean(currentState.captureActive);
  const local = currentState.engine === "local";
  const error = status === "error";
  const gesture = Boolean(currentState.captureNeedsGesture);
  const starting = !live && !error && !gesture && status !== "idle";
  elements.statusDot.className = `dot ${error ? "bad" : live ? "ok" : gesture || starting ? "busy" : ""}`;
  elements.startButton.textContent = captureActive
    ? (local ? "停止本地字幕" : "停止实时字幕")
    : (local ? "开启本地精准字幕" : "开启实时字幕");
  elements.startButton.classList.toggle("active", captureActive);
  if (live) {
    // 字幕可能在别的标签页跑着：状态跟捕获会话走，别让用户以为没开
    const otherTab = currentState.tabId && activeTab?.id && currentState.tabId !== activeTab.id;
    setStatus(otherTab ? "字幕运行于其他标签页 · 停止按钮可关闭" : local ? "本地精准字幕已开启 · 音视频不会上传" : "字幕已开启 · 显示在视频画面上");
  }
}
