(() => {
  // 版本号动态读 manifest：扩展更新/重载后新副本版本号不同，
  // 旧副本检测到 __koeLoaded 变化会自行停用，不会残留失效上下文。
  const CONTENT_VERSION = chrome.runtime.getManifest().version;
  if (window.__koeLoaded === CONTENT_VERSION) return;
  window.__koeLoaded = CONTENT_VERSION;

  // 扩展上下文失效（重载/禁用）时 chrome.runtime.sendMessage 会同步 throw，
  // promise 的 .catch 挡不住——统一走安全封装，避免控制台报错
  function safeSend(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      return undefined;
    }
  }

  let lastSeenSource = "";
  let lastSeenUrl = location.href;
  let lastPageReadyAt = 0;
  let activeSession = null;
  let overlayHost = null;
  let overlayOriginal = null;
  let overlayTranslation = null;
  let overlayNotice = null;
  let overlayNoticeTitle = null;
  let overlayNoticeDetail = null;
  let noticeJobId = "";
  let noticeMediaEpoch = 0;
  let overlayEnabled = true;
  let overlaySize = "medium";
  let hideOriginal = false;
  let overlayHideTimer = null;
  let lastDraftSeq = 0;
  let lastUnitSeq = 0;
  let finalOriginal = "";
  let draftOriginal = "";
  let finalTranslatedText = "";
  let draftTranslatedText = "";
  let translatedSeq = 0;
  let visibleUnitSeq = 0;
  let awaitingMediaReset = false;
  const pendingUnitTranslations = new Map();
  let offlineCues = [];
  let offlineRevision = 0;
  let visibleOfflineCueId = "";
  let offlineFrameRequest = 0;
  let lastMediaContextAt = 0;
  let mediaDiscontinuityId = 0;
  let mediaResourceFloor = 0;
  let inlineHlsDefinitions = null;
  let inlineHlsScannedAt = 0;
  const CAPTION_SENTENCE_ENDINGS = new Set(["。", "！", "？", "!", "?", "；", ";", "\n"]);
  const CAPTION_PREFERRED_BREAKS = new Set(["，", "、", ",", "：", ":", "—", "–", "-", " "]);

  try {
    chrome.runtime.onMessage.addListener((message) => {
      handleLiveMessage(message);
      return false;
    });
  } catch {
    // 扩展上下文失效时等待新版本内容脚本接管。
  }

  void loadOverlayPreferences();
  try {
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes.koeOverlayEnabled) overlayEnabled = changes.koeOverlayEnabled.newValue !== false;
      if (changes.koeOverlaySize) overlaySize = normalizeOverlaySize(changes.koeOverlaySize.newValue);
      if (changes.koeHideOriginal) hideOriginal = changes.koeHideOriginal.newValue !== false;
      applyOverlayPreferences();
    });
  } catch {
    // storage 监听不可用时保持本次页面加载时的偏好。
  }

  // 页面加载即通知后台；加载慢则每 3 秒重试（最多 10 次）
  safeSend({ type: "PAGE_READY" });
  let pageReadyAttempts = 0;
  window.setInterval(() => {
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：停止工作
    if (pageReadyAttempts >= 10) return;
    pageReadyAttempts += 1;
    safeSend({ type: "PAGE_READY" });
  }, 3_000);

  document.addEventListener("play", (event) => {
    if (window.__koeLoaded !== CONTENT_VERSION) return;
    const target = event.target;
    if (!(target instanceof HTMLVideoElement) || target.muted) return;
    const now = Date.now();
    if (now - lastPageReadyAt < 3_000) return;
    lastPageReadyAt = now;
    safeSend({ type: "PAGE_READY" });
  }, true);

  document.addEventListener("emptied", (event) => {
    if (window.__koeLoaded !== CONTENT_VERSION) return;
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    freezeForSourceChange();
    safeSend({ type: "VIDEO_CHANGED", pageUrl: location.href });
  }, true);

  // 周期检测：源/URL 变化 → 通知后台重连识别；正在播放且未静音 → 触发实时字幕
  window.setInterval(trackVideoSource, 1_000);
  window.setInterval(positionOverlay, 500);
  function trackVideoSource() {
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：停止工作
    handleUrlChange();
    const video = findVideo();
    const source = video ? (video.currentSrc || video.src || "") : "";
    if (video && activeSession?.mode === "offline" && Date.now() - lastMediaContextAt >= 2_000) {
      reportMediaContext(video);
    }
    if (source && source !== lastSeenSource) {
      const hadSource = Boolean(lastSeenSource);
      lastSeenSource = source;
      if (hadSource) freezeForSourceChange();
      safeSend({ type: "VIDEO_CHANGED", pageUrl: location.href });
      return;
    }
    if (video && !video.paused && !video.muted && video.readyState >= 2) {
      const now = Date.now();
      if (now - lastPageReadyAt >= 3_000) {
        lastPageReadyAt = now;
        safeSend({ type: "PAGE_READY" });
      }
    }
  }

  // URL 变化感知（SPA 切视频/页面跳转）：历史 API、popstate、每秒兜底比对
  function handleUrlChange() {
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：停止工作
    if (location.href === lastSeenUrl) return;
    lastSeenUrl = location.href;
    freezeForSourceChange();
    safeSend({ type: "VIDEO_CHANGED", pageUrl: location.href });
  }
  const wrapHistory = (method) => {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      handleUrlChange();
      return result;
    };
  };
  wrapHistory("pushState");
  wrapHistory("replaceState");
  window.addEventListener("popstate", handleUrlChange);

  document.addEventListener("seeking", (event) => {
    if (!isActiveVideoEvent(event)) return;
    awaitingMediaReset = true;
    clearOverlayText({ resetTimeline: false });
  }, true);

  document.addEventListener("seeked", (event) => {
    if (!isActiveVideoEvent(event) || !activeSession) return;
    clearOverlayText({ resetTimeline: false });
    mediaDiscontinuityId += 1;
    safeSend({
      type: "MEDIA_DISCONTINUITY",
      reason: "seek",
      jobId: activeSession.jobId,
      mediaEpoch: activeSession.mediaEpoch,
      discontinuityId: mediaDiscontinuityId,
      currentTime: Number(event.target.currentTime) || 0
    });
  }, true);

  document.addEventListener("ratechange", (event) => {
    if (!isActiveVideoEvent(event)) return;
    positionOverlay();
    if (activeSession?.mode === "offline") reportMediaContext();
  }, true);

  for (const eventName of ["play", "pause", "timeupdate", "loadedmetadata"]) {
    document.addEventListener(eventName, (event) => {
      if (!isActiveVideoEvent(event) || activeSession?.mode !== "offline") return;
      renderOfflineCue();
    }, true);
  }

  document.addEventListener("fullscreenchange", () => {
    mountOverlayForFullscreen();
    positionOverlay();
  });

  function handleLiveMessage(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "KOE_MEDIA_STATUS") {
      handleMediaStatus(message);
      return;
    }
    if (message.type === "OFFLINE_SESSION") {
      const nextJobId = String(message.jobId || "");
      const nextEpoch = Number(message.mediaEpoch) || 0;
      if (activeSession?.mode === "offline"
          && activeSession.jobId === nextJobId
          && nextEpoch < activeSession.mediaEpoch) return;
      const previousSession = activeSession;
      const replacingJob = !previousSession || previousSession.jobId !== nextJobId || previousSession.mode !== "offline";
      const replacingTimeline = replacingJob || previousSession.mediaEpoch !== nextEpoch;
      const translateChanged = activeSession?.mode === "offline"
        && activeSession.jobId === nextJobId
        && activeSession.translate !== (message.translate !== false);
      if (replacingTimeline) {
        clearOverlayText();
        resetOfflineCues();
      }
      activeSession = {
        jobId: nextJobId,
        mediaEpoch: nextEpoch,
        translate: message.translate !== false,
        mode: "offline"
      };
      const noticeAlreadyTargetsNextTimeline = noticeJobId === nextJobId
        && noticeMediaEpoch === nextEpoch
        && (!previousSession
          || previousSession.jobId !== nextJobId
          || previousSession.mediaEpoch !== nextEpoch);
      if (replacingTimeline && !noticeAlreadyTargetsNextTimeline) clearMediaNotice();
      awaitingMediaReset = false;
      if (replacingJob) {
        mediaDiscontinuityId = Math.max(0, Number(message.discontinuityId) || 0);
        // 首次开启时，当前视频可能早已在这个文档里完成 HLS 预载。
        // 保留从文档加载/最近一次换源起记录的代次边界，不能再用固定的
        // 60 秒窗口裁掉仍属于当前视频的 Performance 资源。
      } else {
        mediaDiscontinuityId = Math.max(mediaDiscontinuityId, Number(message.discontinuityId) || 0);
      }
      if (!lastSeenSource) {
        const video = findVideo();
        lastSeenSource = video ? String(video.currentSrc || video.src || "") : "";
      }
      if (translateChanged) visibleOfflineCueId = "";
      ensureOverlay();
      applyOverlayPreferences();
      startOfflineClock();
      renderOfflineCue();
      return;
    }
    if (message.type === "OFFLINE_DISCOVER") {
      if (!activeSession || activeSession.mode !== "offline" || message.jobId !== activeSession.jobId) return;
      reportMediaContext();
      return;
    }
    if (message.type === "OFFLINE_RESET") {
      if (!activeSession || activeSession.mode !== "offline" || message.jobId !== activeSession.jobId) return;
      const nextEpoch = Number(message.mediaEpoch) || 0;
      if (nextEpoch <= activeSession.mediaEpoch) return;
      activeSession.mediaEpoch = nextEpoch;
      awaitingMediaReset = false;
      if (message.reason === "source") mediaResourceFloor = Math.max(0, performanceClock() - 3_000);
      clearOverlayText();
      resetOfflineCues();
      reportMediaContext();
      return;
    }
    if (message.type === "OFFLINE_CUES") {
      if (!acceptOfflineMessage(message)) return;
      clearMediaNotice();
      mergeOfflineCues(message.cues, message.revision);
      renderOfflineCue();
      return;
    }
    if (message.type === "OFFLINE_STOP" || message.type === "OFFLINE_ERROR") {
      if (!activeSession || (message.jobId && message.jobId !== activeSession.jobId)) return;
      if (message.mediaEpoch !== undefined && (Number(message.mediaEpoch) || 0) < activeSession.mediaEpoch) return;
      stopOfflineClock();
      resetOfflineCues();
      clearOverlayText();
      activeSession = null;
      awaitingMediaReset = false;
      if (message.type === "OFFLINE_STOP") clearMediaNotice();
      return;
    }
    if (message.type === "LIVE_SESSION") {
      const nextJobId = String(message.jobId || "");
      const nextEpoch = Number(message.mediaEpoch) || 0;
      const previousSession = activeSession;
      // 同一实时 job 的时间线只能向前。旧启动/重连消息可能在 tab 交接后
      // 迟到；若允许它把 epoch 降回去，随后对应的旧 STOP 就会误清新会话。
      if (previousSession?.mode === "live"
          && previousSession.jobId === nextJobId
          && nextEpoch < previousSession.mediaEpoch) return;
      const replacingTimeline = !previousSession
        || previousSession.mode !== "live"
        || previousSession.jobId !== nextJobId
        || previousSession.mediaEpoch !== nextEpoch;
      if (replacingTimeline) {
        clearOverlayText();
      }
      activeSession = {
        jobId: nextJobId,
        mediaEpoch: nextEpoch,
        translate: message.translate !== false,
        mode: "live"
      };
      const noticeAlreadyTargetsNextTimeline = noticeJobId === nextJobId
        && noticeMediaEpoch === nextEpoch
        && (!previousSession
          || previousSession.jobId !== nextJobId
          || previousSession.mediaEpoch !== nextEpoch);
      if (replacingTimeline && !noticeAlreadyTargetsNextTimeline) clearMediaNotice();
      stopOfflineClock();
      resetOfflineCues();
      awaitingMediaReset = false;
      ensureOverlay();
      applyOverlayPreferences();
      return;
    }
    if (message.type === "LIVE_STOP") {
      if (activeSession && message.mediaEpoch !== undefined
          && (Number(message.mediaEpoch) || 0) < activeSession.mediaEpoch) return;
      if (!activeSession && noticeJobId && message.jobId
          && String(message.jobId) !== noticeJobId) return;
      if (!activeSession && noticeJobId && message.mediaEpoch !== undefined
          && (Number(message.mediaEpoch) || 0) < noticeMediaEpoch) return;
      if (!activeSession || !message.jobId || message.jobId === activeSession.jobId) {
        clearOverlayText();
        activeSession = null;
        awaitingMediaReset = false;
        // Helper 的终止错误会先把字幕会话停掉，再留下一个可读的失败原因。
        // 这类 LIVE_STOP 不能像用户主动停止一样顺手抹掉终止提示。
        if (!message.error && !message.issueCode) clearMediaNotice();
      }
      return;
    }
    if (message.type === "LIVE_RESET") {
      if (!activeSession || message.jobId !== activeSession.jobId) return;
      const nextEpoch = Number(message.mediaEpoch) || 0;
      if (nextEpoch <= activeSession.mediaEpoch) return;
      activeSession.mediaEpoch = nextEpoch;
      clearOverlayText();
      awaitingMediaReset = false;
      return;
    }
    if (!acceptLiveMessage(message)) return;
    if (message.type === "LIVE_REVOKE") {
      const from = Number(message.fromSeq) || 0;
      const to = Number(message.toSeq) || from;
      if ((visibleUnitSeq >= from && visibleUnitSeq <= to) || (translatedSeq >= from && translatedSeq <= to)) {
        clearOverlayText({ resetTimeline: false });
      }
      return;
    }
    const line = Array.isArray(message.lines) ? message.lines[message.lines.length - 1] : null;
    if (!line) return;
    const seq = Number(message.seq) || 0;
    if (message.type === "LIVE_PARTIAL") {
      if (seq && seq < lastDraftSeq) return;
      lastDraftSeq = Math.max(lastDraftSeq, seq);
      draftOriginal = String(line.text || "").trim();
      draftTranslatedText = "";
      showOverlay(3_600);
    } else if (message.type === "LIVE_SUBTITLES") {
      if (seq && seq <= lastUnitSeq) return;
      lastUnitSeq = Math.max(lastUnitSeq, seq);
      showUnit({
        seq,
        original: String(line.text || "").trim(),
        translated: pendingUnitTranslations.get(seq) || ""
      });
      pendingUnitTranslations.delete(seq);
    } else if (message.type === "LIVE_TRANSLATED") {
      const value = String(line.translated || "").trim();
      if (!value) return;
      translatedSeq = Math.max(translatedSeq, seq);
      if (message.unit) {
        if (seq === visibleUnitSeq) {
          finalTranslatedText = value;
          if (!draftOriginal) showOverlay(5_200);
        } else if (seq >= visibleUnitSeq) pendingUnitTranslations.set(seq, value);
      } else {
        if (seq < lastDraftSeq) return;
        draftTranslatedText = value;
        showOverlay(3_600);
      }
    }
    renderOverlay();
  }

  function showUnit(item) {
    if (!item.original) return;
    visibleUnitSeq = Number(item.seq) || visibleUnitSeq;
    finalOriginal = String(item.original || "").trim();
    finalTranslatedText = String(item.translated || "").trim();
    draftOriginal = "";
    draftTranslatedText = "";
    showOverlay(5_200);
    renderOverlay();
  }

  function clearUnitQueue() {
    pendingUnitTranslations.clear();
    visibleUnitSeq = 0;
  }

  function acceptLiveMessage(message) {
    if (!activeSession || message.jobId !== activeSession.jobId) return false;
    if (awaitingMediaReset) return false;
    if ((Number(message.mediaEpoch) || 0) !== activeSession.mediaEpoch) return false;
    const begin = Number(message.beginTimeMs);
    const end = Number(message.endTimeMs);
    const audio = Number(message.audioPositionMs);
    if (Number.isFinite(begin) && Number.isFinite(end) && end < begin) return false;
    // 弱网恢复时宁可跳过已经过去很久的字幕，也不要让旧台词追着画面补播。
    if (Number.isFinite(end) && Number.isFinite(audio) && audio - end > 8_000) return false;
    return true;
  }

  function acceptOfflineMessage(message) {
    if (!activeSession || activeSession.mode !== "offline" || message.jobId !== activeSession.jobId) return false;
    if ((Number(message.mediaEpoch) || 0) !== activeSession.mediaEpoch) return false;
    return true;
  }

  function mergeOfflineCues(cues, revision = 0) {
    const nextRevision = Number(revision) || 0;
    if (nextRevision < offlineRevision) return;
    offlineRevision = Math.max(offlineRevision, nextRevision);
    const byId = new Map(offlineCues.map((cue) => [cue.cueId, cue]));
    for (const candidate of Array.isArray(cues) ? cues : []) {
      const startMs = Number(candidate?.startMs);
      const endMs = Number(candidate?.endMs);
      const text = String(candidate?.text || "").trim();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || !text) continue;
      const cueId = String(candidate.cueId || `${Math.round(startMs)}-${Math.round(endMs)}`);
      byId.set(cueId, {
        cueId,
        startMs,
        endMs,
        text,
        translated: String(candidate.translated || "").trim()
      });
    }
    offlineCues = [...byId.values()]
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
      .slice(-2_000);
  }

  function resetOfflineCues() {
    offlineCues = [];
    offlineRevision = 0;
    visibleOfflineCueId = "";
  }

  function startOfflineClock() {
    stopOfflineClock();
    if (typeof window.requestAnimationFrame !== "function") return;
    const tick = () => {
      offlineFrameRequest = 0;
      if (activeSession?.mode !== "offline") return;
      renderOfflineCue();
      offlineFrameRequest = window.requestAnimationFrame(tick);
    };
    offlineFrameRequest = window.requestAnimationFrame(tick);
  }

  function stopOfflineClock() {
    if (offlineFrameRequest && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(offlineFrameRequest);
    }
    offlineFrameRequest = 0;
  }

  function renderOfflineCue() {
    if (!activeSession || activeSession.mode !== "offline" || awaitingMediaReset) return;
    const video = findVideo();
    if (!video) return;
    const currentMs = Math.max(0, Number(video.currentTime) || 0) * 1_000;
    const cue = findCueAt(currentMs);
    const signature = cue ? `${cue.cueId}\u0000${cue.text}\u0000${cue.translated}` : "";
    if (signature === visibleOfflineCueId) return;
    visibleOfflineCueId = signature;
    if (!cue) {
      finalOriginal = "";
      finalTranslatedText = "";
      draftOriginal = "";
      draftTranslatedText = "";
      if (overlayOriginal) overlayOriginal.textContent = "";
      if (overlayTranslation) overlayTranslation.textContent = "";
      overlayHost?.shadowRoot?.querySelector(".stage")?.classList.remove("visible");
      return;
    }
    finalOriginal = cue.text;
    finalTranslatedText = cue.translated;
    draftOriginal = "";
    draftTranslatedText = "";
    safeSend({
      type: "OFFLINE_VISIBLE_REPORT",
      jobId: activeSession.jobId,
      mediaEpoch: activeSession.mediaEpoch,
      currentTimeMs: currentMs,
      cue: {
        cueId: cue.cueId,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        translated: cue.translated
      }
    });
    renderOverlay();
    showOverlayPersistent();
  }

  function findCueAt(currentMs) {
    let low = 0;
    let high = offlineCues.length - 1;
    let candidate = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const cue = offlineCues[middle];
      if (cue.startMs <= currentMs) {
        candidate = cue;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!candidate) return null;
    let index = offlineCues.indexOf(candidate);
    while (index >= 0) {
      const cue = offlineCues[index];
      if (cue.startMs <= currentMs && currentMs < cue.endMs) return cue;
      index -= 1;
    }
    return null;
  }

  function showOverlayPersistent() {
    if (!overlayEnabled) return;
    ensureOverlay();
    if (overlayHideTimer) window.clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    overlayHost.shadowRoot?.querySelector(".stage")?.classList.add("visible");
  }

  function reportMediaContext(video = findVideo()) {
    if (!video || !activeSession || activeSession.mode !== "offline") return;
    lastMediaContextAt = Date.now();
    let resourceUrls = [];
    try {
      const confirmedAt = Date.now();
      const observed = (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function")
        ? performance.getEntriesByType("resource")
          .filter((entry) => Number(entry?.startTime) >= mediaResourceFloor)
          .map((entry) => ({
            url: String(entry?.name || ""),
            // 后台候选有短 TTL。只要同一媒体代次仍周期回报这条记录，
            // 就把它视为此刻再次确认；原始 startTime 只负责代次筛选。
            observedAt: confirmedAt,
            source: "performance"
          }))
          .filter((item) => {
            try { return /\.m3u8$/i.test(new URL(item.url).pathname); } catch { return false; }
          })
        : [];
      // 许多播放器在用户打开 Koe 之前就已加载 HLS。Performance 记录
      // 作为当前媒体代次的主来源；内联播放器配置则补回可能已从
      // Resource Timing 缓冲区淘汰的定义，两者都只驻留内存。
      const definitions = currentInlineHlsDefinitions();
      const merged = new Map();
      for (const item of observed) merged.set(item.url, item);
      for (const item of definitions) {
        merged.set(item.url, {
          url: item.url,
          observedAt: confirmedAt,
          source: "page-definition",
          quality: Math.max(0, Number(item.quality) || 0)
        });
      }
      resourceUrls = [...merged.values()].slice(-24);
    } catch {
      resourceUrls = [];
    }
    safeSend({
      type: "MEDIA_CONTEXT",
      jobId: activeSession.jobId,
      mediaEpoch: activeSession.mediaEpoch,
      currentSrc: String(video.currentSrc || video.src || ""),
      currentTimeMs: Math.max(0, Number(video.currentTime) || 0) * 1_000,
      durationMs: Number.isFinite(Number(video.duration)) ? Math.max(0, Number(video.duration) * 1_000) : 0,
      playbackRate: Math.max(0.25, Math.min(4, Number(video.playbackRate) || 1)),
      resourceUrls
    });
  }

  function freezeForSourceChange() {
    // 即使字幕尚未开启，也必须推进媒体代次边界。这样用户在 SPA 中
    // 换过视频后再启动 Koe，只会回报换源后的 Performance 记录。
    mediaResourceFloor = Math.max(0, performanceClock() - 3_000);
    inlineHlsDefinitions = null;
    inlineHlsScannedAt = 0;
    clearMediaNotice();
    if (!activeSession) return;
    awaitingMediaReset = true;
    clearOverlayText({ resetTimeline: false });
    if (activeSession.mode === "offline") resetOfflineCues();
  }

  function currentInlineHlsDefinitions() {
    const now = Date.now();
    const cacheMs = inlineHlsDefinitions?.length ? 30_000 : 3_000;
    if (inlineHlsDefinitions && now - inlineHlsScannedAt < cacheMs) return inlineHlsDefinitions;
    inlineHlsScannedAt = now;
    inlineHlsDefinitions = globalThis.KoeMediaDiscovery
      ?.collectInlineHlsDefinitions?.(document, { limit: 24 }) || [];
    return inlineHlsDefinitions;
  }

  function performanceClock() {
    try { return Number(performance?.now?.()) || 0; } catch { return 0; }
  }

  async function loadOverlayPreferences() {
    try {
      if (!chrome.storage?.local?.get) return;
      const stored = await chrome.storage.local.get(["koeOverlayEnabled", "koeOverlaySize", "koeHideOriginal"]);
      overlayEnabled = stored.koeOverlayEnabled !== false;
      overlaySize = normalizeOverlaySize(stored.koeOverlaySize);
      hideOriginal = stored.koeHideOriginal !== false;
      applyOverlayPreferences();
    } catch {
      // 使用默认偏好。
    }
  }

  function normalizeOverlaySize(value) {
    return ["small", "medium", "large"].includes(value) ? value : "medium";
  }

  function ensureOverlay() {
    if (overlayHost?.isConnected) return;
    overlayHost = document.createElement("div");
    overlayHost.id = "koe-caption-root";
    const shadow = overlayHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .stage {
          position: fixed;
          inset: auto auto 8vh 0;
          width: 100vw;
          z-index: 2147483647;
          display: grid;
          place-items: end center;
          padding: 0 4%;
          box-sizing: border-box;
          pointer-events: none;
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 150ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
          font-family: "Avenir Next", "SF Pro Rounded", "Hiragino Sans GB", "Yu Gothic UI", sans-serif;
          --koe-scale: 1;
        }
        .stage.visible { opacity: 1; transform: translateY(0); }
        .stack {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: .34em;
          max-width: min(88%, 1080px);
          text-align: center;
          text-wrap: balance;
          filter: drop-shadow(0 2px 8px rgba(0,0,0,.56));
        }
        .line {
          display: none;
          width: fit-content;
          max-width: 100%;
          color: #fff;
          letter-spacing: .012em;
          line-height: 1.28;
          text-shadow: 0 1px 2px #000, 0 0 12px rgba(0,0,0,.88);
          overflow-wrap: anywhere;
          overflow: hidden;
          white-space: pre-line;
        }
        .line:not(:empty) {
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
        }
        .translation {
          order: 2;
          font-size: calc(clamp(22px, 2.35vw, 36px) * var(--koe-scale));
          font-weight: 650;
        }
        .original {
          order: 1;
          color: rgba(255,255,255,.92);
          font-size: calc(clamp(15px, 1.55vw, 23px) * var(--koe-scale));
          font-weight: 520;
        }
        .original.solo {
          font-size: calc(clamp(20px, 2.1vw, 32px) * var(--koe-scale));
          font-weight: 620;
        }
        .notice {
          position: fixed;
          z-index: 2147483647;
          display: none;
          flex-direction: column;
          gap: 3px;
          width: max-content;
          max-width: min(360px, calc(100vw - 32px));
          padding: 10px 12px;
          box-sizing: border-box;
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 9px;
          background: rgba(12,12,12,.94);
          color: #fff;
          pointer-events: none;
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
          text-align: left;
        }
        .notice.visible { display: flex; }
        .notice-title {
          font-size: 13px;
          line-height: 1.35;
          font-weight: 650;
          letter-spacing: .01em;
        }
        .notice-detail {
          color: rgba(255,255,255,.68);
          font-size: 11px;
          line-height: 1.45;
          overflow-wrap: anywhere;
        }
        .notice-detail:empty { display: none; }
        @media (max-width: 540px) {
          .stage { padding-inline: 3%; }
          .stack { max-width: 96%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .stage { transition: opacity 80ms linear; transform: none; }
        }
      </style>
      <div class="stage" aria-live="polite" aria-atomic="true">
        <div class="stack">
          <div class="line original"></div>
          <div class="line translation"></div>
        </div>
      </div>
      <div class="notice" role="status" aria-live="polite" aria-atomic="true">
        <div class="notice-title"></div>
        <div class="notice-detail"></div>
      </div>`;
    overlayOriginal = shadow.querySelector(".original");
    overlayTranslation = shadow.querySelector(".translation");
    overlayNotice = shadow.querySelector(".notice");
    overlayNoticeTitle = shadow.querySelector(".notice-title");
    overlayNoticeDetail = shadow.querySelector(".notice-detail");
    mountOverlayForFullscreen();
    positionOverlay();
  }

  function mountOverlayForFullscreen() {
    if (!overlayHost) return;
    const fullscreenRoot = document.fullscreenElement;
    const target = fullscreenRoot || document.documentElement;
    if (overlayHost.parentNode !== target) {
      try {
        target.appendChild(overlayHost);
      } catch {
        document.documentElement.appendChild(overlayHost);
      }
    }
  }

  function applyOverlayPreferences() {
    if (!overlayHost) return;
    const stage = overlayHost.shadowRoot?.querySelector(".stage");
    if (!stage) return;
    const scale = overlaySize === "small" ? 0.84 : overlaySize === "large" ? 1.18 : 1;
    stage.style.setProperty("--koe-scale", String(scale));
    overlayHost.hidden = !overlayEnabled;
    if (!overlayEnabled) clearOverlayText({ resetTimeline: false });
    else if (activeSession?.mode === "offline") {
      visibleOfflineCueId = "";
      renderOfflineCue();
    }
  }

  function positionOverlay() {
    if (!overlayHost?.isConnected) return;
    const stage = overlayHost.shadowRoot?.querySelector(".stage");
    if (!stage) return;
    const video = findVideo();
    const rect = video?.getBoundingClientRect?.();
    if (!rect || rect.width < 1 || rect.height < 1) {
      stage.style.left = "0px";
      stage.style.width = "100vw";
      stage.style.bottom = "8vh";
      if (overlayNotice) {
        overlayNotice.style.top = "16px";
        overlayNotice.style.right = "16px";
      }
      return;
    }
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight || rect.bottom;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth || rect.right;
    stage.style.left = `${Math.max(0, rect.left)}px`;
    stage.style.width = `${Math.max(1, Math.min(rect.width, document.documentElement.clientWidth || rect.width))}px`;
    stage.style.bottom = `${Math.max(18, viewportHeight - rect.bottom + Math.min(76, rect.height * 0.09))}px`;
    if (overlayNotice) {
      const inset = Math.max(10, Math.min(18, rect.width * 0.025, rect.height * 0.04));
      overlayNotice.style.top = `${Math.max(10, rect.top + inset)}px`;
      overlayNotice.style.right = `${Math.max(10, viewportWidth - rect.right + inset)}px`;
    }
  }

  function handleMediaStatus(message) {
    if (!acceptMediaStatus(message)) return;
    if (message.kind === "clear") {
      clearMediaNotice();
      return;
    }
    if (message.kind !== "action" && message.kind !== "error") return;
    ensureOverlay();
    noticeJobId = String(message.jobId || "");
    noticeMediaEpoch = Math.max(0, Number(message.mediaEpoch) || 0);
    if (overlayNoticeTitle) overlayNoticeTitle.textContent = String(message.title || "字幕暂不可用").trim();
    if (overlayNoticeDetail) overlayNoticeDetail.textContent = String(message.detail || "").trim();
    overlayNotice?.classList.toggle("error", message.kind === "error");
    overlayNotice?.classList.add("visible");
    positionOverlay();
  }

  function acceptMediaStatus(message) {
    const jobId = String(message.jobId || "");
    const hasEpoch = message.mediaEpoch !== undefined && message.mediaEpoch !== null;
    const epoch = Math.max(0, Number(message.mediaEpoch) || 0);
    if (activeSession) {
      if (jobId && jobId !== activeSession.jobId) return false;
      if (hasEpoch && epoch < activeSession.mediaEpoch) return false;
    }
    if (noticeJobId && jobId && jobId === noticeJobId && hasEpoch && epoch < noticeMediaEpoch) return false;
    return true;
  }

  function clearMediaNotice() {
    noticeJobId = "";
    noticeMediaEpoch = 0;
    if (overlayNoticeTitle) overlayNoticeTitle.textContent = "";
    if (overlayNoticeDetail) overlayNoticeDetail.textContent = "";
    overlayNotice?.classList.remove("visible");
    overlayNotice?.classList.remove("error");
  }

  function showOverlay(duration) {
    if (!overlayEnabled) return;
    ensureOverlay();
    const stage = overlayHost.shadowRoot?.querySelector(".stage");
    stage?.classList.add("visible");
    if (overlayHideTimer) window.clearTimeout(overlayHideTimer);
    overlayHideTimer = window.setTimeout(() => stage?.classList.remove("visible"), duration);
  }

  function renderOverlay() {
    if (!overlayOriginal || !overlayTranslation) return;
    // 持续增长的草稿必须显示“最新两行”。直接把全文交给 line-clamp 只会
    // 永远裁出开头两行，讲话越久，用户越看不到当前正在说什么。
    const original = draftOriginal ? captionViewport(draftOriginal) : finalOriginal;
    const translation = draftOriginal ? captionViewport(draftTranslatedText) : finalTranslatedText;
    const hideOriginalActive = hideOriginal && Boolean(activeSession?.translate);
    overlayOriginal.textContent = hideOriginalActive ? "" : original;
    overlayTranslation.textContent = activeSession?.translate ? translation : "";
    overlayOriginal.classList.toggle("solo", !overlayTranslation.textContent);
    overlayOriginal.style.display = hideOriginalActive ? "none" : "";
    positionOverlay();
  }

  function captionViewport(text) {
    const value = String(text || "").trim();
    if (!value) return "";
    const cjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value);
    const maximum = cjk ? 24 : 58;
    const remaining = Array.from(value);
    const parts = [];
    while (remaining.length > 0) {
      while (remaining.length > 0 && /\s/.test(remaining[0])) remaining.shift();
      if (remaining.length === 0) break;
      const searchCount = Math.min(maximum, remaining.length);
      const sentenceEnd = remaining.slice(0, searchCount)
        .findIndex((character) => CAPTION_SENTENCE_ENDINGS.has(character));
      if (sentenceEnd >= 0) {
        parts.push(remaining.splice(0, sentenceEnd + 1).join("").trim());
        continue;
      }
      if (remaining.length <= maximum) {
        parts.push(remaining.splice(0).join("").trim());
        continue;
      }
      let preferred = -1;
      for (let index = maximum - 1; index >= Math.floor(maximum / 2); index -= 1) {
        if (CAPTION_PREFERRED_BREAKS.has(remaining[index])) {
          preferred = index;
          break;
        }
      }
      const count = preferred >= 0
        ? (/\s/.test(remaining[preferred]) ? preferred : preferred + 1)
        : maximum;
      parts.push(remaining.splice(0, Math.max(1, count)).join("").trim());
    }
    return parts.filter(Boolean).slice(-2).join("\n");
  }

  function clearOverlayText({ resetTimeline = true } = {}) {
    if (overlayHideTimer) window.clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    if (resetTimeline) {
      lastDraftSeq = 0;
      lastUnitSeq = 0;
      translatedSeq = 0;
    }
    finalOriginal = "";
    draftOriginal = "";
    finalTranslatedText = "";
    draftTranslatedText = "";
    clearUnitQueue();
    if (overlayOriginal) overlayOriginal.textContent = "";
    if (overlayTranslation) overlayTranslation.textContent = "";
    overlayHost?.shadowRoot?.querySelector(".stage")?.classList.remove("visible");
  }

  function isActiveVideoEvent(event) {
    const target = event.target;
    return target instanceof HTMLVideoElement && target === findVideo();
  }

  function findVideo() {
    const videos = [...document.querySelectorAll("video")];
    const score = (video) => {
      const rect = video.getBoundingClientRect?.() || {};
      const intrinsicArea = Number(video.videoWidth || 0) * Number(video.videoHeight || 0);
      const layoutArea = Number(rect.width || 0) * Number(rect.height || 0);
      const ancestry = [video, video.parentElement, video.parentElement?.parentElement]
        .map((node) => `${node?.id || ""} ${node?.className || ""}`).join(" ");
      const adLike = /(^|[\s_-])(ad|ads|advert|preroll|postroll|pauseroll|gifvideo)([\s_-]|$)/i.test(ancestry);
      if (adLike) return -1_000_000_000_000;
      return Math.max(intrinsicArea, layoutArea)
        + (video.muted ? 0 : 1_000_000)
        + (video.paused ? 0 : 500_000);
    };
    const main = videos
      .filter((video) => {
        const rect = video.getBoundingClientRect?.() || {};
        return Math.max(Number(video.videoWidth || 0), Number(rect.width || 0)) >= 320
          && Math.max(Number(video.videoHeight || 0), Number(rect.height || 0)) >= 180;
      })
      .sort((left, right) => score(right) - score(left))[0];
    return main || videos.sort((left, right) => score(right) - score(left))[0] || null;
  }
})();
