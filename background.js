const tabStates = new Map();
const pollers = new Map();
const recoveryAttempts = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const state = tabStates.get(tabId);
  if (state) void cancelJob(state);
  tabStates.delete(tabId);
  recoveryAttempts.delete(tabId);
  stopPolling(tabId);
});

async function handleMessage(message, sender) {
  if (message.type === "ANALYZE_VIDEO") return analyzeVideo({ ...message, tabId: message.tabId ?? sender?.tab?.id });
  if (message.type === "WATCH_JOB") return watchJob(message);
  if (message.type === "STOP_ANALYSIS") return stopAnalysis(Number(message.tabId));
  if (message.type === "LIST_VIDEOS") return listVideos(Number(message.tabId));
  if (message.type === "SEEK_PRIORITIZE") return seekPrioritize(Number(message.tabId), Number(message.timeMs));
  if (message.type === "PAGE_READY") return handlePageReady(message, sender);
  if (message.type === "VIDEO_CHANGED") return handleVideoChanged(sender);
  if (message.type === "POSITION_UPDATE") return handlePositionUpdate(message, sender);
  if (message.type === "GET_STATE") {
    const state = tabStates.get(Number(message.tabId));
    return { ok: true, state: state ? publicState(state) : { status: "idle" } };
  }
  return { ok: true };
}

async function handleVideoChanged(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, skipped: true };
  if (tabStates.has(tabId)) await stopAnalysis(tabId);
  let auto;
  let translate;
  try {
    ({ koeAutoAnalyze: auto, koeTranslate: translate } = await chrome.storage.local.get(["koeAutoAnalyze", "koeTranslate"]));
  } catch {
    auto = undefined;
  }
  const pageUrl = String(sender.tab?.url || "");
  if (!/^https?:/i.test(pageUrl)) return { ok: true, skipped: true };
  if (!resolveAutoPreference(auto, pageUrl)) return { ok: true, skipped: true };
  try {
    return await analyzeVideo({ tabId, serverUrl: LOCAL_SERVER_URL, apiToken: "", pageUrl, translate });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handlePositionUpdate(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, ignored: true };
  const state = tabStates.get(tabId);
  if (!state?.jobId || !Number.isFinite(Number(message.timeMs))) return { ok: true, ignored: true };
  const timeMs = Math.max(0, Number(message.timeMs));
  if (Math.abs(timeMs - (state.lastPositionMs || 0)) < 1_000) return { ok: true, ignored: true };
  state.lastPositionMs = timeMs;
  try {
    await fetch(`${state.serverUrl}/api/jobs/${state.jobId}/position`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(state.apiToken) },
      body: JSON.stringify({ timeMs, playing: Boolean(message.playing) })
    });
  } catch {
    // 本地助手旧版本没有 position 接口时静默跳过
  }
  return { ok: true };
}

async function handlePageReady(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { ok: true, skipped: true };
  let auto;
  let translate;
  try {
    ({ koeAutoAnalyze: auto, koeTranslate: translate } = await chrome.storage.local.get(["koeAutoAnalyze", "koeTranslate"]));
  } catch {
    auto = undefined;
  }
  if (tabStates.has(tabId)) return { ok: true, skipped: true };
  const pageUrl = String(sender.tab?.url || "");
  if (!/^https?:/i.test(pageUrl)) return { ok: true, skipped: true };
  if (!resolveAutoPreference(auto, pageUrl)) return { ok: true, skipped: true };
  try {
    return await analyzeVideo({ tabId, serverUrl: LOCAL_SERVER_URL, apiToken: "", pageUrl, translate });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function analyzeVideo({ tabId, serverUrl, apiToken, pageUrl, selection, translate, startMs }) {
  tabId = Number(tabId);
  if (!Number.isInteger(tabId)) throw new Error("没有找到当前标签页。");
  if (translate === undefined) {
    try {
      ({ koeTranslate: translate } = await chrome.storage.local.get("koeTranslate"));
    } catch {
      translate = undefined;
    }
  }
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
    filename: source.filename || "video",
    durationMs: source.durationMs || null,
    translate,
    startMs: Number(startMs) || 0
  });
  return beginWatching({ tabId, frameId: source.frameId, serverUrl, apiToken, job, pageUrl: jobPageUrl, selection, translate });
}

