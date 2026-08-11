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
      .stage { position: fixed; left: 50%; bottom: 9vh; transform: translate(-50%, 12px); opacity: 0; transition: opacity .28s ease, transform .28s ease; max-width: min(760px, 76vw); text-align: center; color: #fbf4df; font-family: Georgia, 'Songti SC', serif; }
      .stage.visible { opacity: 1; transform: translate(-50%, 0); }
      .eyebrow { display: inline-flex; align-items: center; gap: 7px; margin-bottom: 9px; padding: 5px 10px; border: 1px solid rgba(242, 226, 181, .28); border-radius: 99px; background: rgba(25, 35, 30, .72); color: #d8e58c; font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .13em; text-transform: uppercase; backdrop-filter: blur(14px); }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: #c5d865; box-shadow: 0 0 0 4px rgba(197, 216, 101, .14); }
      .card { padding: 15px 24px 17px; border: 1px solid rgba(255, 248, 224, .18); border-radius: 14px; background: linear-gradient(135deg, rgba(20, 29, 25, .94), rgba(43, 49, 37, .84)); box-shadow: 0 18px 60px rgba(0, 0, 0, .32); }
      .text { margin: 0; font-size: clamp(19px, 2.2vw, 30px); line-height: 1.34; letter-spacing: .03em; text-shadow: 0 2px 16px rgba(0, 0, 0, .38); }
      .meta { margin-top: 9px; color: rgba(251, 244, 223, .56); font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; }
    </style>
    <div class="stage" aria-live="polite" aria-atomic="true">
      <div class="eyebrow"><span class="dot"></span><span class="label">KOE · LISTENING</span></div>
      <div class="card"><p class="text"></p><div class="meta"></div></div>
    </div>
  `;

  const stage = shadow.querySelector(".stage");
  const text = shadow.querySelector(".text");
  const meta = shadow.querySelector(".meta");
  const label = shadow.querySelector(".label");
  let hideTimer;
  let running = false;

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "PING") return;
    if (message.type === "CAPTURE_STATUS") {
      running = message.status === "running";
      if (!running) hide();
      label.textContent = running ? "KOE · LISTENING" : "KOE";
    }
    if (message.type === "CAPTURE_ERROR") {
      running = false;
      show("字幕服务连接失败", message.error || "请检查本地服务是否已启动。", "ERROR");
    }
    if (message.type === "SUBTITLE" && message.line) {
      running = true;
      show(message.line.text, `${message.line.provider || "caption"} · ${formatTime(message.line.startMs)}`, "LISTENING");
    }
  });

  window.setInterval(() => {
    const video = document.querySelector("video");
    if (!video) return;
    chrome.runtime.sendMessage({
      type: "VIDEO_CLOCK",
      currentTimeMs: Math.round(video.currentTime * 1_000),
      paused: video.paused,
      playbackRate: video.playbackRate
    }).catch(() => undefined);
  }, 750);

  function show(value, detail, mode) {
    text.textContent = value;
    meta.textContent = detail;
    label.textContent = `KOE · ${mode}`;
    stage.classList.add("visible");
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!running) hide();
    }, 12_000);
  }

  function hide() {
    stage.classList.remove("visible");
  }

  function formatTime(value) {
    const total = Math.max(0, Math.round(Number(value || 0) / 1_000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }
})();
