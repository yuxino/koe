(() => {
  if (window.__koeCaptionLoaded) return;
  window.__koeCaptionLoaded = true;

  const host = document.createElement("div");
  host.id = "koe-caption-host";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .stage { position: fixed; left: 50%; bottom: 5vh; transform: translate(-50%, 12px); opacity: 0; transition: opacity .28s ease, transform .28s ease; max-width: min(820px, 78vw); text-align: center; color: #fbf4df; font-family: Georgia, 'Songti SC', serif; }
      .stage.visible { opacity: 1; transform: translate(-50%, 0); }
      .eyebrow { display: none; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: #c5d865; box-shadow: 0 0 0 4px rgba(197, 216, 101, .14); }
      .card { padding: 15px 24px 17px; border: 1px solid rgba(255, 248, 224, .18); border-radius: 14px; background: linear-gradient(135deg, rgba(20, 29, 25, .94), rgba(43, 49, 37, .84)); box-shadow: 0 18px 60px rgba(0, 0, 0, .32); }
      .translated { margin: 0; font-size: 20px; line-height: 1.3; letter-spacing: .02em; text-shadow: 0 2px 14px rgba(0, 0, 0, .5); }
      .original { margin: 5px 0 0; font-size: 14px; line-height: 1.25; color: rgba(251, 244, 223, .92); letter-spacing: .02em; text-shadow: 0 1px 10px rgba(0, 0, 0, .5); }
      .meta { display: none; }
      .stage.compact .card { padding: 8px 15px 9px; border-radius: 10px; box-shadow: 0 10px 32px rgba(0, 0, 0, .26); }
      .stage.compact .translated { font-size: 13px; }
      .loading { display: none; padding: 8px 16px; border-radius: 99px; background: rgba(25, 35, 30, .55); color: rgba(251, 244, 223, .8); font: 500 13px/1.4 Georgia, 'Songti SC', serif; letter-spacing: .08em; backdrop-filter: blur(10px); animation: koe-pulse 1.6s ease-in-out infinite; }
      .loading.visible { display: inline-block; }
      @keyframes koe-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
      .orb { position: fixed; right: 18px; bottom: 18px; width: 46px; height: 46px; display: none; align-items: center; justify-content: center; border-radius: 50%; border: 1px solid rgba(255, 248, 224, .3); background: radial-gradient(circle at 32% 28%, rgba(70, 86, 73, .98), rgba(24, 32, 28, .96)); color: #f6efd9; cursor: pointer; box-shadow: 0 10px 32px rgba(0, 0, 0, .45); pointer-events: auto; z-index: 1; user-select: none; touch-action: none; }
      .orb:hover { filter: brightness(1.15); }
      .orb.visible { display: flex; }
      .orb svg { width: 22px; height: 22px; }
      .orb.analyzing::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid transparent; border-top-color: #cbdc77; animation: koe-spin 1s linear infinite; }
      .orb.ready { border-color: rgba(203, 220, 119, .6); }
      @keyframes koe-spin { to { transform: rotate(360deg); } }
    </style>
    <div class="stage" aria-live="polite" aria-atomic="true">
      <div class="eyebrow"><span class="dot"></span><span class="label">KOE · READY</span></div>
      <div class="card"><p class="translated"></p><p class="original"></p><div class="meta"></div></div>
      <div class="loading">字幕加载中…</div>
    </div>
    <div class="orb" role="button" aria-label="分析字幕" title="分析字幕"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg></div>
  `;

  const stage = shadow.querySelector(".stage");
  const card = shadow.querySelector(".card");
  const loadingEl = shadow.querySelector(".loading");
  const orb = shadow.querySelector(".orb");
  const translated = shadow.querySelector(".translated");
  const original = shadow.querySelector(".original");
  const meta = shadow.querySelector(".meta");
  const label = shadow.querySelector(".label");
  let cues = [];
  let activeVideo;
  let subtitleTimer;
  let subtitleReady = false;
  let analysisDone = false;
  let showingCue = false;
  let autoPlayedPartial = false;
  let lastAutoPlayAt = 0;
  let processing = false;
  let lastErrorShown = "";
  let errorShown = false;
  let lastSeenSource = "";

  const STAGE_TEXT = {
    downloading: "正在下载 / 提取声音",
    uploading_audio: "正在上传声音",
    analyzing: "正在识别"
  };
  const STAGE_HINT = {
    downloading: "视频越大这一步越久；长时间不动通常是网站限速",
    uploading_audio: "视频不出本机，只上传音频",
    analyzing: "已识别部分即时显示 · 跳到哪优先补哪"
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "GET_VIDEO_SOURCE") {
      sendResponse(findVideoSource());
      return false;
    }
    if (message.type === "JOB_STATUS") {
      if (message.status === "analyzing") {
        errorShown = false;
        processing = true;
        analysisDone = false;
        autoPlayedPartial = false;
        updateAnalyzeButton();
        if (!subtitleTimer) startSubtitleClock();
      }
      if (message.status === "ready") {
        errorShown = false;
        processing = false;
        subtitleReady = true;
        analysisDone = true;
        updateAnalyzeButton();
      }
      if (message.status === "idle") {
        errorShown = false;
        processing = false;
        subtitleReady = false;
        analysisDone = false;
        autoPlayedPartial = false;
        showingCue = false;
        hide();
        updateAnalyzeButton();
      }
      return false;
    }
    if (message.type === "SUBTITLE_READY") {
      errorShown = false;
      processing = false;
      lastSeenSource = currentVideoSource();
      cues = acceptCues(parseVtt(message.vtt || ""));
      activeVideo = findVideo();
      subtitleReady = true;
      analysisDone = true;
      if (activeVideo) {
        const alreadyStarted = activeVideo.currentTime > 0 || !activeVideo.paused;
        if (!alreadyStarted) {
          activeVideo.currentTime = 0;
          activeVideo.play().catch(() => undefined);
        }
      }
      startSubtitleClock();
      refreshNativeTrack();
      return false;
    }
    if (message.type === "PARTIAL_SUBTITLES") {
      errorShown = false;
      lastSeenSource = currentVideoSource();
      cues = acceptCues(parseVtt(message.vtt || ""));
      subtitleReady = true;
      if (cues.length) tryAutoPlay();
      startSubtitleClock();
      refreshNativeTrack();
      return false;
    }
    if (message.type === "CAPTURE_ERROR") {
      processing = false;
      errorShown = true;
      const detail = message.error || "请检查视频来源和服务配置。";
      if (detail === lastErrorShown) return false;
      lastErrorShown = detail;
      showStatus("视频分析失败", detail, "ERROR");
      updateAnalyzeButton();
      return false;
    }
    return false;
  });

  let lastSeekAt = 0;
  document.addEventListener("seeked", () => {
    const video = (activeVideo?.isConnected ? activeVideo : null) || findVideo();
    if (!video) return;
    const now = Date.now();
    if (now - lastSeekAt < 1_500) return;
    lastSeekAt = now;
    cues = [];
    errorShown = false;
    showingCue = false;
    hide();
    chrome.runtime.sendMessage({ type: "SEEK_PRIORITIZE", timeMs: Math.round(video.currentTime * 1_000) }).catch(() => undefined);
  }, true);

  // 周期性上报播放位置，服务端据此只翻译当前位置附近的字幕
  let lastPositionSentAt = 0;
  let lastPositionSentMs = 0;
  window.setInterval(() => {
    const video = (activeVideo?.isConnected ? activeVideo : null) || findVideo();
    if (!video || video.paused) return;
    const now = Date.now();
    const timeMs = Math.round(video.currentTime * 1_000);
    if (now - lastPositionSentAt < 5_000) return;
    if (Math.abs(timeMs - lastPositionSentMs) < 1_000) return;
    lastPositionSentAt = now;
    lastPositionSentMs = timeMs;
    chrome.runtime.sendMessage({ type: "POSITION_UPDATE", timeMs, playing: !video.paused }).catch(() => undefined);
  }, 5_000);

  // 页面有视频即自动分析；按下播放也会触发（静音预览缩略图不触发，已有任务时不重复）
  chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  window.setTimeout(() => {
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, 3_000);
  let lastPlayTriggerAt = 0;
  document.addEventListener("play", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLVideoElement) || target.muted) return;
    const now = Date.now();
    if (now - lastPlayTriggerAt < 3_000) return;
    lastPlayTriggerAt = now;
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, true);

  // 视频切换：清掉旧字幕并通知后台
  document.addEventListener("emptied", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    if (activeVideo && activeVideo.isConnected && target !== activeVideo) return;
    cues = [];
    processing = false;
    errorShown = false;
    subtitleReady = false;
    analysisDone = false;
    autoPlayedPartial = false;
    showingCue = false;
    hide();
    chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" }).catch(() => undefined);
    updateAnalyzeButton();
  }, true);

  function updateAnalyzeButton() {
    const fullscreenVideo = (document.fullscreenElement || document.webkitFullscreenElement) instanceof HTMLVideoElement;
    const show = !fullscreenVideo && Boolean(findVideo());
    orb.classList.toggle("visible", show);
    orb.classList.toggle("analyzing", processing);
    orb.classList.toggle("ready", subtitleReady && !processing);
  }
  window.setInterval(updateAnalyzeButton, 1_000);
  window.setInterval(trackVideoSource, 1_000);

  function currentVideoSource() {
    const video = (activeVideo?.isConnected ? activeVideo : null) || findVideo();
    return video ? (video.currentSrc || video.src || "") : "";
  }

  function trackVideoSource() {
    const source = currentVideoSource();
    if (source) {
      if (lastSeenSource && source !== lastSeenSource) {
        lastSeenSource = source;
        cues = [];
        processing = false;
        errorShown = false;
        subtitleReady = false;
        showingCue = false;
        hide();
        chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" }).catch(() => undefined);
        return;
      }
      lastSeenSource = source;
    }
    // 视频已经在播放但还没开始分析（含静音自动播放）→ 自动触发
    const playing = (activeVideo?.isConnected ? activeVideo : null) || findVideo();
    if (playing && !playing.paused && (playing.currentSrc || playing.src) && !processing && !subtitleReady && !errorShown) {
      const now = Date.now();
      if (now - lastPlayTriggerAt >= 3_000) {
        lastPlayTriggerAt = now;
        chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
      }
    }
  }

  // 悬浮球可拖动；拖动的位移超过阈值才算拖，否则视为点击
  let orbDragging = false;
  let orbMoved = false;
  let suppressClick = false;
  let orbStartX = 0;
  let orbStartY = 0;
  let orbBaseLeft = 0;
  let orbBaseTop = 0;
  orb.addEventListener("pointerdown", (event) => {
    orbDragging = true;
    orbMoved = false;
    suppressClick = false;
    orbStartX = event.clientX;
    orbStartY = event.clientY;
    const rect = orb.getBoundingClientRect();
    orbBaseLeft = rect.left;
    orbBaseTop = rect.top;
    try { orb.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  });
  orb.addEventListener("pointermove", (event) => {
    if (!orbDragging) return;
    const dx = event.clientX - orbStartX;
    const dy = event.clientY - orbStartY;
    if (Math.abs(dx) + Math.abs(dy) > 10) {
      orbMoved = true;
      orb.style.left = `${orbBaseLeft + dx}px`;
      orb.style.top = `${orbBaseTop + dy}px`;
      orb.style.right = "auto";
      orb.style.bottom = "auto";
    }
  });
  orb.addEventListener("pointerup", () => {
    orbDragging = false;
    if (orbMoved) suppressClick = true;
  });
  orb.addEventListener("pointercancel", () => {
    orbDragging = false;
    suppressClick = true;
  });
  orb.addEventListener("click", () => {
    if (suppressClick) return;
    if (processing) return; // 分析中点击不打断
    chrome.runtime.sendMessage({ type: "ANALYZE_VIDEO", pageUrl: location.href, serverUrl: "http://127.0.0.1:8787", apiToken: "" })
      .then((response) => {
        if (response && response.ok === false) {
          errorShown = true;
          showStatus("无法分析", String(response.error || "未找到视频"), "ERROR");
        }
      })
      .catch(() => undefined);
  });

  function tryAutoPlay() {
    const now = Date.now();
    if (now - lastAutoPlayAt < 5_000) return;
    if (activeVideo && !activeVideo.isConnected) activeVideo = null;
    activeVideo ||= findVideo();
    if (!activeVideo || !activeVideo.paused || activeVideo.currentTime >= 1) return;
    lastAutoPlayAt = now;
    activeVideo.play().catch(() => undefined);
  }

  let nativeTrack = null;
  let nativeTrackVideo = null;
  document.addEventListener("fullscreenchange", syncFullscreen, true);
  document.addEventListener("webkitfullscreenchange", syncFullscreen, true);

  function syncFullscreen() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (!fullscreenElement) {
      restoreOverlayHost();
      disableNativeTrack();
      return;
    }
    if (fullscreenElement instanceof HTMLVideoElement) {
      restoreOverlayHost();
      hide();
      enableNativeTrack(fullscreenElement);
      return;
    }
    disableNativeTrack();
    if (host.parentElement !== fullscreenElement) fullscreenElement.appendChild(host);
    host.style.position = "absolute";
    host.style.inset = "0";
  }

  function restoreOverlayHost() {
    if (host.parentElement !== document.documentElement) document.documentElement.appendChild(host);
    host.style.position = "fixed";
    host.style.inset = "0";
  }

  function enableNativeTrack(video) {
    nativeTrackVideo = video;
    let track = [...(video.textTracks || [])].find((item) => item.label === "Koe");
    if (!track) track = video.addTextTrack("captions", "Koe", "zh");
    while (track.cues && track.cues.length) track.removeCue(track.cues[0]);
    for (const cue of cues) {
      try {
        const nativeText = cue.translated || cue.original;
        track.addCue(new VTTCue(cue.startMs / 1_000, Math.max(cue.endMs / 1_000, cue.startMs / 1_000 + 0.2), nativeText));
      } catch {
        // 单条失效不影响其它
      }
    }
    track.mode = "showing";
    nativeTrack = track;
  }

  function refreshNativeTrack() {
    if (nativeTrackVideo) enableNativeTrack(nativeTrackVideo);
  }

  function disableNativeTrack() {
    if (nativeTrack) nativeTrack.mode = "disabled";
    nativeTrack = null;
    nativeTrackVideo = null;
  }

  function findVideo() {
    const videos = [...document.querySelectorAll("video")];
    const score = (video) => {
      const area = Number(video.videoWidth || 0) * Number(video.videoHeight || 0);
      return area + (video.muted ? 0 : 1_000_000) + (video.paused ? 0 : 500_000);
    };
    const main = videos
      .filter((video) => Number(video.videoWidth) >= 320 && Number(video.videoHeight) >= 180 && (video.currentSrc || video.src))
      .sort((left, right) => score(right) - score(left))[0];
    return main || videos.sort((left, right) => score(right) - score(left))[0] || null;
  }

  function findVideoSource() {
    const video = findVideo();
    const current = video?.currentSrc || video?.src || video?.querySelector("source")?.src || "";
    return {
      pageUrl: location.href,
      hasVideo: Boolean(video),
      sourceUrl: current.startsWith("http") ? current : "",
      filename: document.title || "video",
      durationMs: video?.duration ? Math.round(video.duration * 1_000) : null
    };
  }

  function startSubtitleClock() {
    clearInterval(subtitleTimer);
    subtitleTimer = window.setInterval(() => {
      if (activeVideo && !activeVideo.isConnected) activeVideo = null;
      activeVideo ||= findVideo();
      if (!activeVideo) return;
      if (errorShown) return;
      const timeMs = activeVideo.currentTime * 1_000;
      const cue = cues.find((item) => timeMs >= item.startMs && timeMs < item.endMs);
      if (cue) {
        showingCue = true;
        show(cue, `KOE · ${formatTime(cue.startMs)}`, "READY");
        return;
      }
      showingCue = false;
      hide();
    }, 100);
  }

  function showStatus(value, detail, mode) {
    card.style.display = "";
    loadingEl.classList.remove("visible");
    translated.textContent = value;
    original.textContent = "";
    meta.textContent = detail;
    label.textContent = `KOE · ${mode}`;
    stage.classList.toggle("compact", mode === "ANALYZING");
    stage.classList.add("visible");
  }

  function show(cue, detail, mode) {
    card.style.display = "";
    loadingEl.classList.remove("visible");
    translated.textContent = cue.translated || cue.original || "";
    original.textContent = "";
    meta.textContent = detail;
    label.textContent = `KOE · ${mode}`;
    stage.classList.toggle("compact", !cue.translated);
    stage.classList.add("visible");
  }

  function hide() {
    stage.classList.remove("visible");
    loadingEl.classList.remove("visible");
  }

  function showLoading() {
    card.style.display = "none";
    loadingEl.classList.add("visible");
    stage.classList.add("visible");
  }

  function parseVtt(value) {
    return String(value).replace(/^WEBVTT\s*/, "").split(/\n\s*\n/).map((cue) => {
      const lines = cue.trim().split(/\r?\n/);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return null;
      const [start, end] = lines[timingIndex].split("-->").map((item) => item.trim().split(" ")[0]);
      const bodyLines = lines.slice(timingIndex + 1).map((item) => item.trim()).filter(Boolean);
      return {
        startMs: parseVttTime(start),
        endMs: parseVttTime(end),
        original: bodyLines[0] || "",
        translated: bodyLines[1] || ""
      };
    }).filter((cue) => cue && (cue.original || cue.translated) && cue.endMs > cue.startMs);
  }

  // 双语模式下只显示中文：只要存在翻译，就过滤掉只有原文的实时草稿（原文隐藏）
  function acceptCues(parsed) {
    const hasTranslation = parsed.some((cue) => Boolean(cue.translated));
    return hasTranslation ? parsed.filter((cue) => Boolean(cue.translated)) : parsed;
  }

  function parseVttTime(value) {
    const match = String(value || "").match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
    if (!match) return 0;
    return ((Number(match[1] || 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000 + Number(match[4]);
  }

  function formatTime(value) {
    const total = Math.max(0, Math.round(Number(value || 0) / 1_000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }
})();
