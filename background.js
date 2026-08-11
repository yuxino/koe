const OFFSCREEN_PATH = "offscreen.html";
const tabStates = new Map();
let offscreenCreation;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  if (message.type === "START_CAPTURE") return startCapture(message);
  if (message.type === "STOP_CAPTURE") return stopCapture(Number(message.tabId));
  if (message.type === "GET_STATE") {
    const state = tabStates.get(Number(message.tabId));
    return { ok: true, state: state ? publicState(state) : { running: false } };
  }
  if (message.type === "VIDEO_CLOCK" && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    const state = tabStates.get(tabId);
    if (state?.running) {
      state.videoClock = {
        timeMs: Number(message.currentTimeMs) || 0,
        paused: Boolean(message.paused),
        rate: Number(message.playbackRate) || 1,
        updatedAt: Date.now()
      };
      await sendToOffscreen({ target: "offscreen", type: "VIDEO_CLOCK", tabId, clock: state.videoClock });
    }
    return { ok: true };
  }
  if (message.type === "SUBTITLE" || message.type === "CAPTURE_STATUS" || message.type === "CAPTURE_ERROR") {
    return forwardToTab(Number(message.tabId), message);
  }
  return { ok: true };
}

async function startCapture({ tabId, serverUrl, apiToken, pageUrl }) {
  tabId = Number(tabId);
  if (!Number.isInteger(tabId)) throw new Error("No active tab found.");
  const current = tabStates.get(tabId);
  if (current?.running) return { ok: true, state: publicState(current) };

  await ensureContentScript(tabId);
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const state = {
    tabId,
    running: true,
    serverUrl: String(serverUrl || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    pageUrl: String(pageUrl || ""),
    startedAt: Date.now(),
    videoClock: null
  };
  tabStates.set(tabId, state);

  try {
    const offscreenResponse = await sendToOffscreen({
      target: "offscreen",
      type: "START_CAPTURE",
      tabId,
      streamId,
      serverUrl: state.serverUrl,
      apiToken: String(apiToken || ""),
      pageUrl: state.pageUrl
    });
    if (!offscreenResponse?.ok) throw new Error(offscreenResponse?.error || "音频采集页启动失败。");
    await forwardToTab(tabId, { type: "CAPTURE_STATUS", tabId, status: "running" });
    return { ok: true, state: publicState(state) };
  } catch (error) {
    tabStates.delete(tabId);
    await forwardToTab(tabId, { type: "CAPTURE_ERROR", tabId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function stopCapture(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return { ok: true, state: { running: false } };
  await sendToOffscreen({ target: "offscreen", type: "STOP_CAPTURE", tabId }).catch(() => undefined);
  tabStates.delete(tabId);
  await forwardToTab(tabId, { type: "CAPTURE_STATUS", tabId, status: "idle" });
  return { ok: true, state: { running: false } };
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Capture and process current-tab video audio for captions."
    });
  }
  await offscreenCreation;
  offscreenCreation = undefined;
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}

async function forwardToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return { ok: false, ignored: true };
  }
}

function publicState(state) {
  return {
    running: state.running,
    serverUrl: state.serverUrl,
    startedAt: state.startedAt
  };
}
