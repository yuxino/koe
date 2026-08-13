let activeTab;
let currentState = { status: "idle" };
let hasApiKey = false;

const AUTH_RULE_ID = 9001;
const elements = {
  version: document.querySelector("#version"),
  statusDot: document.querySelector("#status-dot"),
  engineStatus: document.querySelector("#engine-status"),
  engineDetail: document.querySelector("#engine-detail"),
  startButton: document.querySelector("#start-button"),
  translateToggle: document.querySelector("#translate-toggle"),
  apiKey: document.querySelector("#api-key"),
  saveKey: document.querySelector("#save-key"),
  hint: document.querySelector("#hint")
};

document.addEventListener("DOMContentLoaded", init);
elements.startButton.addEventListener("click", () => {
  if (currentState.captureActive) void stopForTab();
  else void startForTab();
});
elements.saveKey.addEventListener("click", () => void saveApiKey());
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
  await initPrefs();
  await refreshActiveTab();
  await refreshState();
  window.setInterval(() => { void refreshState(); }, 1_000);
}

async function initPrefs() {
  const { koeTranslate, koeApiKey } = await chrome.storage.local.get(["koeTranslate", "koeApiKey"]);
  elements.translateToggle.checked = koeTranslate !== undefined ? Boolean(koeTranslate) : true;
  hasApiKey = Boolean(String(koeApiKey || "").trim());
  if (hasApiKey) elements.apiKey.placeholder = "已保存 · 输入新 Key 可替换";
  await syncAuthRule(String(koeApiKey || "").trim());
}

async function saveApiKey() {
  const apiKey = String(elements.apiKey.value || "").trim();
  if (!apiKey) {
    elements.hint.textContent = "请输入 DashScope API Key。";
    return;
  }
  await chrome.storage.local.set({ koeApiKey: apiKey });
  await syncAuthRule(apiKey);
  hasApiKey = true;
  elements.apiKey.value = "";
  elements.apiKey.placeholder = "已保存 · 输入新 Key 可替换";
  elements.hint.textContent = "API Key 已保存在此浏览器中。";
  renderState();
}

async function syncAuthRule(apiKey) {
  const removeRuleIds = [AUTH_RULE_ID];
  if (!apiKey) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [] });
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: [{
      id: AUTH_RULE_ID,
      priority: 10,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{
          header: "Authorization",
          operation: "set",
          value: `Bearer ${apiKey}`
        }]
      },
      condition: {
        urlFilter: "||dashscope.aliyuncs.com/api-ws/",
        resourceTypes: ["websocket"]
      }
    }]
  });
}

async function refreshActiveTab() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refreshState();
}

async function refreshState() {
  if (!activeTab?.id) {
    currentState = { status: "idle" };
    renderState();
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE", tabId: activeTab.id }).catch(() => null);
  currentState = response?.state || { status: "idle" };
  renderState();
}

async function startForTab() {
  if (!activeTab?.id) return;
  const { koeApiKey } = await chrome.storage.local.get("koeApiKey");
  const apiKey = String(koeApiKey || "").trim();
  if (!apiKey) {
    elements.engineStatus.textContent = "缺少 API Key";
    elements.hint.textContent = "先保存 DashScope API Key。";
    return;
  }
  await syncAuthRule(apiKey);
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
    elements.hint.textContent = "当前标签页声音会直接发送到 DashScope。";
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
      : !hasApiKey
        ? "等待 API Key"
        : gesture
          ? "点击开启"
          : starting
            ? "准备中"
            : "未开启";
  elements.engineDetail.textContent = live
    ? "直连 DashScope · 切换视频自动继续"
    : error
      ? (currentState.stageDetail || "点一下图标或按 Alt+K 重试")
      : !hasApiKey
        ? "API Key 仅保存在 chrome.storage.local"
        : gesture
          ? "点一下图标或按 Alt+K，立即开始"
          : "无需 Node 或本地助手";
  elements.statusDot.className = `dot ${error ? "bad" : live ? "ok" : gesture || starting ? "busy" : ""}`;
  elements.startButton.textContent = live ? "停止实时字幕" : "开始实时字幕";
  elements.startButton.classList.toggle("active", live);
}
