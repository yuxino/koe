// Koe 弹窗：唯一职责 = 用“弹窗按钮点击”这个被 Chrome 认可的手势开启/停止字幕。
// 弹窗按钮点击是本地实测唯一稳定有效的 tabCapture 授权手势（侧边栏点击无效）。
// 开启成功后：弹窗自动关闭，侧边栏打开显示字幕流。设置都在侧边栏里。

let activeTab;
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
  else void start();
});
elements.openPanel.addEventListener("click", () => { void openPanelAndClose(); });

async function init() {
  if (elements.version) elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  await refreshActiveTab();
  await refreshState();
  // 字幕正在跑：点图标 = 查看侧边栏（恢复旧版“点图标开侧边栏”的行为）。
  // 否则用户想看字幕记录时只能看到一个小弹窗，侧边栏永远叫不出来。
  if (currentState.captureActive || currentState.status === "live") {
    await openPanelAndClose();
    return;
  }
  tryAutoStart();
}

async function openPanelAndClose() {
  // 不依赖 init 时序：按钮被点时就地取一次标签页，避免点击早于 init 完成时静默失效
  let tab = activeTab;
  if (!tab?.windowId) {
    try {
      const [window] = await chrome.windows.getLastFocused().catch(() => []);
      [tab] = window?.id
        ? await chrome.tabs.query({ active: true, windowId: window.id })
        : await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      return;
    }
  }
  if (!tab?.windowId) return;
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    // 旧版浏览器没有侧边栏 API，忽略即可
  }
  window.close();
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
}

async function refreshState() {
  const response = activeTab?.id
    ? await chrome.runtime.sendMessage({ type: "GET_STATE", tabId: activeTab.id }).catch(() => null)
    : null;
  currentState = response?.state || { status: "idle" };
  render();
}

// 点图标打开弹窗时自动尝试开启一次（若后台已探明本页有正在播放的视频）；
// 浏览器不认可这次手势时，按钮还在，点一下即可。
function tryAutoStart() {
  if (autoStartTried) return;
  autoStartTried = true;
  if (!activeTab?.id) return;
  if (currentState.captureActive || currentState.status === "live") return;
  if (!currentState.captureNeedsGesture) return;
  void start();
}

async function start() {
  if (!activeTab?.id) {
    setStatus("没有定位到标签页，请切到视频标签页再试", true);
    return;
  }
  setBusy(true);
  setStatus("正在开启…");
  try {
    // 弹窗按钮点击 = 有效授权手势
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: activeTab.id,
      streamId,
      pageUrl: activeTab.url
    });
    if (!response?.ok) throw new Error(response?.error || "无法启动实时字幕。");
    currentState = response.state || { status: "live" };
    render();
    // 开好了：打开侧边栏显示字幕，弹窗自动关闭
    try {
      await chrome.sidePanel.open({ windowId: activeTab.windowId });
    } catch {
      // 旧版浏览器无侧边栏时忽略
    }
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
  if (!activeTab?.id) return;
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE", tabId: activeTab.id });
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
  if (live) setStatus("字幕已开启 · 显示在侧边栏");
}
