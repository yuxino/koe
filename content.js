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
    </style>
    <div class="stage" aria-live="polite" aria-atomic="true">
      <div class="eyebrow"><span class="dot"></span><span class="label">KOE · READY</span></div>
      <div class="card"><p class="translated"></p><p class="original"></p><div class="meta"></div></div>
    </div>
  `;

  const stage = shadow.querySelector(".stage");
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
        analysisDone = false;
        autoPlayedPartial = false;
      }
      if (message.status === "ready") {
        subtitleReady = true;
        analysisDone = true;
      }
      if (message.status === "idle") {
        subtitleReady = false;
        analysisDone = false;
        autoPlayedPartial = false;
        showingCue = false;
        hide();
      }
      return false;
    }
    if (message.type === "SUBTITLE_READY") {
      cues = parseVtt(message.vtt || "");
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
      cues = parseVtt(message.vtt || "");
      subtitleReady = true;
      if (cues.length) tryAutoPlay();
      startSubtitleClock();
      refreshNativeTrack();
      return false;
    }
    if (message.type === "CAPTURE_ERROR") {
      showStatus("视频分析失败", message.error || "请检查视频来源和服务配置。", "ERROR");
      return false;
    }
    return false;
  });

  let lastSeekAt = 0;
  document.addEventListener("seeked", () => {
    const video = activeVideo || findVideo();
    if (!video) return;
    const now = Date.now();
    if (now - lastSeekAt < 1_500) return;
    lastSeekAt = now;
    cues = [];
    showingCue = false;
    hide();
    chrome.runtime.sendMessage({ type: "SEEK_PRIORITIZE", timeMs: Math.round(video.currentTime * 1_000) }).catch(() => undefined);
  }, true);

  // 自动分析：打开/刷新页面时通知后台
  chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  window.setTimeout(() => {
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, 3_000);
  let lastPlayReadyAt = 0;
  document.addEventListener("play", () => {
    const now = Date.now();
    if (now - lastPlayReadyAt < 2_000) return;
    lastPlayReadyAt = now;
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, true);

  // 视频切换：清掉旧字幕并通知后台
  document.addEventListener("emptied", () => {
    cues = [];
    subtitleReady = false;
    analysisDone = false;
    autoPlayedPartial = false;
    showingCue = false;
    hide();
    chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" }).catch(() => undefined);
  }, true);

  function tryAutoPlay() {
    const now = Date.now();
    if (now - lastAutoPlayAt < 5_000) return;
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
    const main = videos
      .filter((video) => Number(video.videoWidth) >= 320 && Number(video.videoHeight) >= 180)
      .sort((left, right) => (right.videoWidth * right.videoHeight) - (left.videoWidth * left.videoHeight))[0];
    return main || videos
      .sort((left, right) => (right.videoWidth * right.videoHeight) - (left.videoWidth * left.videoHeight))[0] || null;
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
      activeVideo ||= findVideo();
      if (!activeVideo) return;
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
    translated.textContent = value;
    original.textContent = "";
    meta.textContent = detail;
    label.textContent = `KOE · ${mode}`;
    stage.classList.toggle("compact", mode === "ANALYZING");
    stage.classList.add("visible");
  }

  function show(cue, detail, mode) {
    translated.textContent = cue.translated || cue.original || "";
    original.textContent = "";
    meta.textContent = detail;
    label.textContent = `KOE · ${mode}`;
    stage.classList.toggle("compact", !cue.translated);
    stage.classList.add("visible");
  }

  function hide() {
    stage.classList.remove("visible");
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
