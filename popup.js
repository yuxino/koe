const LOCAL_SERVER_URL = "http://127.0.0.1:8787";
let activeTab;
let currentState = { status: "idle" };
let healthState = { ok: false, provider: "" };
let videos = [];
let captureState = null;

const elements = {
  tabHost: document.querySelector("#tab-host"),
  tabTitle: document.querySelector("#tab-title"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  toggle: document.querySelector("#toggle"),
  videoSelect: document.querySelector("#video-select"),
  translateToggle: document.querySelector("#translate-toggle"),
  captureToggle: document.querySelector("#capture-toggle"),
  captureStatus: document.querySelector("#capture-status"),
  batchMark: document.querySelector("#batch-mark"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.toggle.addEventListener("click", analyze);
elements.captureToggle.addEventListener("click", toggleCapture);
elements.translateToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ koeTranslate: elements.translateToggle.checked });
});
chrome.tabs.onActivated.addListener(refreshActiveTab);

async function init() {
  await refreshActiveTab();
  await checkHealth();
  await refreshState();
  await refreshVideos();
  await initPrefs();
  await refreshCapture();
  setInterval(updateCaptureClock, 1_000);
}

async function initPrefs() {
  const { koeTranslate } = await chrome.storage.local.get("koeTranslate");
  elements.translateToggle.checked = koeTranslate !== undefined ? Boolean(koeTranslate) : true;
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
  const translate = elements.translateToggle.checked;
  const selectedVideo = selection
    ? videos.find((video) => `${video.frameId}:${video.index}` === selection)
    : videos[0];
  if (selectedVideo && (!selectedVideo.sourceUrl || selectedVideo.sourceUrl === activeTab.url)) {
    elements.captureStatus.textContent = "这个网站拿不到视频直链，已自动切换为采集模式";
    await toggleCapture();
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
      selection,
      translate
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

async function toggleCapture() {
  if (captureState?.tabId) {
    elements.captureToggle.disabled = true;
    elements.captureStatus.textContent = "正在停止…";
    try {
      await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
    } catch (error) {
      elements.captureStatus.textContent = error instanceof Error ? error.message : String(error);
    }
    captureState = null;
    elements.captureStatus.textContent = "已停止采集";
    renderCapture();
    elements.captureToggle.disabled = false;
    return;
  }
  await refreshActiveTab();
  if (!activeTab?.id) {
    elements.captureStatus.textContent = "没有找到当前标签页。";
    return;
  }
  elements.captureToggle.disabled = true;
  elements.captureStatus.textContent = "正在启动采集…";
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_START",
      tabId: activeTab.id,
      streamId,
      serverUrl: LOCAL_SERVER_URL,
      pageUrl: activeTab.url
    });
    if (!response?.ok) throw new Error(response?.error || "无法开始采集。");
    captureState = { tabId: activeTab.id, startedAt: response.capture?.startedAt || Date.now() };
    elements.captureStatus.textContent = "采集中：播放视频，字幕实时显示";
  } catch (error) {
    elements.captureStatus.textContent = error instanceof Error ? error.message : String(error);
  }
  renderCapture();
  elements.captureToggle.disabled = false;
}

async function refreshCapture() {
  const response = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATE" });
  captureState = response?.capture || null;
  renderCapture();
}

function updateCaptureClock() {
  if (!captureState?.tabId) return;
  const seconds = Math.max(0, Math.round((Date.now() - Number(captureState.startedAt || Date.now())) / 1_000));
  elements.captureStatus.textContent = `采集中 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · 字幕实时显示`;
  elements.captureToggle.textContent = "停止采集";
  elements.captureToggle.classList.add("running");
}

function renderCapture() {
  if (captureState?.tabId) {
    elements.captureToggle.textContent = "停止采集";
    elements.captureToggle.classList.add("running");
    updateCaptureClock();
  } else {
    elements.captureToggle.textContent = "开始采集";
    elements.captureToggle.classList.remove("running");
    if (elements.captureStatus.textContent.startsWith("采集中")) {
      elements.captureStatus.textContent = "播放视频，字幕实时显示";
    }
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
    elements.engineDetail.textContent = body.mode === "local"
      ? "本地提取 · 本地识别"
      : body.localProcessing
        ? "本地提取 · 整段识别"
        : `本地服务 · ${healthState.provider}`;
    elements.hint.textContent = body.provider === "mock"
      ? "当前是 mock 模式；真实字幕需要 Fun-ASR。"
      : body.mode === "local"
        ? "全部在本机处理，识别/翻译直接调用云端模型"
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
  const percent = Math.round(Number(currentState.progress || 0) * 100);
  const unknownDownload = analyzing && currentState.jobStatus === "downloading" && !currentState.hasDuration;
  const stageLabel = {
    downloading: "下载 / 提取声音中",
    uploading_audio: "上传音频中",
    analyzing: "整段识别中"
  }[currentState.jobStatus] || "整段分析中";
  elements.toggle.textContent = analyzing ? "Analyzing…" : "Analyze video";
  elements.toggle.classList.toggle("running", analyzing);
  elements.batchMark.textContent = unknownDownload ? "提取中" : analyzing ? `${percent}%` : "BATCH";
  elements.engineStatus.textContent = unknownDownload ? "下载 / 提取声音中" : analyzing ? stageLabel : status === "ready" ? "字幕已就绪" : "准备就绪";
  elements.engineDetail.textContent = unknownDownload
    ? "时长未知，暂时无法显示百分比"
    : analyzing
    ? `${percent}% · ${currentState.stageDetail || "完成后自动加载字幕"}`
    : status === "ready"
      ? "完整 VTT 已加载到视频"
      : healthState.ok
        ? "本地提取 · 整段识别"
        : "本地助手 · 未连接";
}

function hostName(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "当前标签页"; }
}
