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
      ".translation": makeElement("translation")
    };
    element.shadowRoot = { innerHTML: "", querySelector: (selector) => nodes[selector] };
    return element.shadowRoot;
  };
  return element;
}

(async () => {
  const messageListeners = [];
  const documentListeners = {};
  const sentMessages = [];
  let storageChangeListener = null;
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
  const videos = [video];
  const document = {
    documentElement: root,
    fullscreenElement: null,
    querySelectorAll: (selector) => selector === "video" ? videos : [],
    createElement: (tag) => makeElement(tag),
    addEventListener: (type, listener) => {
      const previous = documentListeners[type];
      documentListeners[type] = previous
        ? (event) => { previous(event); listener(event); }
        : listener;
    }
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
        sendMessage: async (message) => { sentMessages.push(message); return { ok: true }; }
      },
      storage: {
        local: { get: async () => ({ koeOverlayEnabled: true, koeOverlaySize: "medium" }) },
        onChanged: { addListener(listener) { storageChangeListener = listener; } }
      }
    }
  };
  vm.createContext(ctx);
  const contentSource = fs.readFileSync("content.js", "utf8");
  const instrumentedContent = contentSource.replace(/\n\}\)\(\);\s*$/, `
    window.__koeTest = { findCueAt, findVideo, mergeOfflineCues, resetOfflineCues };
  })();`);
  check(instrumentedContent !== contentSource, "content test hooks are injected into the IIFE");
  vm.runInContext(instrumentedContent, ctx, { filename: "content.js" });
  const send = (message) => messageListeners.forEach((listener) => listener(message));

  // 操作提示和错误状态属于 Koe 控制器，不能为了显示状态而在视频页挂载 UI。
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-wait", mediaEpoch: 1,
    kind: "action", issueCode: "needs_tab_audio",
    title: "点一下 Koe 继续", detail: "当前播放器需要一次标签页声音授权。"
  });
  check(root.children.length === 0, "recoverable media status does not mount an in-video notice");
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-wait", mediaEpoch: 1,
    kind: "error", issueCode: "unsupported_audio",
    title: "暂不支持此音轨", detail: "这个播放器没有可读取的音频格式。"
  });
  check(root.children.length === 0, "terminal media status does not mount an in-video notice");

  send({ type: "OFFLINE_SESSION", jobId: "offline-wait", mediaEpoch: 2, translate: true });
  const overlay = root.children[0];
  check(!overlay.shadowRoot.innerHTML.includes('class="notice"'),
    "the subtitle shadow tree contains no status-card markup");
  send({
    type: "OFFLINE_CUES", jobId: "offline-wait", mediaEpoch: 2, revision: 1,
    cues: [{ cueId: "recovered", startMs: 0, endMs: 1_000, text: "Recovered." }]
  });

  send({ type: "LIVE_SESSION", jobId: "job-1", mediaEpoch: 3, translate: true });
  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 1, unit: true, lines: [{ text: "Original line" }] });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Original line", "current epoch original renders");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 2, seq: 1, unit: true, lines: [{ translated: "旧字幕" }] });
  check(overlay.shadowRoot.querySelector(".translation").textContent === "", "stale epoch translation rejected");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 3, seq: 1, unit: true, lines: [{ translated: "当前字幕" }] });
  check(overlay.shadowRoot.querySelector(".translation").textContent === "当前字幕", "current translation renders");

  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 2, unit: true,
    lines: [{ text: "Same language caption" }] });
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 3, seq: 2, unit: true,
    lines: [{ translated: "  Same   language caption  " }] });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Same language caption"
      && overlay.shadowRoot.querySelector(".translation").textContent === "",
    "same-language passthrough collapses to one original overlay line");
  storageChangeListener?.({ koeHideOriginal: { newValue: true } }, "local");
  check(overlay.shadowRoot.querySelector(".original").textContent === "Same language caption"
      && overlay.shadowRoot.querySelector(".original").style.display !== "none"
      && overlay.shadowRoot.querySelector(".translation").textContent === "",
    "hide-original cannot hide the only same-language caption line");
  send({ type: "LIVE_SUBTITLES", jobId: "job-1", mediaEpoch: 3, seq: 3, unit: true,
    lines: [{ text: "Original stays while translation is pending" }] });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Original stays while translation is pending"
      && overlay.shadowRoot.querySelector(".original").style.display !== "none"
      && overlay.shadowRoot.querySelector(".translation").textContent === "",
    "hide-original keeps a usable original line until a real translation exists");
  send({ type: "LIVE_TRANSLATED", jobId: "job-1", mediaEpoch: 3, seq: 3, unit: true,
    lines: [{ translated: "译文到达后再隐藏原文" }] });
  check(overlay.shadowRoot.querySelector(".original").style.display === "none"
      && overlay.shadowRoot.querySelector(".translation").textContent === "译文到达后再隐藏原文",
    "hide-original switches to the real translation once it arrives");
  storageChangeListener?.({ koeHideOriginal: { newValue: false } }, "local");

  video.currentTime = 20;
  send({
    type: "LIVE_SESSION", jobId: "timed-live", mediaEpoch: 1, translate: true,
    mediaTimed: true, discontinuityId: 7
  });
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-live", mediaEpoch: 1, seq: 1, unit: true, mediaTimed: true,
    beginTimeMs: 12_000, endTimeMs: 13_900, audioPositionMs: 13_900,
    lines: [{ text: "Late local caption remains readable" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Late local caption remains readable",
    "local captions are not discarded when recognition finishes behind the player clock");
  advance(3_100);
  check(overlay.shadowRoot.querySelector(".stage").classList.contains("visible"),
    "late local captions retain a readable display window");
  advance(100);
  check(!overlay.shadowRoot.querySelector(".stage").classList.contains("visible"),
    "late local captions still expire instead of lingering over a new scene");
  video.currentTime = 120;
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-live", mediaEpoch: 1, seq: 2, unit: true, mediaTimed: true,
    beginTimeMs: 12_000, endTimeMs: 13_900, audioPositionMs: 120_000,
    lines: [{ text: "Extremely stale caption" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Late local caption remains readable",
    "media-timed live cues beyond the maximum wall-clock delay are discarded");
  video.currentTime = 13.2;
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-live", mediaEpoch: 1, seq: 3, unit: true, mediaTimed: true,
    beginTimeMs: 12_000, endTimeMs: 13_900, audioPositionMs: 13_900,
    lines: [{ text: "Still close to the scene" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Still close to the scene",
    "media-timed live cues still render while the video is close to their time range");
  advance(3_200);
  check(!overlay.shadowRoot.querySelector(".stage").classList.contains("visible"),
    "media-timed live cues do not linger after their short display window");
  send({
    type: "LIVE_TRANSLATED", jobId: "timed-live", mediaEpoch: 1, seq: 3, unit: true, mediaTimed: true,
    beginTimeMs: 12_000, endTimeMs: 13_900, audioPositionMs: 13_900,
    lines: [{ translated: "迟到的翻译" }]
  });
  check(!overlay.shadowRoot.querySelector(".stage").classList.contains("visible"),
    "a late media-timed translation cannot make an expired cue reappear");
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-live", mediaEpoch: 1, seq: 4, unit: true, mediaTimed: true,
    beginTimeMs: 18_000, endTimeMs: 20_000, audioPositionMs: 20_000,
    lines: [{ text: "Too early for this scene" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Still close to the scene",
    "media-timed live cues are not shown before the video reaches them");

  video.currentTime = 30;
  video.playbackRate = 1.5;
  documentListeners.ratechange({ target: video });
  const rateReset = sentMessages.filter((message) => message.type === "MEDIA_DISCONTINUITY").at(-1);
  check(rateReset?.reason === "ratechange" && rateReset.currentTime === 30
      && rateReset.playbackRate === 1.5 && rateReset.discontinuityId === 8,
    "playback-rate changes reanchor local live subtitles to the video clock");
  send({ type: "LIVE_SESSION", jobId: "timed-live", mediaEpoch: 1, translate: true, mediaTimed: true });
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-live", mediaEpoch: 1, seq: 5, unit: true, mediaTimed: true,
    beginTimeMs: 30_000, endTimeMs: 31_000, audioPositionMs: 31_000,
    lines: [{ text: "Must wait for the new clock" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "",
    "same-epoch session maintenance cannot reopen captions during a clock reset");
  send({ type: "LIVE_RESET", jobId: "timed-live", mediaEpoch: 2, reason: "ratechange" });
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-live", mediaEpoch: 2, seq: 1, unit: true, mediaTimed: true,
    beginTimeMs: 30_000, endTimeMs: 31_000, audioPositionMs: 31_000,
    lines: [{ text: "New clock is ready" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "New clock is ready",
    "media-timed captions resume after the fresh epoch arrives");

  video.currentTime = 20;
  video.playbackRate = 2;
  send({ type: "LIVE_SESSION", jobId: "timed-2x", mediaEpoch: 1, translate: true, mediaTimed: true });
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-2x", mediaEpoch: 1, seq: 1, unit: true, mediaTimed: true,
    beginTimeMs: 16_000, endTimeMs: 17_000, audioPositionMs: 20_000,
    lines: [{ text: "Within two-times wall-clock grace" }]
  });
  check(overlay.shadowRoot.querySelector(".original").textContent === "Within two-times wall-clock grace",
    "media-timed lateness is measured in wall time at two-times playback");
  send({
    type: "LIVE_SUBTITLES", jobId: "timed-2x", mediaEpoch: 1, seq: 2, unit: true, mediaTimed: true,
    beginTimeMs: 20_000, endTimeMs: 22_000, audioPositionMs: 22_000,
    lines: [{ text: "Two-times display duration" }]
  });
  advance(2_250);
  check(!overlay.shadowRoot.querySelector(".stage").classList.contains("visible"),
    "media-timed hide timers convert remaining media time at two-times playback");
  video.currentTime = 0;
  video.playbackRate = 1;

  send({ type: "LIVE_SESSION", jobId: "epoch-job", mediaEpoch: 10, translate: true });
  send({
    type: "KOE_MEDIA_STATUS", jobId: "epoch-job", mediaEpoch: 10,
    kind: "error", issueCode: "capture_failed",
    title: "字幕启动失败", detail: "当前时间线暂时不可用。"
  });
  send({ type: "LIVE_SESSION", jobId: "epoch-job", mediaEpoch: 9, translate: true });
  send({ type: "LIVE_STOP", jobId: "epoch-job", mediaEpoch: 9 });
  check(!overlay.shadowRoot.querySelector(".notice"), "media errors remain absent from the active video overlay");
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
  send({ type: "LIVE_STOP", jobId: "older-job", mediaEpoch: 99 });
  send({ type: "LIVE_STOP", jobId: "job-1", mediaEpoch: 3 });
  check(!overlay.shadowRoot.querySelector(".notice"), "terminal stops cannot add a status card to the video");

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

  let videoLayoutReads = 0;
  video.getBoundingClientRect = () => {
    videoLayoutReads += 1;
    return { left: 100, bottom: 700, width: 900, height: 500 };
  };
  const largerVideo = makeElement("video");
  Object.assign(largerVideo, {
    videoWidth: 1920, videoHeight: 1080, currentTime: 321, duration: 1_000,
    currentSrc: "https://cdn.test/main.m3u8", paused: false, muted: false, readyState: 4,
    getBoundingClientRect: () => {
      videoLayoutReads += 1;
      return { left: 0, bottom: 720, width: 1280, height: 720 };
    }
  });
  Object.setPrototypeOf(largerVideo, HTMLVideoElement.prototype);
  const adVideo = makeElement("video");
  Object.assign(adVideo, {
    videoWidth: 3840, videoHeight: 2160, currentTime: 999, duration: 1_000,
    currentSrc: "https://cdn.test/preroll.m3u8", paused: false, muted: false, readyState: 4,
    parentElement: { id: "preroll-ad", className: "advert-player", parentElement: null },
    getBoundingClientRect: () => {
      videoLayoutReads += 1;
      return { left: 0, bottom: 720, width: 1920, height: 1080 };
    }
  });
  Object.setPrototypeOf(adVideo, HTMLVideoElement.prototype);
  videos.push(largerVideo, adVideo);
  send({ type: "OFFLINE_DISCOVER", jobId: "offline-1" });
  const discoveredContext = sentMessages.filter((message) => message.type === "MEDIA_CONTEXT").at(-1);
  check(discoveredContext?.currentTimeMs === 321_000,
    "video selection prefers the largest real player over a larger ad player");
  check(videoLayoutReads === videos.length,
    `video selection reads layout once per candidate (actual ${videoLayoutReads}/${videos.length})`);
  videos.splice(1);

  const cueIndex = ctx.window.__koeTest;
  cueIndex.resetOfflineCues();
  cueIndex.mergeOfflineCues([
    { cueId: "long-prefix", startMs: 0, endMs: 10_000, text: "Long prefix." },
    { cueId: "ended-overlap", startMs: 5_000, endMs: 6_000, text: "Ended overlap." }
  ], 1);
  check(cueIndex.findCueAt(7_000)?.cueId === "long-prefix",
    "cue prefix index still finds an earlier long overlap");
  const cappedCues = Array.from({ length: 2_001 }, (_, index) => ({
    cueId: `cap-${index}`, startMs: index * 1_000, endMs: index * 1_000 + 500, text: `Cue ${index}`
  }));
  cueIndex.resetOfflineCues();
  cueIndex.mergeOfflineCues(cappedCues, 1);
  check(cueIndex.findCueAt(100) === null && cueIndex.findCueAt(2_000_100)?.cueId === "cap-2000",
    "cue prefix index stays aligned after the 2,000-cue cap");

  documentListeners.emptied({ target: video });
  check(overlay.shadowRoot.querySelector(".original").textContent === "",
    "a media source change freezes and clears old offline cues immediately");
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-1", mediaEpoch: 7,
    kind: "action", issueCode: "needs_tab_audio",
    title: "点一下 Koe 继续", detail: "需要重新取得标签页声音。"
  });
  documentListeners.emptied({ target: video });
  send({
    type: "KOE_MEDIA_STATUS", jobId: "offline-1", mediaEpoch: 7,
    kind: "error", issueCode: "media_unreadable",
    title: "暂时无法读取这个视频", detail: "请重试。"
  });
  send({ type: "OFFLINE_STOP", jobId: "offline-1", mediaEpoch: 7 });
  check(!overlay.shadowRoot.querySelector(".notice"), "source changes and stops keep the video free of status cards");

  console.log(fail === 0 ? "overlay regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
