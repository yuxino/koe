(() => {
  const CONTENT_VERSION = "1.6.0";
  if (window.__koeLoaded === CONTENT_VERSION) return;
  window.__koeLoaded = CONTENT_VERSION;

  // 扩展重新加载后，页面里的旧 DOM 仍可能存在，但它对应的消息监听器已经失效。
  // 移除旧容器并完整重建，避免后台已开启、页面却停在旧错误提示。
  document.querySelector("#koe-root")?.remove();

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
      .caption {
        position: fixed; left: 0; right: 0; margin: 0 auto; width: fit-content;
        max-width: min(760px, 88vw); bottom: 6vh;
        opacity: 0; transform: translateY(10px);
        transition: opacity .25s ease, transform .25s ease;
        pointer-events: auto; cursor: grab; user-select: none;
        text-align: center;
        font: 400 22px/1.5 Georgia, "Songti SC", serif; color: #fbf4df;
        letter-spacing: .02em; padding: 12px 24px; border-radius: 16px;
        background: linear-gradient(135deg, rgba(18,24,20,.88), rgba(36,44,34,.8));
        border: 1px solid rgba(255,248,224,.14);
        box-shadow: 0 16px 48px rgba(0,0,0,.42), 0 0 0 1px rgba(203,220,119,.05);
        backdrop-filter: blur(16px);
      }
      .caption.visible { opacity: 1; transform: translateY(0); }
      .caption.dragged { left: auto; right: auto; margin: 0; bottom: auto; }
      .caption.dragging { cursor: grabbing; transition: none; }
      .caption::selection { background: rgba(203,220,119,.3); }
    </style>
    <div class="status" aria-live="polite"></div>
    <div class="caption" aria-live="polite" hidden></div>
  `;

  const statusEl = shadow.querySelector(".status");
  const captionEl = shadow.querySelector(".caption");

  let translateOn = false;
  let activeJobId = "";
  let lastSeenSource = "";
  let lastSeenUrl = location.href;
  let lastPageReadyAt = 0;
  let lastAckAt = 0;
  let captionHideTimer = null;
  let latestSeq = 0;

  chrome.runtime.onMessage.addListener((message) => {
    // 扩展重载后，页面里可能残留旧版本脚本的监听器和定时器：
    // 旧副本检测到版本号已被新副本顶替后自行停用，避免重复发消息
    if (window.__koeLoaded !== CONTENT_VERSION) return false;
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "LIVE_STATE") {
      ack(`state:${message.status}`, true);
      if (message.translate !== undefined) translateOn = Boolean(message.translate);
      const nextJobId = String(message.jobId || "");
      if (nextJobId && nextJobId !== activeJobId) {
        activeJobId = nextJobId;
        resetCaption();
      }

      if (message.status === "live") {
        hideStatus();
      } else if (message.captureNeedsGesture) {
        showStatus(message.stageDetail || "点击 Koe 图标（弹窗一键开启）或按 Alt+K，开启实时字幕");
      } else if (message.status === "error") {
        showStatus(message.stageDetail || "实时字幕已断开", true);
      } else if (message.stageDetail) {
        showStatus(message.stageDetail);
      }
      return false;
    }

    if (message.type === "LIVE_PARTIAL") {
      if (!belongsToActiveSession(message)) return false;
      try {
        if (translateOn) return false; // 翻译模式下中间原文不显示，译文随后跟上
        if (!acceptSeq(message.seq)) return false;
        const text = lastLine(message.lines)?.text;
        if (text) showCaption(text);
      } catch (error) {
        ack(`display-error:${String(error).slice(0, 60)}`, true);
      }
      return false;
    }

    if (message.type === "LIVE_SUBTITLES") {
      if (!belongsToActiveSession(message)) return false;
      try {
        if (translateOn) return false;
        if (!acceptSeq(message.seq)) return false;
        const text = lastLine(message.lines)?.text;
        if (text) showCaption(text);
      } catch (error) {
        ack(`display-error:${String(error).slice(0, 60)}`, true);
      }
      return false;
    }

    if (message.type === "LIVE_TRANSLATED") {
      if (!belongsToActiveSession(message)) return false;
      try {
        if (!translateOn) return false;
        if (!acceptSeq(message.seq)) return false;
        const text = lastLine(message.lines)?.translated;
        if (text) showCaption(text);
      } catch (error) {
        ack(`display-error:${String(error).slice(0, 60)}`, true);
      }
      return false;
    }

    if (message.type === "LIVE_STOP") {
      if (!belongsToActiveSession(message)) return false;
      hideStatus();
      resetCaption();
      return false;
    }
    return false;
  });

  // 页面加载即通知后台；加载慢则每 3 秒重试（最多 10 次）
  chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  ack("ready", true);
  let pageReadyAttempts = 0;
  window.setInterval(() => {
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：停止工作
    if (pageReadyAttempts >= 10) return;
    pageReadyAttempts += 1;
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, 3_000);

  document.addEventListener("play", (event) => {
    if (window.__koeLoaded !== CONTENT_VERSION) return;
    const target = event.target;
    if (!(target instanceof HTMLVideoElement) || target.muted) return;
    const now = Date.now();
    if (now - lastPageReadyAt < 3_000) return;
    lastPageReadyAt = now;
    chrome.runtime.sendMessage({ type: "PAGE_READY" }).catch(() => undefined);
  }, true);

  document.addEventListener("emptied", (event) => {
    if (window.__koeLoaded !== CONTENT_VERSION) return;
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" }).catch(() => undefined);
  }, true);

  // 周期检测：源/URL 变化 → 通知后台重连识别；正在播放且未静音 → 触发实时字幕
  window.setInterval(trackVideoSource, 1_000);
  function trackVideoSource() {
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：停止工作
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
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：停止工作
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
    if (window.__koeLoaded !== CONTENT_VERSION) return; // 旧副本：不得把旧字幕层重新挂回页面
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

  // ===== 浮动字幕卡片（主显示）：玻璃质感、可拖拽、位置记忆 =====
  function belongsToActiveSession(message) {
    const jobId = String(message.jobId || "");
    return !jobId || !activeJobId || jobId === activeJobId;
  }

  function lastLine(lines) {
    return Array.isArray(lines) ? lines[lines.length - 1] : null;
  }

  function acceptSeq(seq) {
    const value = Number(seq);
    if (!Number.isFinite(value)) return true;
    if (value <= latestSeq) return false;
    latestSeq = value;
    return true;
  }

  function showCaption(text) {
    captionEl.textContent = text;
    captionEl.hidden = false;
    // 让高度动画生效：先移除再添加 visible
    captionEl.classList.remove("visible");
    requestAnimationFrame(() => captionEl.classList.add("visible"));
    clearTimeout(captionHideTimer);
    captionHideTimer = setTimeout(() => {
      captionEl.classList.remove("visible");
    }, 6_000);
  }

  function resetCaption() {
    clearTimeout(captionHideTimer);
    latestSeq = 0;
    captionEl.textContent = "";
    captionEl.classList.remove("visible");
    captionEl.hidden = true;
  }

  // 拖拽：按住字幕卡片可移动到任意位置，位置保存在本地，下次沿用
  (function initCaptionDrag() {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    chrome.storage.local.get("koeCaptionPos").then(({ koeCaptionPos }) => {
      if (koeCaptionPos && Number.isFinite(koeCaptionPos.left) && Number.isFinite(koeCaptionPos.top)) {
        captionEl.classList.add("dragged");
        captionEl.style.left = `${koeCaptionPos.left}px`;
        captionEl.style.top = `${koeCaptionPos.top}px`;
      }
    }).catch(() => undefined);

    captionEl.addEventListener("pointerdown", (event) => {
      dragging = true;
      captionEl.classList.add("dragging");
      captionEl.setPointerCapture(event.pointerId);
      const rect = captionEl.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
    });
    captionEl.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      captionEl.classList.add("dragged");
      captionEl.style.left = `${Math.round(event.clientX - offsetX)}px`;
      captionEl.style.top = `${Math.round(event.clientY - offsetY)}px`;
    });
    captionEl.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      captionEl.classList.remove("dragging");
      const left = Number.parseFloat(captionEl.style.left);
      const top = Number.parseFloat(captionEl.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        chrome.storage.local.set({ koeCaptionPos: { left, top } }).catch(() => undefined);
      }
    });
  })();

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
