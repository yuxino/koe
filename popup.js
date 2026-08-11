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
  translateToggle: document.querySelector("#translate-toggle"),
  autoToggle: document.querySelector("#auto-toggle"),
  batchMark: document.querySelector("#batch-mark"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.toggle.addEventListener("click", analyze);
elements.translateToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ koeTranslate: elements.translateToggle.checked });
});
elements.autoToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ koeAutoAnalyze: elements.autoToggle.checked });
});
chrome.tabs.onActivated.addListener(refreshActiveTab);

async function init() {
  const version = document.querySelector("#version");
  if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;
  await refreshActiveTab();
  await checkHealth();
  await refreshState();
  await refreshVideos();
  await initPrefs();
}

async function initPrefs() {
  const { koeTranslate, koeAutoAnalyze } = await chrome.storage.local.get(["koeTranslate", "koeAutoAnalyze"]);
  elements.translateToggle.checked = koeTranslate !== undefined ? Boolean(koeTranslate) : true;
  elements.autoToggle.checked = Boolean(koeAutoAnalyze);
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
  await refreshVideos();
  if (!activeTab?.id) {
    elements.engineStatus.textContent = "无法分析";
    elements.engineDetail.textContent = "没有找到当前标签页。";
    return;
  }
  const selection = elements.videoSelect?.value || undefined;
  const translate = elements.translateToggle.checked;
  const candidates = selection
    ? videos.filter((video) => `${video.frameId}:${video.index}` === selection)
    : videos;
  const usable = candidates.find((video) => video.sourceUrl && isUsableSource(video.sourceUrl, activeTab.url));
  if (!usable) {
    elements.engineStatus.textContent = "无法分析";
    elements.engineDetail.textContent = "这个页面拿不到视频直链，无法分析。";
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
      selection: `${usable.frameId}:${usable.index}`,
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

function isUsableSource(sourceUrl, tabUrl) {
  if (!/^https?:/i.test(sourceUrl)) return false;
  if (!tabUrl) return true;
  try {
    const source = new URL(sourceUrl);
    const page = new URL(tabUrl);
    return !(source.hostname === page.hostname && source.pathname === page.pathname);
  } catch {
    return sourceUrl !== tabUrl;
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
  elements.engineStatus.textContent = unknownDownload ? "下载 / 提取声音中" : analyzing ? stageLabel : status === "ready" ? (currentState.fromCache ? "字幕已就绪（缓存）" : "字幕已就绪") : "准备就绪";
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
