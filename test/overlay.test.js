const fs = require("fs");
const vm = require("vm");
let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};

function makeClassList() {
  const values = new Set();
  return {
    add: (value) => values.add(value),
    remove: (value) => values.delete(value),
    toggle: (value, force) => force ? values.add(value) : values.delete(value),
    contains: (value) => values.has(value)
  };
}

function makeElement(tag = "div") {
  const element = {
    tag, id: "", hidden: false, isConnected: false, parentNode: null, textContent: "",
    children: [],
    style: { setProperty() {} }, classList: makeClassList(),
    appendChild(child) { this.children.push(child); child.parentNode = this; child.isConnected = true; return child; },
    getBoundingClientRect: () => ({ left: 100, bottom: 700, width: 900, height: 500 })
  };
  element.attachShadow = () => {
    const nodes = {
      ".stage": makeElement("stage"),
      ".original": makeElement("original"),
      ".translation": makeElement("translation"),
      ".notice": makeElement("notice"),
      ".notice-title": makeElement("notice-title"),
      ".notice-detail": makeElement("notice-detail")
    };
    element.shadowRoot = { innerHTML: "", querySelector: (selector) => nodes[selector] };
    return element.shadowRoot;
  };
  return element;
}

(async () => {
  const messageListeners = [];
  const documentListeners = {};
  let now = 10_000;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimer = (callback, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { callback, due: now + Number(delay || 0) });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = (milliseconds) => {
    const end = now + milliseconds;
    while (true) {
      const pending = [...timers.entries()]
        .filter(([, timer]) => timer.due <= end)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!pending) break;
      const [id, timer] = pending;
      timers.delete(id);
      now = timer.due;
      timer.callback();
    }
    now = end;
  };
  class FakeDate extends Date {
    static now() { return now; }
  }
  const root = makeElement("html");
  root.isConnected = true;
  root.clientWidth = 1280;
  root.clientHeight = 800;
  const video = makeElement("video");
  Object.assign(video, { videoWidth: 1280, videoHeight: 720, currentSrc: "https://cdn.test/movie.mp4", paused: false, muted: false, readyState: 4 });
  class HTMLVideoElement {}
  Object.setPrototypeOf(video, HTMLVideoElement.prototype);
  const document = {
    documentElement: root,
    fullscreenElement: null,
    querySelectorAll: (selector) => selector === "video" ? [video] : [],
    createElement: (tag) => makeElement(tag),
    addEventListener: (type, listener) => { documentListeners[type] = listener; }
  };
  const ctx = {
    console, Date: FakeDate, JSON, String, Number, Boolean, Promise, Math, URL, Array,
    location: { href: "https://example.test/watch" },
    history: { pushState() {}, replaceState() {} },
    HTMLVideoElement,
    document,
    window: {
      __koeLoaded: undefined,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      setInterval: () => 0,
      setTimeout: setTimer,
      clearTimeout: clearTimer
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        onMessage: { addListener: (listener) => messageListeners.push(listener) },
        sendMessage: async () => ({ ok: true })
      },
      storage: {
        local: { get: async () => ({ koeOverlayEnabled: true, koeOverlaySize: "medium" }) },
        onChanged: { addListener() {} }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("content.js", "utf8"), ctx, { filename: "content.js" });
  const send = (message) => messageListeners.forEach((listener) => listener(message));

  // 页面级状态与字幕是两套独立展示：需要操作/不支持必须一直留在视频右上角，
  // 直到重试成功、换源或停止，不能像字幕一样几秒后自动消失。
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-wait", mediaEpoch: 1,
    kind: "action", issueCode: "needs_tab_audio",
    title: "点一下 Koe 继续", detail: "当前播放器需要一次标签页声音授权。"
  });
  const statusOverlay = root.children[0];
  const notice = statusOverlay.shadowRoot.querySelector(".notice");
  check(notice.classList.contains("visible"), "recoverable media status shows a persistent page notice");
  check(statusOverlay.shadowRoot.querySelector(".notice-title").textContent === "点一下 Koe 继续",
    "recoverable notice keeps the exact action title");
  check(statusOverlay.shadowRoot.querySelector(".notice-detail").textContent === "当前播放器需要一次标签页声音授权。",
    "recoverable notice keeps the exact action detail");
  advance(30_000);
  check(notice.classList.contains("visible"), "media notice does not auto-hide with subtitle timers");

  send({ type: "OFFLINE_SESSION", jobId: "offline-wait", mediaEpoch: 1, translate: true });
  check(notice.classList.contains("visible"), "the matching session does not erase an action status that arrived first");
  send({ type: "OFFLINE_SESSION", jobId: "offline-wait", mediaEpoch: 1, translate: true });
  check(notice.classList.contains("visible"), "same-session heartbeats keep the persistent action notice visible");
  send({ type: "OFFLINE_SESSION", jobId: "offline-wait", mediaEpoch: 2, translate: true });
  check(!notice.classList.contains("visible"), "new offline session clears the action notice");
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-wait", mediaEpoch: 2,
    kind: "error", issueCode: "unsupported_audio",
    title: "暂不支持此音轨", detail: "这个播放器没有可读取的音频格式。"
  });
  check(notice.classList.contains("visible"), "terminal media issue shows a persistent page notice");
  check(statusOverlay.shadowRoot.querySelector(".notice-title").textContent === "暂不支持此音轨",
    "terminal notice states that the audio is unsupported");
  send({
    type: "OFFLINE_CUES", jobId: "offline-wait", mediaEpoch: 2, revision: 1,
    cues: [{ cueId: "recovered", startMs: 0, endMs: 1_000, text: "Recovered." }]
  });
  check(!notice.classList.contains("visible"), "successful cues clear the terminal notice");

  send({ type: "LIVE_SESSION", jobId: "job-1", mediaEpoch: 3, translate: true });
  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 1, unit: true, lines: [{ text: "Original line" }] });
  const overlay = root.children[0];
  check(overlay.shadowRoot.querySelector(".original").textContent === "Original line", "current epoch original renders");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 2, seq: 1, unit: true, lines: [{ translated: "旧字幕" }] });
  check(overlay.shadowRoot.querySelector(".translation").textContent === "", "stale epoch translation rejected");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 3, seq: 1, unit: true, lines: [{ translated: "当前字幕" }] });
  check(overlay.shadowRoot.querySelector(".translation").textContent === "当前字幕", "current translation renders");

  send({ type: "LIVE_SESSION", jobId: "epoch-job", mediaEpoch: 10, translate: true });
  send({
    type: "KOE_MEDIA_STATUS", jobId: "epoch-job", mediaEpoch: 10,
    kind: "error", issueCode: "capture_failed",
    title: "字幕启动失败", detail: "当前时间线暂时不可用。"
  });
  send({ type: "LIVE_SESSION", jobId: "epoch-job", mediaEpoch: 9, translate: true });
  send({ type: "LIVE_STOP", jobId: "epoch-job", mediaEpoch: 9 });
  check(notice.classList.contains("visible"), "an older-epoch stop cannot clear the current live notice");
  send({
    type: "LIVE_SUBTITLES", jobId: "epoch-job", mediaEpoch: 10, seq: 1, unit: true,
    lines: [{ text: "Current epoch still active" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Current epoch still active",
    "an older session followed by its stop cannot terminate the current live session");
  send({ type: "LIVE_STOP", jobId: "epoch-job", mediaEpoch: 10 });
  send({ type: "LIVE_SESSION", jobId: "job-1", mediaEpoch: 3, translate: true });

  send({
    type: "KOE_MEDIA_STATUS", jobId: "job-1", mediaEpoch: 3,
    kind: "error", issueCode: "unsupported_audio",
    title: "暂不支持此音轨", detail: "这个播放器没有可读取的音频格式。"
  });
  send({
    type: "LIVE_STOP", jobId: "job-1", mediaEpoch: 3,
    issueCode: "unsupported_audio", error: "这个播放器没有可读取的音频格式。"
  });
  check(notice.classList.contains("visible"), "terminal live stop preserves the visible failure reason");
  send({ type: "LIVE_STOP", jobId: "older-job", mediaEpoch: 99 });
  check(notice.classList.contains("visible"), "a stale stop from another job cannot clear the current failure notice");
  send({ type: "LIVE_STOP", jobId: "job-1", mediaEpoch: 3 });
  check(!notice.classList.contains("visible"), "an explicit normal live stop clears the failure notice");

  send({ type: "LIVE_SESSION", jobId: "job-1", mediaEpoch: 3, translate: true });

  const longDraft = "This draft keeps growing while somebody speaks continuously and it should become a rolling readable viewport instead of filling the video with several lines of source text.";
  send({ type: "LIVE_PARTIAL", jobId: "job-1", mediaEpoch: 3, seq: 2, lines: [{ text: longDraft }] });
  const rollingDraft = overlay.shadowRoot.querySelector(".original").textContent;
  check(
    rollingDraft !== longDraft
      && rollingDraft.replace(/\s+/g, " ").includes("several lines of source text.")
      && rollingDraft.split("\n").length <= 2,
    "long source draft rolls forward to the newest two semantic lines"
  );

  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 3, unit: true, lines: [{ text: "Second final unit" }] });
  check(
    overlay.shadowRoot.querySelector(".original").textContent === "Second final unit",
    "an immediate second unit renders without an artificial reading delay"
  );
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 3, seq: 3, unit: true, lines: [{ translated: "第二条字幕" }] });
  check(
    overlay.shadowRoot.querySelector(".translation").textContent === "第二条字幕",
    "translation stays paired with the immediately visible source"
  );

  advance(1_200);
  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 4, unit: true, lines: [{ text: "Normally timed unit" }] });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Normally timed unit", "normally timed units still render immediately");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 3, seq: 4, unit: true, streaming: true, lines: [{ translated: "首个流式译文" }] });
  check(overlay.shadowRoot.querySelector(".translation").textContent === "首个流式译文",
    "the first streaming translation for a stable unit is immediately visible");
  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 4, unit: true, lines: [{ text: "Duplicate must not replace" }] });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Normally timed unit",
    "a duplicate stable sequence cannot overwrite the visible cue");
  send({ type: "LIVE_REVOKE", jobId: "job-1", mediaEpoch: 3, fromSeq: 4, toSeq: 4 });
  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 3, unit: true, lines: [{ text: "Stale after revoke" }] });
  check(overlay.shadowRoot.querySelector(".original").textContent === "",
    "revoke clears the cue without lowering the stale-message high-water mark");

  const fullscreenRoot = makeElement("fullscreen");
  document.fullscreenElement = fullscreenRoot;
  documentListeners.fullscreenchange();
  check(overlay.parentNode === fullscreenRoot, "overlay remounts into fullscreen subtree");
  document.fullscreenElement = null;
  documentListeners.fullscreenchange();
  check(overlay.parentNode === root, "overlay returns to document after fullscreen");

  Object.assign(video, { currentTime: 171.5, duration: 1_793, playbackRate: 1 });
  send({ type: "OFFLINE_SESSION", jobId: "offline-1", mediaEpoch: 5, translate: true });
  send({
    type: "OFFLINE_CUES", jobId: "offline-1", mediaEpoch: 5, revision: 1,
    cues: [{ cueId: "cue-1", startMs: 171_000, endMs: 173_000, text: "Complete local source.", translated: "完整的本地字幕。" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Complete local source.",
    "offline cue renders from the absolute video clock");
  check(overlay.shadowRoot.querySelector(".translation").textContent === "完整的本地字幕。",
    "offline translation stays paired with its cue");
  video.currentTime = 174;
  documentListeners.timeupdate({ target: video });
  check(overlay.shadowRoot.querySelector(".original").textContent === "", "offline cue clears exactly after its media end time");
  send({ type: "OFFLINE_RESET", jobId: "offline-1", mediaEpoch: 6 });
  video.currentTime = 171.5;
  send({
    type: "OFFLINE_CUES", jobId: "offline-1", mediaEpoch: 5, revision: 2,
    cues: [{ cueId: "stale", startMs: 171_000, endMs: 173_000, text: "Stale cue." }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "", "old offline epoch cannot reappear after seek");
  send({ type: "OFFLINE_RESET", jobId: "offline-1", mediaEpoch: 5 });
  send({ type: "OFFLINE_STOP", jobId: "offline-1", mediaEpoch: 5 });
  send({
    type: "OFFLINE_CUES", jobId: "offline-1", mediaEpoch: 6, revision: 1,
    cues: [{ cueId: "current-6", startMs: 171_000, endMs: 175_000, text: "Current epoch survives." }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Current epoch survives.",
    "late reset and stop control messages cannot roll back or end a newer epoch");

  send({ type: "OFFLINE_RESET", jobId: "offline-1", mediaEpoch: 7 });
  send({
    type: "OFFLINE_CUES", jobId: "offline-1", mediaEpoch: 7, revision: 1,
    cues: [
      { cueId: "long", startMs: 170_000, endMs: 176_000, text: "Long active cue." },
      { cueId: "short", startMs: 171_000, endMs: 172_000, text: "Short overlap." }
    ]
  });
  video.currentTime = 174;
  documentListeners.timeupdate({ target: video });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Long active cue.",
    "an ended short overlap does not hide an earlier cue that is still active");

  documentListeners.emptied({ target: video });
  check(overlay.shadowRoot.querySelector(".original").textContent === "",
    "a media source change freezes and clears old offline cues immediately");
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-1", mediaEpoch: 7,
    kind: "action", issueCode: "needs_tab_audio",
    title: "点一下 Koe 继续", detail: "需要重新取得标签页声音。"
  });
  documentListeners.emptied({ target: video });
  check(!notice.classList.contains("visible"), "a media source change clears the page notice");
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-1", mediaEpoch: 7,
    kind: "error", issueCode: "media_unreadable",
    title: "暂时无法读取这个视频", detail: "请重试。"
  });
  send({ type: "OFFLINE_STOP", jobId: "offline-1", mediaEpoch: 7 });
  check(!notice.classList.contains("visible"), "stopping a session clears the page notice");

  console.log(fail === 0 ? "overlay regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
