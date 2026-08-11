const LOCAL_SERVER_URL = "http://127.0.0.1:8787";
let activeTab;
let currentState = { status: "idle" };
let healthState = { ok: false, provider: "" };
let videos = [];

const elements = {
  tabHost: document.querySelector("#tab-host"),
  tabTitle: document.querySelector("#tab-title"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  toggle: document.querySelector("#toggle"),
  videoSelect: document.querySelector("#video-select"),
  batchMark: document.querySelector("#batch-mark"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.toggle.addEventListener("click", analyze);
chrome.tabs.onActivated.addListener(refreshActiveTab);

async function init() {
  await refreshActiveTab();
  await checkHealth();
  await refreshState();
  await refreshVideos();
}

async function refreshActiveTab() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  elements.tabHost.textContent = hostName(activeTab?.url);
  elements.tabTitle.textContent = activeTab?.title || "当前标签页";
  await refreshState();
  await refreshVideos();
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
  const selection = elements.videoSelect?.value || undefined;
  elements.toggle.disabled = true;
  elements.engineStatus.textContent = "正在创建任务…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "ANALYZE_VIDEO",
      tabId: activeTab.id,
      pageUrl: activeTab.url,
      serverUrl: LOCAL_SERVER_URL,
      apiToken: "",
      selection
    });
    if (!response?.ok) throw new Error(response?.error || "无法创建分析任务。");
    currentState = response.state;
    renderState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.engineStatus.textContent = "创建失败";
    elements.engineDetail.textContent = message;
    elements.hint.textContent = message.includes("本地助手")
      ? "本地助手未连接，请重新运行 Koe 安装程序。"
      : "请确认当前页面的视频已经开始播放。";
  } finally {
    elements.toggle.disabled = false;
  }
}

async function refreshVideos() {
  if (!activeTab?.id) {
    videos = [];
    renderVideos();
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "LIST_VIDEOS", tabId: activeTab.id });
    videos = response?.ok ? response.videos || [] : [];
  } catch {
    videos = [];
  }
  renderVideos();
}

function renderVideos() {
  const select = elements.videoSelect;
  if (!select) return;
  const previous = select.value;
  select.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = videos.length ? "自动选择（避开广告）" : "未找到视频";
  select.appendChild(auto);
  videos.forEach((video, index) => {
    const option = document.createElement("option");
    option.value = `${video.frameId}:${video.index}`;
    const parts = [`视频 ${index + 1}`];
    if (video.width && video.height) parts.push(`${video.width}×${video.height}`);
    if (video.durationMs) {
      const totalSeconds = Math.round(video.durationMs / 1000);
      parts.push(`${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`);
    }
    parts.push(video.sourceUrl ? hostName(video.sourceUrl) : "无直链");
    option.textContent = parts.join(" · ");
    select.appendChild(option);
  });
  select.disabled = !videos.length;
  select.value = videos.some((video) => `${video.frameId}:${video.index}` === previous) ? previous : "";
}

async function checkHealth() {
  try {
    const response = await fetch(`${LOCAL_SERVER_URL}/health`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("unhealthy");
    healthState = { ok: true, provider: body.provider || "relay" };
    elements.engineDetail.textContent = body.localProcessing ? "本地提取 · 整段识别" : `本地服务 · ${healthState.provider}`;
    elements.hint.textContent = body.provider === "mock"
      ? "当前是 mock 模式；真实字幕需要 Fun-ASR。"
      : "选好视频后点击 Analyze video，整段分析完再加载字幕。";
  } catch {
    healthState = { ok: false, provider: "" };
    elements.engineDetail.textContent = "本地助手 · 未连接";
    elements.hint.textContent = "请先启动 Koe 本地助手。";
  }
}

function renderState() {
  const status = currentState.status || "idle";
  const analyzing = status === "analyzing";
  elements.toggle.textContent = analyzing ? "Analyzing…" : "Analyze video";
  elements.toggle.classList.toggle("running", analyzing);
  elements.batchMark.textContent = analyzing ? `${Math.round(Number(currentState.progress || 0) * 100)}%` : "BATCH";
  elements.engineStatus.textContent = analyzing ? "整段分析中" : status === "ready" ? "字幕已就绪" : "准备就绪";
  elements.engineDetail.textContent = analyzing
    ? "不会显示中间字幕 · 等待完整结果"
    : status === "ready"
      ? "完整 VTT 已加载到视频"
      : healthState.ok
        ? "本地提取 · 整段识别"
        : "本地助手 · 未连接";
}

function hostName(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "当前标签页"; }
}
