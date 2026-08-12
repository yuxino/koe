const SERVER_URL = "http://127.0.0.1:8787";

let activeTab;
let currentState = { status: "idle" };
let healthOk = false;

const elements = {
  version: document.querySelector("#version"),
  statusDot: document.querySelector("#status-dot"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  startButton: document.querySelector("#start-button"),
  translateToggle: document.querySelector("#translate-toggle"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.startButton.addEventListener("click", () => {
  if (currentState.captureActive) void stopForTab();
  else void startForTab();
});
elements.translateToggle.addEventListener("change", async () => {
  const translate = elements.translateToggle.checked;
  await chrome.storage.local.set({ koeTranslate: translate });
  if (activeTab?.id) {
    await chrome.runtime.sendMessage({ type: "SET_TRANSLATE", tabId: activeTab.id, translate }).catch(() => undefined);
  }
});
chrome.tabs.onActivated.addListener(refreshActiveTab);

async function init() {
  if (elements.version) elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  await refreshActiveTab();
  await checkHealth();
  await initPrefs();
  await refreshState();
  window.setInterval(() => { void refreshState(); }, 1_000);
}

async function initPrefs() {
  const { koeTranslate } = await chrome.storage.local.get("koeTranslate");
  elements.translateToggle.checked = koeTranslate !== undefined ? Boolean(koeTranslate) : true;
}

async function refreshActiveTab() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refreshState();
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE", tabId: activeTab?.id });
  currentState = response?.state || { status: "idle" };
  renderState();
}

async function checkHealth() {
  try {
    const response = await fetch(`${SERVER_URL}/health`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("unhealthy");
    healthOk = true;
    elements.hint.textContent = "按 Alt+K 或打开此弹窗即可开启，同一页面内切换视频自动继续。";
  } catch {
    healthOk = false;
    elements.hint.textContent = "请先启动 Koe 本地助手。";
  }
  renderState();
}

async function startForTab() {
  if (!activeTab?.id) return;
  setButtonBusy(true);
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: activeTab.id,
      streamId,
      pageUrl: activeTab.url
    });
    if (!response?.ok) throw new Error(response?.error || "无法启动实时字幕。");
    currentState = response.state || { status: "live" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.engineStatus.textContent = "启动失败";
    elements.hint.textContent = message;
  } finally {
    setButtonBusy(false);
    await refreshState();
  }
}

async function stopForTab() {
  if (!activeTab?.id) return;
  setButtonBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE", tabId: activeTab.id });
    currentState = response?.state || { status: "idle" };
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
  const gesture = Boolean(currentState.captureNeedsGesture);
  const error = status === "error";
  const starting = !live && !error && !gesture && status !== "idle";

  elements.engineStatus.textContent = live
    ? "字幕开启中"
    : error
      ? "已断开"
      : gesture
        ? "点击开启"
        : starting
          ? "准备中"
          : "未开启";
  elements.engineDetail.textContent = live
    ? "切换视频自动继续"
    : error
      ? (currentState.stageDetail || "点一下图标或按 Alt+K 重试")
      : gesture
        ? "点一下图标或按 Alt+K，立即开始"
      : healthOk
        ? "打开此弹窗或按 Alt+K 开启"
        : "本地助手未连接";
  elements.statusDot.className = `dot ${error ? "bad" : live ? "ok" : gesture || starting ? "busy" : ""}`;
  elements.startButton.textContent = live ? "停止实时字幕" : "开始实时字幕";
  elements.startButton.classList.toggle("active", live);
}
