const LOCAL_SERVER_URL = "http://127.0.0.1:8787";
let activeTab;
let currentState = { status: "idle" };
let healthDetail = "本地助手 · 检查中";

const elements = {
  version: document.querySelector("#version"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  toggle: document.querySelector("#toggle"),
  translateToggle: document.querySelector("#translate-toggle"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.toggle.addEventListener("click", analyze);
elements.translateToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ koeTranslate: elements.translateToggle.checked });
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

async function analyze() {
  await refreshActiveTab();
  if (!activeTab?.id) {
    elements.engineStatus.textContent = "无法分析";
    elements.engineDetail.textContent = "没有找到当前标签页。";
    return;
  }
  elements.toggle.disabled = true;
  elements.engineStatus.textContent = "正在创建任务…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "ANALYZE_VIDEO",
      tabId: activeTab.id,
      pageUrl: activeTab.url,
      serverUrl: LOCAL_SERVER_URL,
      apiToken: "",
      translate: elements.translateToggle.checked
    });
    if (!response?.ok) throw new Error(response?.error || "无法创建分析任务。");
    currentState = response.state;
    renderState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.engineStatus.textContent = "创建失败";
    elements.engineDetail.textContent = message;
  } finally {
    elements.toggle.disabled = false;
  }
}

async function checkHealth() {
  try {
    const response = await fetch(`${LOCAL_SERVER_URL}/health`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("unhealthy");
    healthDetail = body.mode === "local" ? "本地识别 · 实时" : "本地服务";
    elements.hint.textContent = "打开视频后点击页面右下角「分析字幕」，或直接点下面的按钮。";
  } catch {
    healthDetail = "本地助手 · 未连接";
    elements.hint.textContent = "请先启动 Koe 本地助手。";
  }
  renderState();
}

function renderState() {
  const status = currentState.status || "idle";
  const analyzing = status === "analyzing";
  const percent = Math.round(Number(currentState.progress || 0) * 100);
  elements.toggle.textContent = analyzing ? "分析中…" : "分析字幕";
  elements.toggle.classList.toggle("running", analyzing);
  elements.engineStatus.textContent = analyzing
    ? `分析中 ${percent}%`
    : status === "ready"
      ? (currentState.fromCache ? "字幕已就绪（缓存）" : "字幕已就绪")
      : status === "error"
        ? "视频分析失败"
        : "准备就绪";
  elements.engineDetail.textContent = analyzing
    ? (currentState.stageDetail || "实时识别中")
    : healthDetail;
}
