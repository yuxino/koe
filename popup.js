const DEFAULT_SERVER_URL = "https://koe-api.yuxino.cn";
let activeTab;
let currentState = { status: "idle" };

const elements = {
  tabHost: document.querySelector("#tab-host"),
  tabTitle: document.querySelector("#tab-title"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  toggle: document.querySelector("#toggle"),
  serverUrl: document.querySelector("#server-url"),
  apiToken: document.querySelector("#api-token"),
  videoFile: document.querySelector("#video-file"),
  batchMark: document.querySelector("#batch-mark"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.toggle.addEventListener("click", analyze);
elements.serverUrl.addEventListener("change", saveServerUrl);

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  elements.tabHost.textContent = hostName(activeTab?.url);
  elements.tabTitle.textContent = activeTab?.title || "当前标签页";
  const stored = await chrome.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, apiToken: "" });
  elements.serverUrl.value = stored.serverUrl || DEFAULT_SERVER_URL;
  elements.apiToken.value = stored.apiToken;
  await checkHealth(elements.serverUrl.value);
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE", tabId: activeTab?.id });
  currentState = response?.state || { status: "idle" };
  renderState();
}

async function analyze() {
  if (!activeTab?.id) return;
  const serverUrl = elements.serverUrl.value.trim().replace(/\/+$/, "");
  const apiToken = elements.apiToken.value.trim();
  await saveServerUrl();
  await chrome.storage.local.set({ apiToken });
  elements.toggle.disabled = true;
  elements.engineStatus.textContent = "正在创建任务…";
  try {
    if (elements.videoFile.files[0]) {
      currentState = await uploadLocalVideo({ serverUrl, apiToken, file: elements.videoFile.files[0] });
    } else {
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_VIDEO",
        tabId: activeTab.id,
        pageUrl: activeTab.url,
        serverUrl,
        apiToken
      });
      if (!response?.ok) throw new Error(response?.error || "无法创建分析任务。");
      currentState = response.state;
    }
    renderState();
  } catch (error) {
    elements.engineStatus.textContent = "创建失败";
    elements.engineDetail.textContent = error instanceof Error ? error.message : String(error);
    elements.hint.textContent = "请检查视频来源、服务地址和 API token。";
  } finally {
    elements.toggle.disabled = false;
  }
}

async function uploadLocalVideo({ serverUrl, apiToken, file }) {
  const createResponse = await fetch(`${serverUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(apiToken) },
    body: JSON.stringify({ upload: true, pageUrl: activeTab.url, filename: file.name })
  });
  const job = await parseResponse(createResponse, "无法创建本地视频任务");
  const uploadResponse = await fetch(`${serverUrl}/api/jobs/${job.id}/source`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream", "x-filename": file.name, ...authHeaders(apiToken) },
    body: file
  });
  const uploaded = await parseResponse(uploadResponse, "本地视频上传失败");
  const watch = await chrome.runtime.sendMessage({ type: "WATCH_JOB", tabId: activeTab.id, serverUrl, apiToken, jobId: uploaded.id });
  if (!watch?.ok) throw new Error(watch?.error || "无法跟踪分析任务。");
  return watch.state;
}

async function checkHealth(serverUrl) {
  try {
    const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/health`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("unhealthy");
    elements.engineDetail.textContent = `批处理服务 · ${body.provider || "mock"}`;
    elements.hint.textContent = body.provider === "mock"
      ? "当前是 mock 模式；真实字幕需要 Fun-ASR。"
      : "整段视频分析完成后，字幕才会显示。";
  } catch {
    elements.engineDetail.textContent = "批处理服务 · 未连接";
    elements.hint.textContent = "请检查服务地址和部署状态。";
  }
}

async function saveServerUrl() {
  const serverUrl = elements.serverUrl.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  elements.serverUrl.value = serverUrl;
  await chrome.storage.local.set({ serverUrl });
}

function renderState() {
  const status = currentState.status || "idle";
  const analyzing = status === "analyzing";
  elements.toggle.textContent = analyzing ? "Analyzing…" : "Analyze video";
  elements.toggle.classList.toggle("running", analyzing);
  elements.batchMark.textContent = analyzing ? `${Math.round(Number(currentState.progress || 0) * 100)}%` : "BATCH";
  elements.engineStatus.textContent = analyzing ? "整段分析中" : status === "ready" ? "字幕已就绪" : "准备就绪";
  elements.engineDetail.textContent = analyzing ? "不会显示中间字幕 · 等待完整结果" : status === "ready" ? "完整 VTT 已加载到视频" : "批处理服务";
}

function parseResponse(response, fallback) {
  return response.json().catch(() => ({})).then((body) => {
    if (!response.ok) throw new Error(body.error || `${fallback}（${response.status}）`);
    return body;
  });
}

function authHeaders(apiToken) {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

function hostName(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "当前标签页"; }
}
