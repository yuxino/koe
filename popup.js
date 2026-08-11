const DEFAULT_SERVER_URL = "https://koe-api.yuxino.cn";
let activeTab;
let currentState = { status: "idle" };
let healthState = { ok: false, provider: "", authRequired: false };

const elements = {
  tabHost: document.querySelector("#tab-host"),
  tabTitle: document.querySelector("#tab-title"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  toggle: document.querySelector("#toggle"),
  serverUrl: document.querySelector("#server-url"),
  apiToken: document.querySelector("#api-token"),
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
    const response = await chrome.runtime.sendMessage({
      type: "ANALYZE_VIDEO",
      tabId: activeTab.id,
      pageUrl: activeTab.url,
      serverUrl,
      apiToken
    });
    if (!response?.ok) throw new Error(response?.error || "无法创建分析任务。");
    currentState = response.state;
    renderState();
  } catch (error) {
    elements.engineStatus.textContent = "创建失败";
    elements.engineDetail.textContent = error instanceof Error ? error.message : String(error);
    elements.hint.textContent = "请检查视频来源、服务地址和 API token。";
  } finally {
    elements.toggle.disabled = false;
  }
}

async function checkHealth(serverUrl) {
  try {
    const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/health`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error("unhealthy");
    healthState = { ok: true, provider: body.provider || "mock", authRequired: Boolean(body.authRequired) };
    elements.engineDetail.textContent = healthState.authRequired ? "批处理服务 · 需要 API token" : `批处理服务 · ${healthState.provider}`;
    elements.hint.textContent = healthState.authRequired && !elements.apiToken.value
      ? "请填入服务端 KOE_API_TOKEN 后分析当前视频。"
      : body.provider === "mock"
      ? "当前是 mock 模式；真实字幕需要 Fun-ASR。"
      : "自动分析当前页面视频，整段完成后才加载字幕。";
  } catch {
    healthState = { ok: false, provider: "", authRequired: false };
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
  elements.engineDetail.textContent = analyzing
    ? "不会显示中间字幕 · 等待完整结果"
    : status === "ready"
      ? "完整 VTT 已加载到视频"
      : healthState.authRequired && !elements.apiToken.value
        ? "批处理服务 · 需要 API token"
        : healthState.ok
          ? `批处理服务 · ${healthState.provider}`
          : "批处理服务 · 未连接";
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
