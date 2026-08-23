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