async function watchJob({ tabId, frameId, serverUrl, apiToken, jobId }) {
  const job = await getJob(serverUrl, apiToken, jobId);
  return beginWatching({ tabId: Number(tabId), frameId: Number(frameId) || 0, serverUrl, apiToken, job });
}

async function beginWatching({ tabId, frameId = 0, serverUrl, apiToken, job, pageUrl = "", selection = null, translate }) {
  stopPolling(tabId);
  const previous = tabStates.get(tabId);
  if (previous?.jobId && previous.jobId !== job.id) void cancelJob(previous);
  const state = {
    tabId,
    frameId,
    status: job.status === "ready" ? "ready" : "analyzing",
    jobId: job.id,
    serverUrl: String(serverUrl || "").replace(/\/+$/, ""),
    apiToken: String(apiToken || ""),
    startedAt: Date.now(),
    progress: Number(job.progress || 0),
    jobStatus: job.status || "analyzing",
    stageDetail: job.stageDetail || "",
    hasDuration: Boolean(job.hasDuration),
    fromCache: Boolean(job.fromCache),
    lastPartialVtt: "",
    pageUrl,
    selection,
    translate,
    retried: false
  };
  tabStates.set(tabId, state);
  await forwardToTab(tabId, { type: "JOB_STATUS", tabId, status: state.status, progress: state.progress, jobStatus: state.jobStatus, stageDetail: state.stageDetail, hasDuration: state.hasDuration, startedAt: state.startedAt }, frameId);
  if (job.status === "ready") await publishReady(state);
  else pollers.set(tabId, setInterval(() => pollJob(tabId).catch((error) => failJob(tabId, error)), 500));
  return { ok: true, state: publicState(state) };
}

async function pollJob(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return stopPolling(tabId);
  const job = await getJob(state.serverUrl, state.apiToken, state.jobId);
  state.progress = Number(job.progress || 0);
  state.jobStatus = job.status || state.jobStatus;
  state.stageDetail = job.stageDetail || "";
  state.hasDuration = Boolean(job.hasDuration);
  if (job.status === "ready") {
    stopPolling(tabId);
    recoveryAttempts.delete(tabId);
    state.status = "ready";
    await publishReady(state);
    return;
  }
  if (job.status === "error") {
    stopPolling(tabId);
    if (!state.retried && /过期|被拦截|没有可提取的音轨|does not contain any stream|403/i.test(job.error || "")) {
      state.retried = true;
      try {
        return await analyzeVideo({
          tabId,
          serverUrl: state.serverUrl,
          apiToken: state.apiToken,
          pageUrl: state.pageUrl,
          selection: state.selection,
          translate: state.translate
        });
      } catch {
        // 页面可能已关闭，保留原始错误
      }
    }
    return failJob(tabId, new Error(job.error || "视频分析失败。"));
  }
  state.status = "analyzing";
  await forwardToTab(tabId, { type: "JOB_STATUS", tabId, status: state.status, progress: state.progress, jobStatus: job.status, stageDetail: state.stageDetail, hasDuration: state.hasDuration, startedAt: state.startedAt }, state.frameId);
  void pollPartial(state);
}

async function pollPartial(state) {
  try {
    const response = await fetch(`${state.serverUrl}/api/jobs/${state.jobId}/partial`, { headers: authHeaders(state.apiToken) });
    if (!response.ok) return;
    const partial = await response.json();
    if (partial?.vtt && partial.vtt !== state.lastPartialVtt) {
      state.lastPartialVtt = partial.vtt;
      await forwardToTab(state.tabId, { type: "PARTIAL_SUBTITLES", vtt: partial.vtt, lineCount: Number(partial.lineCount || 0) }, state.frameId);
    }
  } catch {
    // 本地助手旧版本没有 /partial 接口时静默跳过
  }
}

