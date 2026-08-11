const DEFAULT_SERVER_URL = "https://koe-api.yuxino.cn";
let activeTab;
let currentState = { running: false };

const elements = {
  tabHost: document.querySelector("#tab-host"),
  tabTitle: document.querySelector("#tab-title"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  toggle: document.querySelector("#toggle"),
  serverUrl: document.querySelector("#server-url"),
  apiToken: document.querySelector("#api-token"),
  liveMark: document.querySelector("#live-mark"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.toggle.addEventListener("click", toggleCapture);
elements.serverUrl.addEventListener("change", saveServerUrl);

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  elements.tabHost.textContent = hostName(activeTab?.url);
  elements.tabTitle.textContent = activeTab?.title || "当前标签页";
  const stored = await chrome.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, apiToken: "" });
  const savedServerUrl = stored.serverUrl === "http://127.0.0.1:8787" || stored.serverUrl === "http://localhost:8787"
    ? DEFAULT_SERVER_URL
    : stored.serverUrl;
  elements.serverUrl.value = savedServerUrl;
  elements.apiToken.value = stored.apiToken;
  await checkHealth(savedServerUrl);
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE", tabId: activeTab?.id });
  currentState = response?.state || { running: false };
  renderState();
}

async function toggleCapture() {
  if (!activeTab?.id) return;
  const serverUrl = elements.serverUrl.value.trim().replace(/\/+$/, "");
  await saveServerUrl();
  await chrome.storage.local.set({ apiToken: elements.apiToken.value.trim() });
  if (currentState.running) {
    await chrome.runtime.sendMessage({ type: "STOP_CAPTURE", tabId: activeTab.id });
    currentState = { running: false };
    renderState();
    return;
  }

  elements.toggle.disabled = true;
  elements.engineStatus.textContent = "正在连接…";
  const response = await chrome.runtime.sendMessage({
    type: "START_CAPTURE",
    tabId: activeTab.id,
    pageUrl: activeTab.url,
    serverUrl,
    apiToken: elements.apiToken.value.trim()
  });
  elements.toggle.disabled = false;
  if (!response?.ok) {
    elements.engineStatus.textContent = "连接失败";
    elements.engineDetail.textContent = response?.error || "请先启动本地服务";
    elements.hint.textContent = response?.error === "unauthorized" ? "服务器需要 API token，请在上方填写。" : "请检查服务地址和 API token。";
    return;
  }
  currentState = response.state;
  await checkHealth(serverUrl);
  renderState();
}

async function checkHealth(serverUrl) {
  try {
    const response = await fetch(`${serverUrl}/health`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("unhealthy");
    elements.engineDetail.textContent = `本地服务 · ${body.provider || "mock"}`;
    elements.hint.textContent = body.authRequired && !elements.apiToken.value.trim()
      ? "服务器已开启保护，请填写 API token。"
      : body.provider === "mock"
        ? "默认 mock 模式，可先验证插件链路。"
        : "真实 ASR 已接入，字幕会带词级时间戳。";
  } catch {
    elements.engineDetail.textContent = "本地服务 · 未连接";
    elements.hint.textContent = "在项目目录运行 npm start，再点击开始。";
  }
}

async function saveServerUrl() {
  const serverUrl = elements.serverUrl.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  elements.serverUrl.value = serverUrl;
  await chrome.storage.local.set({ serverUrl });
}

function renderState() {
  const running = Boolean(currentState.running);
  elements.toggle.textContent = running ? "Stop captions" : "Start captions";
  elements.toggle.classList.toggle("running", running);
  elements.liveMark.classList.toggle("active", running);
  if (running) {
    elements.engineStatus.textContent = "正在听写";
    elements.engineDetail.textContent = "音频已捕获 · 字幕会出现在视频下方";
  } else if (elements.engineStatus.textContent === "正在听写") {
    elements.engineStatus.textContent = "准备就绪";
  }
}

function hostName(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "当前标签页"; }
}
