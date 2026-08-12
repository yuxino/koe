(() => {
  if (window.__koeLoaded) return;
  window.__koeLoaded = true;

  const HOST_CSS = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const host = document.createElement("div");
  host.id = "koe-root";
  host.style.cssText = HOST_CSS;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .status {
        position: fixed; right: 18px; bottom: 18px; opacity: 0;
        transition: opacity .22s ease; max-width: min(300px, 40vw);
        font: 500 12px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        letter-spacing: .06em; color: rgba(240,244,235,.85); background: rgba(18,24,20,.62);
        border: 1px solid rgba(255,255,255,.08); padding: 6px 14px; border-radius: 999px;
        backdrop-filter: blur(12px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .status.error { color: #ffd9d4; border-color: rgba(255,122,110,.35); }
      .status.visible { opacity: 1; }
      .subtitle {
        position: fixed; left: 50%; bottom: 5vh; transform: translate(-50%, 10px); opacity: 0;
        transition: opacity .22s ease, transform .22s ease; max-width: min(860px, 84vw); text-align: center;
        font: 400 20px/1.45 Georgia, "Songti SC", serif; color: #fbf4df;
        letter-spacing: .02em; padding: 10px 20px; border-radius: 14px;
        background: linear-gradient(135deg, rgba(20,29,25,.9), rgba(43,49,37,.82));
        border: 1px solid rgba(255,248,224,.16);
        box-shadow: 0 14px 44px rgba(0,0,0,.35);
      }
      .subtitle.visible { opacity: 1; transform: translate(-50%, 0); }
    </style>
    <div class="status" aria-live="polite"></div>
    <div class="subtitle" aria-live="polite"></div>
  `;

  const statusEl = shadow.querySelector(".status");
  const subtitleEl = shadow.querySelector(".subtitle");

  let translateOn = false;
  let lastSeenSource = "";
  let lastSeenUrl = location.href;
  let lastPageReadyAt = 0;
  let lastAckAt = 0;
  let liveHideTimer = null;
  let latestFinalSeq = 0;

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "LIVE_STATE") {
      ack(`state:${message.status}`, true);
      if (message.translate !== undefined) translateOn = Boolean(message.translate);
      if (message.status === "live") {
        latestFinalSeq = 0;
        hideStatus();
      } else if (message.captureNeedsGesture) {
        showStatus(message.stageDetail || "点一下 Koe 图标，立即开始实时字幕");
      } else if (message.status === "error") {
        showStatus(message.stageDetail || "实时字幕已断开", true);
      } else if (message.stageDetail) {
        showStatus(message.stageDetail);
      }
      return false;
    }

    if (message.type === "LIVE_PARTIAL") {
      try {
        const lines = Array.isArray(message.lines) ? message.lines : [];
        const line = lines[lines.length - 1];
        const text = line?.text;
        if (text) showSubtitle(text);
      } catch (error) {
        ack(`display-error:${String(error).slice(0, 60)}`, true);
      }
      return false;
    }

    if (message.type === "LIVE_SUBTITLES") {
      try {
        if (message.seq) latestFinalSeq = Number(message.seq);
        const lines = Array.isArray(message.lines) ? message.lines : [];
        const line = lines[lines.length - 1];
        const text = line?.text;
        if (text) showSubtitle(text);
      } catch (error) {
        ack(`display-error:${String(error).slice(0, 60)}`, true);
      }
      return false;
    }

    if (message.type === "LIVE_TRANSLATED") {
      try {
        if (!translateOn) return false;
        if (Number(message.seq) !== latestFinalSeq) return false;
        const lines = Array.isArray(message.lines) ? message.lines : [];
        const line = lines[lines.length - 1];
        const text = line?.translated;
        if (text) showSubtitle(text);
      } catch (error) {
        ack(`display-error:${String(error).slice(0, 60)}`, true);
      }
      return false;
    }

    if (message.type === "LIVE_STOP") {
      clearTimeout(liveHideTimer);
      subtitleEl.textContent = "";
      subtitleEl.classList.remove("visible");
      latestFinalSeq = 0;
      return false;
    }
    return false;
  });

  // 页面加载即通知后台；加载慢则每 3 秒重试（最多 10 次）
  chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  ack("ready", true);
  let pageReadyAttempts = 0;
  window.setInterval(() => {
    if (pageReadyAttempts >= 10) return;
    pageReadyAttempts += 1;
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, 3_000);

  document.addEventListener("play", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLVideoElement) || target.muted) return;
    const now = Date.now();
    if (now - lastPageReadyAt < 3_000) return;
    lastPageReadyAt = now;
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, true);

  document.addEventListener("emptied", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" }).catch(() => undefined);
  }, true);

  // 周期检测：源/URL 变化 → 通知后台重连识别；正在播放且未静音 → 触发实时字幕
  window.setInterval(trackVideoSource, 1_000);
  function trackVideoSource() {
    handleUrlChange();
    const video = currentVideo();
    const source = video ? (video.currentSrc || video.src || "") : "";
    if (source && source !== lastSeenSource) {
      lastSeenSource = source;
      chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" }).catch(() => undefined);
      return;
    }
    if (video && !video.paused && !video.muted && video.readyState >= 2) {
      const now = Date.now();
      if (now - lastPageReadyAt >= 3_000) {
        lastPageReadyAt = now;
        chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
      }
    }
  }

  // URL 变化感知（SPA 切视频/页面跳转）：历史 API、popstate、每秒兜底比对
  function handleUrlChange() {
    if (location.href === lastSeenUrl) return;
    lastSeenUrl = location.href;
    chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" }).catch(() => undefined);
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

  // 全屏时把 UI 挂进全屏元素，否则回到页面根
  document.addEventListener("fullscreenchange", syncFullscreen, true);
  document.addEventListener("webkitfullscreenchange", syncFullscreen, true);
  function syncFullscreen() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (fs && fs !== host.parentElement) {
      fs.appendChild(host);
      host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2147483647;";
    } else if (!fs && host.parentElement !== document.documentElement) {
      document.documentElement.appendChild(host);
      host.style.cssText = HOST_CSS;
    }
  }

  function showStatus(text, isError = false) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", isError);
    statusEl.classList.add("visible");
  }
  function hideStatus() {
    statusEl.classList.remove("visible");
  }

  function showSubtitle(text) {
    subtitleEl.textContent = text;
    subtitleEl.classList.add("visible");
    ack(`shown:${String(text).slice(0, 20)}`);
    clearTimeout(liveHideTimer);
    liveHideTimer = setTimeout(() => {
      subtitleEl.classList.remove("visible");
    }, 6_000);
  }

  function ack(stage, force = false) {
    const now = Date.now();
    if (!force && now - lastAckAt < 3_000) return;
    lastAckAt = now;
    chrome.runtime.sendMessage({ type: "CONTENT_ACK", stage }).catch(() => undefined);
  }

  function currentVideo() {
    return findVideo();
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