async function seekPrioritize(tabId, timeMs) {
  const state = tabStates.get(tabId);
  if (!state?.jobId) return { ok: true, ignored: true };
  stopPolling(tabId);
  try {
    void cancelJob(state);
    const source = await discoverVideoSource(tabId, state.pageUrl, undefined);
    if (!source?.hasVideo) return { ok: true, ignored: true };
    const job = await createJob({
      serverUrl: state.serverUrl,
      apiToken: state.apiToken,
      pageUrl: state.pageUrl || source.pageUrl,
      sourceUrl: source.sourceUrl || "",
      filename: source.filename || "video",
      durationMs: source.durationMs || null,
      translate: state.translate,
      startMs: Math.max(0, Number(timeMs) || 0)
    });
    return beginWatching({
      tabId,
      frameId: source.frameId,
      serverUrl: state.serverUrl,
      apiToken: state.apiToken,
      job,
      pageUrl: state.pageUrl || source.pageUrl,
      selection: state.selection,
      translate: state.translate
    });
  } catch {
    // 重新发现失败时保留原任务
    return { ok: true, ignored: true };
  }
}

async function publishReady(state) {
  const response = await fetch(`${state.serverUrl}/api/jobs/${state.jobId}/vtt`, { headers: authHeaders(state.apiToken) });
  const vtt = await response.text();
  if (!response.ok) throw new Error(vtt || `字幕下载失败（${response.status}）`);
  await forwardToTab(state.tabId, { type: "SUBTITLE_READY", tabId: state.tabId, vtt }, state.frameId);
  await forwardToTab(state.tabId, { type: "JOB_STATUS", tabId: state.tabId, status: "ready", progress: 1 }, state.frameId);
}

