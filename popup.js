// Koe 弹窗：点图标 = 弹窗 + 侧边栏一起出现。
// 侧边栏打开的硬约束：chrome.sidePanel.open() 必须发生在"用户手势上下文"内，
// await 链之后的调用会抛 "may only be called in response to a user gesture"（Chromium issue 356181670）。
// 因此策略：① init 在 5 秒手势窗口内尽量早开；② 任何按钮点击先用缓存的 windowId 同步开一次（新手势）；
// ③ 开失败绝不静默——状态行提示 + 次按钮可再次点击重试。

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
  // 同步调用开面板：这次点击就是新的手势，必须在同一事件栈里发出
  fireAndForgetOpen();
  if (currentState.captureActive) void stop();
  else void startRecommended();
});
elements.openPanel.addEventListener("click", () => {
  fireAndForgetOpen();
  void (async () => {
    if (await openPanelAndClose()) window.close();
  })();
});

async function init() {
  if (elements.version) elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  await refreshActiveTab();
  // 无条件先开面板：点图标就该看到侧边栏（用户心智 = 旧版 openPanelOnActionClick 行为）
  const opened = await openPanelAndClose();
  await refreshState();
  if (currentState.captureActive || currentState.status === "live") return; // 开完即关弹窗
  if (!opened) setStatus("侧边栏没开出来？点「打开字幕侧边栏」再试一次", true);
  void tryAutoStart();
}

function fireAndForgetOpen() {
  if (!lastWindowId) return;
  void chrome.sidePanel.open({ windowId: lastWindowId }).catch(() => {});
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
    // 弹窗按钮点击 = 有效授权手势
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
    // 开好了：确保侧边栏开着，然后关弹窗
    fireAndForgetOpen();
    await openPanelAndClose();
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
    const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE", tabId });
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
  const error = status === "error";
  const gesture = Boolean(currentState.captureNeedsGesture);
  const starting = !live && !error && !gesture && status !== "idle";
  elements.statusDot.className = `dot ${error ? "bad" : live ? "ok" : gesture || starting ? "busy" : ""}`;
  elements.startButton.textContent = live ? "停止实时字幕" : "开启实时字幕";
  elements.startButton.classList.toggle("active", live);
  if (live) {
    // 字幕可能在别的标签页跑着：状态跟捕获会话走，别让用户以为没开
    const otherTab = currentState.tabId && activeTab?.id && currentState.tabId !== activeTab.id;
    setStatus(otherTab ? "字幕运行于其他标签页 · 停止按钮可关闭" : "字幕已开启 · 显示在侧边栏");
  }
}
