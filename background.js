const tabStates = new Map();
const pollers = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  stopPolling(tabId);
});

async function handleMessage(message) {
  if (message.type === "ANALYZE_VIDEO") return analyzeVideo(message);
  if (message.type === "WATCH_JOB") return watchJob(message);
  if (message.type === "STOP_ANALYSIS") return stopAnalysis(Number(message.tabId));
  if (message.type === "LIST_VIDEOS") return listVideos(Number(message.tabId));
  if (message.type === "GET_STATE") {
    const state = tabStates.get(Number(message.tabId));
    return { ok: true, state: state ? publicState(state) : { status: "idle" } };
  }
  return { ok: true };
}

async function analyzeVideo({ tabId, serverUrl, apiToken, pageUrl, selection }) {
  tabId = Number(tabId);
  if (!Number.isInteger(tabId)) throw new Error("没有找到当前标签页。");
  const source = await discoverVideoSource(tabId, pageUrl, selection);
  if (!source?.hasVideo) throw new Error("当前页面没有找到视频，请先打开包含视频的页面。");
  await ensureContentScript(tabId, source.frameId);

  const jobPageUrl = pageUrl || source.pageUrl;
  const sourceUrl = source.sourceUrl || "";
  const job = await createJob({
    serverUrl,
    apiToken,
    pageUrl: jobPageUrl,
    sourceUrl,
    filename: source.filename || "video"
  });
  return beginWatching({ tabId, frameId: source.frameId, serverUrl, apiToken, job });
}

async function watchJob({ tabId, frameId, serverUrl, apiToken, jobId }) {
  const job = await getJob(serverUrl, apiToken, jobId);
  return beginWatching({ tabId: Number(tabId), frameId: Number(frameId) || 0, serverUrl, apiToken, job });
}

async function beginWatching({ tabId, frameId = 0, serverUrl, apiToken, job }) {
  stopPolling(tabId);
  const state = {
    tabId,
    frameId,
    status: job.status === "ready" ? "ready" : "analyzing",
    jobId: job.id,
    serverUrl: String(serverUrl || "").replace(/\/+$/, ""),
    apiToken: String(apiToken || ""),
    startedAt: Date.now(),
    progress: Number(job.progress || 0)
  };
  tabStates.set(tabId, state);
  await forwardToTab(tabId, { type: "JOB_STATUS", tabId, status: state.status, progress: state.progress }, frameId);
  if (job.status === "ready") await publishReady(state);
  else pollers.set(tabId, setInterval(() => pollJob(tabId).catch((error) => failJob(tabId, error)), 2_000));
  return { ok: true, state: publicState(state) };
}

async function pollJob(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return stopPolling(tabId);
  const job = await getJob(state.serverUrl, state.apiToken, state.jobId);
  state.progress = Number(job.progress || 0);
  if (job.status === "ready") {
    stopPolling(tabId);
    state.status = "ready";
    await publishReady(state);
    return;
  }
  if (job.status === "error") {
    stopPolling(tabId);
    return failJob(tabId, new Error(job.error || "视频分析失败。"));
  }
  state.status = "analyzing";
  await forwardToTab(tabId, { type: "JOB_STATUS", tabId, status: state.status, progress: state.progress, jobStatus: job.status }, state.frameId);
}

async function publishReady(state) {
  const response = await fetch(`${state.serverUrl}/api/jobs/${state.jobId}/vtt`, { headers: authHeaders(state.apiToken) });
  const vtt = await response.text();
  if (!response.ok) throw new Error(vtt || `字幕下载失败（${response.status}）`);
  await forwardToTab(state.tabId, { type: "SUBTITLE_READY", tabId: state.tabId, vtt }, state.frameId);
  await forwardToTab(state.tabId, { type: "JOB_STATUS", tabId: state.tabId, status: "ready", progress: 1 }, state.frameId);
}

async function createJob({ serverUrl, apiToken, pageUrl, sourceUrl, filename }) {
  let response;
  try {
    response = await fetch(`${serverUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(apiToken) },
      body: JSON.stringify({ pageUrl, sourceUrl, filename })
    });
  } catch {
    throw new Error("Koe 本地助手未启动。请先运行本地安装程序。");
  }
  return parseResponse(response, "创建分析任务失败");
}

async function getJob(serverUrl, apiToken, jobId) {
  const response = await fetch(`${String(serverUrl).replace(/\/+$/, "")}/api/jobs/${jobId}`, { headers: authHeaders(apiToken) });
  return parseResponse(response, "读取分析任务失败");
}

async function failJob(tabId, error) {
  const state = tabStates.get(tabId);
  if (!state) return;
  state.status = "error";
  await forwardToTab(tabId, { type: "CAPTURE_ERROR", tabId, error: error instanceof Error ? error.message : String(error) }, state.frameId);
}

async function stopAnalysis(tabId) {
  const state = tabStates.get(tabId);
  stopPolling(tabId);
  tabStates.delete(tabId);
  await forwardToTab(tabId, { type: "JOB_STATUS", tabId, status: "idle", progress: 0 }, state?.frameId);
  return { ok: true, state: { status: "idle" } };
}

function stopPolling(tabId) {
  const timer = pollers.get(tabId);
  if (timer) clearInterval(timer);
  pollers.delete(tabId);
}

async function listVideos(tabId) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => [...document.querySelectorAll("video")].map((video, index) => {
      const current = video.currentSrc || video.src || video.querySelector("source")?.src || "";
      return {
        index,
        pageUrl: location.href,
        hasVideo: true,
        sourceUrl: /^https?:/i.test(current) ? current : "",
        filename: document.title || "video",
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1_000) : null,
        width: Number(video.videoWidth || 0),
        height: Number(video.videoHeight || 0)
      };
    })
  });
  const videos = [];
  for (const frame of frames) {
    for (const video of frame.result || []) {
      videos.push({ ...video, frameId: frame.frameId });
    }
  }
  return { ok: true, videos };
}

async function discoverVideoSource(tabId, pageUrl, selection) {
  const { videos } = await listVideos(tabId);
  const source = selection
    ? videos.find((video) => `${video.frameId}:${video.index}` === selection)
    : [...videos].sort((left, right) => videoScore(right) - videoScore(left))[0];
  return source ? { ...source, pageUrl: pageUrl || source.pageUrl } : { hasVideo: false };
}

function videoScore(video) {
  return (video.sourceUrl ? 1_000_000_000 : 0) + Number(video.width || 0) * Number(video.height || 0);
}

async function ensureContentScript(tabId, frameId = 0) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" }, { frameId });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
  }
}

async function forwardToTab(tabId, message, frameId = 0) {
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId: Number(frameId) || 0 }); } catch { return { ok: false, ignored: true }; }
}

function publicState(state) {
  return { status: state.status, jobId: state.jobId, startedAt: state.startedAt, progress: state.progress };
}

async function parseResponse(response, fallback) {
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error("Koe API Token 不正确。请填写服务器的 KOE_API_TOKEN，不要填写 DashScope API Key。");
  }
  if (!response.ok) throw new Error(body.error || `${fallback}（${response.status}）`);
  return body;
}

function authHeaders(apiToken) {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}
