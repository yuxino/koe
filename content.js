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
  let overlayEnabled = true;
  let overlaySize = "medium";
  let overlayHideTimer = null;
  let lastDraftSeq = 0;
  let lastUnitSeq = 0;
  let finalOriginal = "";
  let draftOriginal = "";
  let finalTranslatedText = "";
  let draftTranslatedText = "";
  let translatedSeq = 0;
  let visibleUnitSeq = 0;
  let visibleUnitShownAt = 0;
  let unitAdvanceTimer = null;
  const queuedUnits = [];
  const pendingUnitTranslations = new Map();
  const MINIMUM_UNIT_DISPLAY_MS = 1_000;

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
    safeSend({ type: "VIDEO_CHANGED" });
  }, true);

  // 周期检测：源/URL 变化 → 通知后台重连识别；正在播放且未静音 → 触发实时字幕
  window.setInterval(trackVideoSource, 1_000);
  window.setInterval(positionOverlay, 500);
  function trackVideoSource() {
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：停止工作
    handleUrlChange();
    const video = findVideo();
    const source = video ? (video.currentSrc || video.src || "") : "";
    if (source && source !== lastSeenSource) {
      lastSeenSource = source;
      safeSend({ type: "VIDEO_CHANGED" });
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
    safeSend({ type: "VIDEO_CHANGED" });
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
    clearOverlayText();
  }, true);

  document.addEventListener("seeked", (event) => {
    if (!isActiveVideoEvent(event) || !activeSession) return;
    clearOverlayText();
    safeSend({
      type: "MEDIA_DISCONTINUITY",
      reason: "seek",
      jobId: activeSession.jobId,
      mediaEpoch: activeSession.mediaEpoch,
      currentTime: Number(event.target.currentTime) || 0
    });
  }, true);

  document.addEventListener("ratechange", (event) => {
    if (!isActiveVideoEvent(event)) return;
    positionOverlay();
  }, true);

  document.addEventListener("fullscreenchange", () => {
    mountOverlayForFullscreen();
    positionOverlay();
  });

  function handleLiveMessage(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "LIVE_SESSION") {
      const nextJobId = String(message.jobId || "");
      const nextEpoch = Number(message.mediaEpoch) || 0;
      if (!activeSession || activeSession.jobId !== nextJobId || activeSession.mediaEpoch !== nextEpoch) {
        clearOverlayText();
      }
      activeSession = {
        jobId: nextJobId,
        mediaEpoch: nextEpoch,
        translate: message.translate !== false
      };
      ensureOverlay();
      applyOverlayPreferences();
      return;
    }
    if (message.type === "LIVE_STOP") {
      if (!activeSession || !message.jobId || message.jobId === activeSession.jobId) {
        clearOverlayText();
        activeSession = null;
      }
      return;
    }
    if (message.type === "LIVE_RESET") {
      if (!activeSession || message.jobId !== activeSession.jobId) return;
      activeSession.mediaEpoch = Number(message.mediaEpoch) || 0;
      clearOverlayText();
      return;
    }
    if (!acceptLiveMessage(message)) return;
    if (message.type === "LIVE_REVOKE") {
      const from = Number(message.fromSeq) || 0;
      const to = Number(message.toSeq) || from;
      const queuedRevoked = queuedUnits.some((item) => item.seq >= from && item.seq <= to);
      if ((visibleUnitSeq >= from && visibleUnitSeq <= to) || queuedRevoked || (translatedSeq >= from && translatedSeq <= to)) {
        clearOverlayText();
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
      if (seq && seq < lastUnitSeq) return;
      lastUnitSeq = Math.max(lastUnitSeq, seq);
      queueOrShowUnit({
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
        } else {
          const queued = queuedUnits.find((item) => item.seq === seq);
          if (queued) queued.translated = value;
          else if (seq >= visibleUnitSeq) pendingUnitTranslations.set(seq, value);
        }
      } else {
        if (seq < lastDraftSeq) return;
        draftTranslatedText = value;
        showOverlay(3_600);
      }
    }
    renderOverlay();
  }

  function queueOrShowUnit(item) {
    if (!item.original) return;
    const elapsed = Date.now() - visibleUnitShownAt;
    if (!visibleUnitSeq || elapsed >= MINIMUM_UNIT_DISPLAY_MS) {
      showUnit(item);
      return;
    }
    const existing = queuedUnits.find((queued) => queued.seq === item.seq);
    if (existing) Object.assign(existing, item);
    else queuedUnits.push(item);
    scheduleQueuedUnit();
  }

  function showUnit(item) {
    visibleUnitSeq = Number(item.seq) || visibleUnitSeq;
    visibleUnitShownAt = Date.now();
    finalOriginal = String(item.original || "").trim();
    finalTranslatedText = String(item.translated || "").trim();
    draftOriginal = "";
    draftTranslatedText = "";
    showOverlay(5_200);
    renderOverlay();
    scheduleQueuedUnit();
  }

  function scheduleQueuedUnit() {
    if (unitAdvanceTimer) window.clearTimeout(unitAdvanceTimer);
    unitAdvanceTimer = null;
    if (queuedUnits.length === 0) return;
    const delay = Math.max(0, MINIMUM_UNIT_DISPLAY_MS - (Date.now() - visibleUnitShownAt));
    unitAdvanceTimer = window.setTimeout(() => {
      unitAdvanceTimer = null;
      const next = queuedUnits.shift();
      if (next) showUnit(next);
    }, delay);
  }

  function clearUnitQueue() {
    if (unitAdvanceTimer) window.clearTimeout(unitAdvanceTimer);
    unitAdvanceTimer = null;
    queuedUnits.length = 0;
    pendingUnitTranslations.clear();
    visibleUnitSeq = 0;
    visibleUnitShownAt = 0;
  }

  function acceptLiveMessage(message) {
    if (!activeSession || message.jobId !== activeSession.jobId) return false;
    if ((Number(message.mediaEpoch) || 0) !== activeSession.mediaEpoch) return false;
    const end = Number(message.endTimeMs);
    const audio = Number(message.audioPositionMs);
    // 弱网恢复时宁可跳过已经过去很久的字幕，也不要让旧台词追着画面补播。
    if (Number.isFinite(end) && Number.isFinite(audio) && audio - end > 8_000) return false;
    return true;
  }

  async function loadOverlayPreferences() {
    try {
      if (!chrome.storage?.local?.get) return;
      const stored = await chrome.storage.local.get(["koeOverlayEnabled", "koeOverlaySize"]);
      overlayEnabled = stored.koeOverlayEnabled !== false;
      overlaySize = normalizeOverlaySize(stored.koeOverlaySize);
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
      </div>`;
    overlayOriginal = shadow.querySelector(".original");
    overlayTranslation = shadow.querySelector(".translation");
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
    if (!overlayEnabled) clearOverlayText();
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
      return;
    }
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight || rect.bottom;
    stage.style.left = `${Math.max(0, rect.left)}px`;
    stage.style.width = `${Math.max(1, Math.min(rect.width, document.documentElement.clientWidth || rect.width))}px`;
    stage.style.bottom = `${Math.max(18, viewportHeight - rect.bottom + Math.min(76, rect.height * 0.09))}px`;
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
    const original = draftOriginal || finalOriginal;
    const translation = draftOriginal ? draftTranslatedText : finalTranslatedText;
    overlayOriginal.textContent = fitOverlayText(original);
    overlayTranslation.textContent = activeSession?.translate ? fitOverlayText(translation) : "";
    overlayOriginal.classList.toggle("solo", !overlayTranslation.textContent);
    positionOverlay();
  }

  function fitOverlayText(text) {
    const value = String(text || "").trim();
    const points = Array.from(value);
    const isCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value);
    const maximum = isCjk ? 28 : 64;
    if (points.length <= maximum) return value;
    let tail = points.slice(points.length - maximum);
    const searchEnd = Math.min(tail.length - 1, Math.floor(maximum * 0.34));
    for (let index = 0; index <= searchEnd; index += 1) {
      if (/\s/.test(tail[index]) || /[，、,；;：:—–-]/.test(tail[index])) {
        tail = tail.slice(index + 1);
        break;
      }
    }
    return tail.join("").trim();
  }

  function clearOverlayText() {
    if (overlayHideTimer) window.clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    lastDraftSeq = 0;
    lastUnitSeq = 0;
    finalOriginal = "";
    draftOriginal = "";
    finalTranslatedText = "";
    draftTranslatedText = "";
    translatedSeq = 0;
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
      const area = Number(video.videoWidth || 0) * Number(video.videoHeight || 0);
      return area + (video.muted ? 0 : 1_000_000) + (video.paused ? 0 : 500_000);
    };
    const main = videos
      .filter((video) => Number(video.videoWidth) >= 320 && Number(video.videoHeight) >= 180 && (video.currentSrc || video.src))
      .sort((left, right) => score(right) - score(left))[0];
    return main || videos.sort((left, right) => score(right) - score(left))[0] || null;
  }
})();
