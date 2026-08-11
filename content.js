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
      .stage { position: fixed; left: 50%; bottom: 9vh; transform: translate(-50%, 12px); opacity: 0; transition: opacity .28s ease, transform .28s ease; max-width: min(820px, 78vw); text-align: center; color: #fbf4df; font-family: Georgia, 'Songti SC', serif; }
      .stage.visible { opacity: 1; transform: translate(-50%, 0); }
      .eyebrow { display: inline-flex; align-items: center; gap: 7px; margin-bottom: 9px; padding: 5px 10px; border: 1px solid rgba(242, 226, 181, .28); border-radius: 99px; background: rgba(25, 35, 30, .72); color: #d8e58c; font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .13em; text-transform: uppercase; backdrop-filter: blur(14px); }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: #c5d865; box-shadow: 0 0 0 4px rgba(197, 216, 101, .14); }
      .card { padding: 15px 24px 17px; border: 1px solid rgba(255, 248, 224, .18); border-radius: 14px; background: linear-gradient(135deg, rgba(20, 29, 25, .94), rgba(43, 49, 37, .84)); box-shadow: 0 18px 60px rgba(0, 0, 0, .32); }
      .text { margin: 0; font-size: clamp(19px, 2.2vw, 30px); line-height: 1.34; letter-spacing: .03em; text-shadow: 0 2px 16px rgba(0, 0, 0, .38); white-space: pre-line; }
      .meta { margin-top: 9px; color: rgba(251, 244, 223, .56); font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; }
    </style>
    <div class="stage" aria-live="polite" aria-atomic="true">
      <div class="eyebrow"><span class="dot"></span><span class="label">KOE · READY</span></div>
      <div class="card"><p class="text"></p><div class="meta"></div></div>
    </div>
  `;

  const stage = shadow.querySelector(".stage");
  const text = shadow.querySelector(".text");
  const meta = shadow.querySelector(".meta");
  const label = shadow.querySelector(".label");
  let cues = [];
  let activeVideo;
  let subtitleTimer;
  let subtitleReady = false;
  let analysisDone = false;

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
        const percent = Math.round(Number(message.progress || 0) * 100);
        const elapsed = message.startedAt
          ? Math.max(1, Math.round((Date.now() - Number(message.startedAt)) / 1_000))
          : null;
        if (message.jobStatus === "downloading") {
          const timeText = elapsed ? `已用时 ${elapsed} 秒 · ` : "";
          if (!message.hasDuration) {
            showStatus("正在下载 / 提取声音…", `${timeText}视频越大这一步越久`, "ANALYZING");
          } else {
            showStatus(`正在下载 / 提取声音 ${percent}%`, `${timeText}视频越大这一步越久`, "ANALYZING");
          }
        } else {
          const stage = STAGE_TEXT[message.jobStatus] || "正在分析视频";
          const hint = message.stageDetail || STAGE_HINT[message.jobStatus] || "字幕将在整段分析完成后出现";
          showStatus(`${stage} ${percent}%`, hint, "ANALYZING");
        }
      }
      if (message.status === "ready") {
        subtitleReady = true;
        analysisDone = true;
        showStatus("字幕已就绪", "点击播放后自动显示字幕", "READY");
      }
      if (message.status === "idle") {
        subtitleReady = false;
        analysisDone = false;
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
          activeVideo.play().catch(() => showStatus("字幕已就绪", "请点击视频播放", "READY"));
        } else {
          showStatus("字幕已就绪", "已补全当前进度", "READY");
        }
      } else {
        showStatus("字幕已就绪", "请回到视频页面", "READY");
      }
      startSubtitleClock();
      refreshNativeTrack();
      return false;
    }
    if (message.type === "PARTIAL_SUBTITLES") {
      cues = parseVtt(message.vtt || "");
      subtitleReady = true;
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
    chrome.runtime.sendMessage({ type: "SEEK_PRIORITIZE", timeMs: Math.round(video.currentTime * 1_000) }).catch(() => undefined);
  }, true);

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
        track.addCue(new VTTCue(cue.startMs / 1_000, Math.max(cue.endMs / 1_000, cue.startMs / 1_000 + 0.2), cue.text));
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
    return [...document.querySelectorAll("video")]
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
      if (!activeVideo || !cues.length) return;
      const timeMs = activeVideo.currentTime * 1_000;
      const cue = cues.find((item) => timeMs >= item.startMs && timeMs < item.endMs);
      if (cue) show(cue.text, `KOE · ${formatTime(cue.startMs)}`, "READY");
      else if (activeVideo.paused && analysisDone) showStatus("字幕已就绪", "点击播放后自动显示字幕", "READY");
      else hide();
    }, 100);
  }

  function showStatus(value, detail, mode) {
    text.textContent = value;
    meta.textContent = detail;
    label.textContent = `KOE · ${mode}`;
    stage.classList.add("visible");
  }

  function show(value, detail, mode) {
    showStatus(value, detail, mode);
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
      return { startMs: parseVttTime(start), endMs: parseVttTime(end), text: lines.slice(timingIndex + 1).join("\n").trim() };
    }).filter((cue) => cue && cue.text && cue.endMs > cue.startMs);
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