async function createJob({ serverUrl, apiToken, pageUrl, sourceUrl, filename, durationMs, translate, startMs }) {
  let response;
  try {
    response = await fetch(`${serverUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(apiToken) },
      body: JSON.stringify({ pageUrl, sourceUrl, filename, durationMs, translate, startMs })
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
  stopPolling(tabId);
  state.status = "error";
  const message = error instanceof Error ? error.message : String(error);
  await forwardToTab(tabId, { type: "CAPTURE_ERROR", tabId, error: message }, state.frameId);
  const transient = /job_not_found|fetch failed|未启动|ECONNREFUSED|EAI_AGAIN|network/i.test(message);
  const attempts = (recoveryAttempts.get(tabId) || 0) + 1;
  recoveryAttempts.set(tabId, attempts);
  if (transient && attempts <= 2 && !state.recoveryScheduled) {
    state.recoveryScheduled = true;
    setTimeout(() => {
      const current = tabStates.get(tabId);
      if (!current || current.status !== "error") return;
      analyzeVideo({
        tabId,
        serverUrl: current.serverUrl,
        apiToken: current.apiToken,
        pageUrl: current.pageUrl,
        selection: current.selection,
        translate: current.translate
      }).catch(() => undefined);
    }, 2_000);
  }
}

async function stopAnalysis(tabId) {
  const state = tabStates.get(tabId);
  stopPolling(tabId);
  tabStates.delete(tabId);
  if (state) void cancelJob(state);
  await forwardToTab(tabId, { type: "JOB_STATUS", tabId, status: "idle", progress: 0 }, state?.frameId);
  return { ok: true, state: { status: "idle" } };
}

async function cancelJob(state) {
  if (!state?.serverUrl || !state?.jobId) return;
  try {
    await fetch(`${state.serverUrl}/api/jobs/${state.jobId}/cancel`, {
      method: "POST",
      headers: authHeaders(state.apiToken)
    });
  } catch {
    // 本地助手旧版本没有 cancel 接口时静默跳过
  }
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
      let sourceUrl = /^https?:/i.test(current) ? current : "";
      if (!sourceUrl || sourceUrl === location.href) {
        sourceUrl = findPageMediaUrl();
      }
      return {
        index,
        pageUrl: location.href,
        hasVideo: true,
        sourceUrl,
        filename: document.title || "video",
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1_000) : null,
        width: Number(video.videoWidth || 0),
        height: Number(video.videoHeight || 0),
        playing: Boolean(!video.paused && video.readyState >= 2),
        currentTimeMs: Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1_000) : 0,
        muted: Boolean(video.muted)
      };

      function findPageMediaUrl() {
        try {
          const text = [...document.scripts].map((script) => script.textContent || "").join("\n");
          const unescapeUrl = (value) => String(value || "")
            .replace(/\\\//g, "/")
            .replace(/&amp;/g, "&")
            .replace(/\\u0026/g, "&")
            .replace(/\\u0022/g, '"');
          const masters = text.match(/https?:\\?\/\\?\/[^"'\s<>]+?master\.m3u8[^"'\s<>]*/g) || [];
          if (masters.length) {
            const picked = [...masters].sort((left, right) => (
              (bitrateOf(left) - bitrateOf(right)) || (resolutionOf(left) - resolutionOf(right))
            ))[0];
            return unescapeUrl(picked);
          }
          const hls = text.match(/https?:\\?\/\\?\/[^"'\s<>]+?\.m3u8[^"'\s<>]*/);
          if (hls) return unescapeUrl(hls[0]);
          const mp4s = text.match(/https?:\\?\/\\?\/[^"'\s<>]+?\.mp4[^"'\s<>]*/g) || [];
          const video = mp4s.find((url) => !/thumb|poster|preview|sprite/i.test(url));
          if (video) return unescapeUrl(video);
        } catch {
          return "";
        }
        return "";
      }

      function bitrateOf(url) {
        const match = String(url).match(/(\d+)K/i);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
      }

      function resolutionOf(url) {
        const match = String(url).match(/(\d+)P/i);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
      }
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
  let source = null;
  if (selection) {
    source = videos.find((video) => `${video.frameId}:${video.index}` === selection);
  } else {
    const scored = [...videos].sort((left, right) => videoScore(right) - videoScore(left));
    source = scored.find((video) => isUsableMediaSource(video)) || scored[0];
  }
  return source ? { ...source, pageUrl: pageUrl || source.pageUrl } : { hasVideo: false };
}

function isUsableMediaSource(video) {
  if (!video.sourceUrl) return false;
  try {
    const source = new URL(video.sourceUrl);
    const page = new URL(video.pageUrl || "");
    return !(source.hostname === page.hostname && source.pathname === page.pathname);
  } catch {
    return true;
  }
}

function resolveAutoPreference(preference, pageUrl) {
  return preference === true;
}

function videoScore(video) {
  if (isAdSource(video.sourceUrl || "")) return -1_000_000_000_000;
  let score = video.sourceUrl ? 1_000_000_000 : 0;
  if (Number(video.width) > 0 && (Number(video.width) < 320 || Number(video.height) < 180)) {
    score -= 500_000_000;
  }
  score += Math.min(Number(video.durationMs || 0) / 1_000, 600) * 100;
  if (video.playing) score += 100_000;
  if (Number(video.currentTimeMs || 0) > 0) score += 10_000;
  if (video.muted) score -= 10_000;
  return score;
}

function isAdSource(sourceUrl) {
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, "");
    return AD_HOSTS.some((pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`));
  } catch {
    return false;
  }
}

const AD_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "outbrain.com",
  "taboola.com",
  "adnxs.com",
  "adsrvr.org",
  "criteo.com",
  "amazon-adsystem.com",
  "rubiconproject.com",
  "appnexus.com",
  "pubmatic.com",
  "openx.net",
  "casalemedia.com",
  "smartadserver.com",
  "mopub.com",
  "adcolony.com",
  "yieldmo.com",
  "sharethrough.com",
  "districtm.io",
  "adform.net",
  "indexww.com",
  "sovrn.com",
  "spotx.tv",
  "instreamatic.com",
  "adroll.com",
  "quantserve.com",
  "scorecardresearch.com",
  "krxd.net",
  "moatads.com",
  "serving-sys.com",
  "contextweb.com",
  "lijit.com",
  "tribalfusion.com",
  "media.net",
  "adtech.com",
  "advertising.com",
  "z5x.net",
  "ad-srv.net",
  "adserver.com"
];

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
  return { status: state.status, jobId: state.jobId, startedAt: state.startedAt, progress: state.progress, jobStatus: state.jobStatus, stageDetail: state.stageDetail, hasDuration: Boolean(state.hasDuration), fromCache: Boolean(state.fromCache) };
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
