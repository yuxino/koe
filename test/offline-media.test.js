const fs = require("fs");
const vm = require("vm");

let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function makeContext() {
  const sessionStore = {};
  const nativeMessages = [];
  const contentMessages = [];
  const nativeMessageListeners = [];
  const nativeDisconnectListeners = [];
  const requestListeners = [];
  const runtimeMessages = [];
  const events = [];
  const localConfig = { koeCaptureSource: "tab", koeAsrEngine: "local", koeTranslate: true };
  const port = {
    postMessage(message) {
      nativeMessages.push(JSON.parse(JSON.stringify(message)));
      events.push(`native:${message.type}`);
    },
    onMessage: { addListener(listener) { nativeMessageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { nativeDisconnectListeners.push(listener); } }
  };
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    chrome: {
      storage: {
        local: {
          get: async () => ({ ...localConfig }),
          set: async () => undefined
        },
        session: {
          get: async (keys) => {
            const result = {};
            for (const key of [].concat(keys)) result[key] = sessionStore[key];
            return result;
          },
          set: async (values) => Object.assign(sessionStore, JSON.parse(JSON.stringify(values)))
        }
      },
      runtime: {
        id: "test-extension-id",
        lastError: null,
        onMessage: { addListener: () => undefined },
        onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        sendMessage: async (message) => {
          runtimeMessages.push(JSON.parse(JSON.stringify(message)));
          events.push(`runtime:${message.type}`);
          return { ok: true };
        },
        connectNative: () => port,
        getURL: (path) => `chrome-extension://test/${path}`
      },
      webRequest: {
        onBeforeRequest: { addListener: (listener) => requestListeners.push(listener) }
      },
      alarms: { create: async () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        query: async () => [],
        sendMessage: async (tabId, message) => contentMessages.push({ tabId, message: JSON.parse(JSON.stringify(message)) }),
        onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
        onActivated: { addListener: () => undefined }
      },
      contextMenus: { create: () => undefined, remove: (_id, callback) => callback?.(), onClicked: { addListener: () => undefined } },
      commands: { onCommand: { addListener: () => undefined } },
      action: { openPopup: async () => undefined, setPopup: async () => undefined, setBadgeText: async () => undefined },
      sidePanel: { open: async () => undefined, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
      tabCapture: { getMediaStreamId: async () => "stream" },
      scripting: { executeScript: async () => [] },
      offscreen: { createDocument: async () => undefined },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
    },
    fetch: async () => ({ ok: true })
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("background.js", "utf8"), ctx, { filename: "background.js" });
  return { ctx, sessionStore, nativeMessages, contentMessages, requestListeners, runtimeMessages, events, localConfig };
}

(async () => {
  const h = makeContext();
  const run = (source) => vm.runInContext(source, h.ctx);
  const signed = "https://video.example/media/master.m3u8?token=TOP_SECRET&hash=HASH_SECRET&hdnea=EDGE_SECRET&expires=999999";
  h.requestListeners[0]?.({ tabId: 4, frameId: 0, url: signed, timeStamp: Date.now() });
  check(run(`selectMediaCandidate(4, { frameId: 0, currentSrc: "blob:https://site.example/inactive", resourceUrls: [] })`) === null,
    "webRequest does not retain signed media URLs outside an active local session");
  run(`tabStates.set(5, {
    tabId: 5, frameId: 0, jobId: "offline-observer-5", mediaEpoch: 0,
    captureStarted: true, engine: "local", sessionMode: "offline"
  }); captureTabId = 5;`);
  h.requestListeners[0]?.({ tabId: 5, frameId: 0, url: signed, timeStamp: Date.now() });
  h.requestListeners[0]?.({ tabId: 5, frameId: 0, url: "https://doubleclick.net/ad/master.m3u8", timeStamp: Date.now() });
  const selected = run(`selectMediaCandidate(5, { frameId: 0, currentSrc: "blob:https://site.example/id", resourceUrls: [] })`);
  check(selected?.url === signed, "HLS discovery selects the real signed playlist and rejects an ad candidate");
  check(!run(`normalizeSourceKey(${JSON.stringify(signed)})`).includes("?"),
    "media fingerprint removes the complete signed query instead of relying on a token-name blacklist");
  const currentMp4 = "https://video.example/media/new.mp4?token=NEW_SECRET";
  const explicit = run(`selectMediaCandidate(5, { frameId: 0, currentSrc: ${JSON.stringify(currentMp4)}, resourceUrls: [] })`);
  check(explicit?.url === signed,
    "an unsupported MP4 currentSrc cannot displace a usable HLS playlist");
  const genericMaster = "https://video.example/title/master.m3u8";
  const generic1080 = "https://video.example/title/1080/high.m3u8";
  run(`mediaCandidatesByTab.delete(21);
    rememberMediaCandidate(21, { url: ${JSON.stringify(genericMaster)}, frameId: 0, source: "performance", seenAt: Date.now() - 50 });
    rememberMediaCandidate(21, { url: ${JSON.stringify(generic1080)}, frameId: 0, source: "webRequest", seenAt: Date.now() });`);
  const genericSelected = run(`selectMediaCandidate(21, { frameId: 0, currentSrc: "blob:https://site.example/id", resourceUrls: [] })`);
  check(genericSelected?.url === genericMaster,
    "a generic HLS master outranks a newer high-resolution media playlist");
  const inlineMaster = "https://media.example/preloaded/master.m3u8?token=INLINE_SECRET";
  const inlineSelected = run(`selectMediaCandidate(23, {
    frameId: 0,
    currentSrc: "blob:https://site.example/current",
    resourceUrls: [{
      url: ${JSON.stringify(inlineMaster)}, observedAt: Date.now(),
      source: "page-definition", quality: 0
    }]
  })`);
  check(inlineSelected?.url === inlineMaster && inlineSelected?.source === "page-definition",
    "a preloaded inline HLS definition remains discoverable after the performance window expires");
  check(run(`playlistStructureScore("https://cdndirector.dailymotion.com/path/title/master.m3u8")`)
      > run(`playlistStructureScore("https://dmxleo.dailymotion.com/path/title/master.m3u8")`),
    "Dailymotion's media director outranks its non-media .m3u8 metadata endpoint");
  check(run(`videoScore({ width: 989, height: 556, viewportArea: 549_884, inViewport: true, playing: false, muted: false })`)
      > run(`videoScore({ width: 950, height: 250, viewportArea: 0, inViewport: false, playing: true, muted: false })`),
    "an off-screen autoplay banner cannot outrank the visible main player");
  check(run(`normalizeOfflineCue({ startMs: 1_793_500, endMs: 1_794_000, text: "x" }, 1_793_000)`) === null,
    "duration clamping cannot create an inverted cue");

  run(`tabStates.set(5, {
    tabId: 5, frameId: 0, jobId: "offline-5", mediaEpoch: 2,
    captureStarted: true, status: "starting", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: ${JSON.stringify(signed)}, pageUrl: "https://site.example/watch", translate: true
  }); captureTabId = 5;`);
  await run(`persistStates()`);
  await settle();
  const persisted = h.sessionStore.koeTabs?.[0];
  check(persisted && !JSON.stringify(persisted).includes("TOP_SECRET"), "signed media URLs are not persisted in session state");

  const response = await run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-5", mediaEpoch: 2,
    currentSrc: "blob:https://site.example/id", resourceUrls: [${JSON.stringify(signed)}],
    currentTimeMs: 170_000, durationMs: 1_793_000, playbackRate: 1
  }, { tab: { id: 5 }, frameId: 0 })`);
  await settle();
  check(response.ok === true, "valid media context is accepted");
  const start = h.nativeMessages.find((message) => message.type === "start");
  const initialMediaKey = start?.mediaKey;
  check(start?.source?.url === signed, "the signed URL is sent only through the local native pipe");
  check(!String(start?.mediaKey || "").includes("TOP_SECRET"), "native cache key excludes the signature");
  check(!("cookie" in (start?.source?.headers || {})) && !("authorization" in (start?.source?.headers || {})),
    "native request never copies browser Cookie or Authorization headers");

  await run(`handleNativeMessage({
    type: "cues", jobId: "offline-5", mediaEpoch: 2, revision: 1,
    cues: [
      { cueId: "good", startMs: 171_000, endMs: 173_000, text: "Accurate local cue." },
      { cueId: "bad", startMs: 180_000, endMs: 20_000, text: "Broken timing." }
    ]
  })`);
  await settle();
  const cueMessage = h.contentMessages.find((entry) => entry.message.type === "OFFLINE_CUES")?.message;
  check(cueMessage?.cues?.length === 1 && cueMessage.cues[0].cueId === "good",
    "only valid absolute-time cues reach the page");

  h.runtimeMessages.length = 0;
  await run(`recordOfflineVisible({
    type: "OFFLINE_VISIBLE_REPORT", jobId: "offline-5", mediaEpoch: 2, currentTimeMs: 171_500,
    cue: { cueId: "good", startMs: 171_000, endMs: 173_000, text: "Accurate local cue." }
  }, { tab: { id: 5 }, frameId: 0 })`);
  await settle();
  check(h.runtimeMessages.some((message) => message.type === "OFFLINE_VISIBLE"
      && message.lines?.[0]?.text === "Accurate local cue."),
    "a local cue enters the side-panel stream only when playback reaches it");
  check(h.sessionStore.koeTranscript?.some((row) => row.sentenceId === "good"),
    "a visible local cue is retained in the session transcript");
  await run(`handleNativeMessage({
    type: "status", jobId: "offline-5", mediaEpoch: 2,
    stage: "forward", detail: "prefetching"
  })`);
  check(run(`tabStates.get(5).status`) === "live",
    "forward prefetch keeps the UI live after the first local cues are ready");

  const before = h.contentMessages.length;
  await run(`handleNativeMessage({
    type: "cues", jobId: "offline-5", mediaEpoch: 1, revision: 2,
    cues: [{ cueId: "stale", startMs: 10, endMs: 20, text: "Stale." }]
  })`);
  await settle();
  check(h.contentMessages.length === before, "a stale helper epoch is ignored");

  h.nativeMessages.length = 0;
  await run(`mediaDiscontinuity({
    type: "MEDIA_DISCONTINUITY", jobId: "offline-5", discontinuityId: 2, currentTime: 500
  }, { tab: { id: 5 }, frameId: 0 })`);
  await run(`mediaDiscontinuity({
    type: "MEDIA_DISCONTINUITY", jobId: "offline-5", discontinuityId: 1, currentTime: 100
  }, { tab: { id: 5 }, frameId: 0 })`);
  check(h.nativeMessages.some((message) => message.type === "cancel" && message.mediaEpoch === 2),
    "seeking cancels the previous Helper epoch");
  check(!h.nativeMessages.some((message) => message.type === "start")
      && h.contentMessages.some((entry) => entry.message.type === "OFFLINE_DISCOVER"
        && entry.message.mediaEpoch === 3),
    "seeking requests a fresh signed media address before restarting Helper");
  await run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-5", mediaEpoch: 3,
    currentSrc: "blob:https://site.example/id", resourceUrls: [${JSON.stringify(signed)}],
    currentTimeMs: 500_000, durationMs: 1_793_000, playbackRate: 1
  }, { tab: { id: 5 }, frameId: 0 })`);
  const seekStarts = h.nativeMessages.filter((message) => message.type === "start");
  check(seekStarts.length === 1 && seekStarts[0].currentTimeMs === 500_000,
    "the newest playback position restarts only after fresh media discovery");
  check(seekStarts[0]?.mediaKey === initialMediaKey,
    "seeking the same media reuses its private language-detection identity");
  h.nativeMessages.length = 0;
  await run(`mediaDiscontinuity({
    type: "MEDIA_DISCONTINUITY", jobId: "offline-5", mediaEpoch: 2,
    discontinuityId: 99, currentTime: 900
  }, { tab: { id: 5 }, frameId: 0 })`);
  check(run(`tabStates.get(5).mediaEpoch`) === 3 && h.nativeMessages.length === 0,
    "a late seek from an older media epoch cannot restart Helper at the stale position");

  const oldSigned = "https://video.example/media/master.m3u8?token=OLD";
  const freshSigned = "https://video.example/media/master.m3u8?token=FRESH";
  h.nativeMessages.length = 0;
  run(`tabStates.set(6, {
    tabId: 6, frameId: 0, jobId: "offline-6", mediaEpoch: 2,
    captureStarted: true, status: "starting", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: ${JSON.stringify(oldSigned)}, pageUrl: "https://site.example/watch",
    translate: false, offlineStartedEpoch: undefined, offlineSourceUrl: ""
  }); captureTabId = 6;
  chrome.scripting.executeScript = () => new Promise((resolve) => { globalThis.resolveOldDefinitions = resolve; });`);
  const staleContext = run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-6", mediaEpoch: 2,
    currentSrc: "blob:https://site.example/old", resourceUrls: [${JSON.stringify(oldSigned)}],
    currentTimeMs: 170_000, durationMs: 1_793_000, playbackRate: 1
  }, { tab: { id: 6 }, frameId: 0 })`);
  await settle();
  await run(`mediaDiscontinuity({
    type: "MEDIA_DISCONTINUITY", jobId: "offline-6", mediaEpoch: 2,
    discontinuityId: 1, currentTime: 500
  }, { tab: { id: 6 }, frameId: 0 })`);
  run(`resolveOldDefinitions([{ result: [{ url: ${JSON.stringify(oldSigned)}, quality: 240 }] }])`);
  await staleContext;
  await settle();
  check(!h.nativeMessages.some((message) => message.type === "start"),
    "an old media discovery cannot start Helper after a seek advances the epoch");
  run(`chrome.scripting.executeScript = async () => ([{
    result: [{ url: ${JSON.stringify(freshSigned)}, quality: 240 }]
  }])`);
  await run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-6", mediaEpoch: 3,
    currentSrc: "blob:https://site.example/fresh", resourceUrls: [${JSON.stringify(freshSigned)}],
    currentTimeMs: 500_000, durationMs: 1_793_000, playbackRate: 1
  }, { tab: { id: 6 }, frameId: 0 })`);
  const raceStarts = h.nativeMessages.filter((message) => message.type === "start");
  check(raceStarts.length === 1 && raceStarts[0].mediaEpoch === 3
      && raceStarts[0].currentTimeMs === 500_000 && raceStarts[0].source.url === freshSigned,
    "only the fresh media context starts Helper at the new playback position");
  run(`chrome.scripting.executeScript = async () => []`);

  const raceOld = "https://video.example/race/old.m3u8?token=OLD";
  const raceFresh = "https://video.example/race/fresh.m3u8?token=FRESH";
  h.nativeMessages.length = 0;
  run(`tabStates.set(20, {
    tabId: 20, frameId: 0, jobId: "offline-20", mediaEpoch: 6,
    captureStarted: true, status: "starting", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: ${JSON.stringify(raceOld)}, pageUrl: "https://site.example/watch",
    translate: false, mediaIdentity: "identity-20"
  }); captureTabId = 20;
  originalSessionSetForRace = chrome.storage.session.set;
  firstPersistForRace = true;
  chrome.storage.session.set = (values) => {
    if (values.koeTabs && firstPersistForRace) {
      firstPersistForRace = false;
      return new Promise((resolve) => { releaseFirstPersistForRace = () => {
        Object.assign(${JSON.stringify(h.sessionStore)}, values);
        resolve();
      }; });
    }
    return originalSessionSetForRace(values);
  };`);
  const firstSameEpochContext = run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-20", mediaEpoch: 6,
    currentSrc: ${JSON.stringify(raceOld)}, resourceUrls: [],
    currentTimeMs: 10_000, durationMs: 600_000, playbackRate: 1
  }, { tab: { id: 20 }, frameId: 0 })`);
  await settle();
  const secondSameEpochContext = run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-20", mediaEpoch: 6,
    currentSrc: ${JSON.stringify(raceFresh)}, resourceUrls: [],
    currentTimeMs: 12_000, durationMs: 600_000, playbackRate: 1
  }, { tab: { id: 20 }, frameId: 0 })`);
  await settle();
  run(`releaseFirstPersistForRace();`);
  await Promise.all([firstSameEpochContext, secondSameEpochContext]);
  await settle();
  run(`chrome.storage.session.set = originalSessionSetForRace;`);
  const sameEpochStarts = h.nativeMessages.filter((message) => message.type === "start" && message.jobId === "offline-20");
  check(sameEpochStarts.length === 1
      && sameEpochStarts[0].source.url === raceFresh
      && sameEpochStarts[0].currentTimeMs === 12_000,
    "a newer same-epoch media context replaces an in-flight reservation and starts exactly once");

  h.nativeMessages.length = 0;
  h.contentMessages.length = 0;
  run(`tabStates.set(19, {
    tabId: 19, frameId: 0, jobId: "offline-19", mediaEpoch: 5,
    captureStarted: true, status: "live", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: ${JSON.stringify(signed)}, pageUrl: "https://site.example/watch",
    translate: false, mediaIdentity: "identity-19", offlineStartedEpoch: 5,
    offlineRunActive: false, offlinePreparedUntilMs: 120_000, offlineCueRevision: 0,
    offlineSourceUrl: ${JSON.stringify(signed)}, offlineContextVersion: 1,
    offlineContext: { currentTimeMs: 50_000, durationMs: 600_000, playbackRate: 1 }
  }); captureTabId = 19;`);
  run(`maybeExtendOfflinePrep(tabStates.get(19))`);
  await settle();
  check(!h.nativeMessages.some((message) => message.type === "start"),
    "a comfortably buffered local batch is not restarted by a heartbeat");
  run(`tabStates.get(19).offlineContext.currentTimeMs = 76_000;
    maybeExtendOfflinePrep(tabStates.get(19));
    maybeExtendOfflinePrep(tabStates.get(19));`);
  await settle();
  check(h.nativeMessages.filter((message) => message.type === "start").length === 1,
    "approaching the prepared boundary starts exactly one refill batch");
  await run(`handleNativeMessage({
    type: "status", jobId: "offline-19", mediaEpoch: 5, stage: "ready",
    detail: "ready", preparedUntilMs: 196_000
  })`);
  run(`tabStates.get(19).offlineContext.currentTimeMs = 200_000;
    maybeExtendOfflinePrep(tabStates.get(19));`);
  await settle();
  check(h.nativeMessages.filter((message) => message.type === "start").length === 2,
    "passing a prepared boundary immediately starts the next refill instead of stalling");
  await run(`handleNativeMessage({
    type: "cues", jobId: "offline-19", mediaEpoch: 5, revision: 4,
    cues: [{ cueId: "batch-a", startMs: 201_000, endMs: 202_000, text: "First batch." }]
  })`);
  await run(`handleNativeMessage({
    type: "cues", jobId: "offline-19", mediaEpoch: 5, revision: 1,
    cues: [{ cueId: "batch-b", startMs: 203_000, endMs: 204_000, text: "Second batch." }]
  })`);
  const refillRevisions = h.contentMessages
    .filter((entry) => entry.message.type === "OFFLINE_CUES" && entry.message.jobId === "offline-19")
    .map((entry) => entry.message.revision);
  check(refillRevisions.length === 2 && refillRevisions[0] === 4 && refillRevisions[1] === 5,
    "helper revisions are rebased monotonically across same-epoch refill batches");

  run(`tabStates.set(22, {
    tabId: 22, frameId: 0, jobId: "offline-22", mediaEpoch: 1,
    captureStarted: true, status: "starting", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "blob:https://video.example/dash", pageUrl: "https://video.example/watch",
    translate: false, offlineMissingMediaSince: Date.now() - 11_000
  }); captureTabId = 22; mediaCandidatesByTab.delete(22);`);
  const unsupportedPending = await run(`receiveMediaContext({
    type: "MEDIA_CONTEXT", jobId: "offline-22", mediaEpoch: 1,
    currentSrc: "blob:https://video.example/dash", resourceUrls: [],
    currentTimeMs: 12_000, durationMs: 60_000, playbackRate: 1
  }, { tab: { id: 22 }, frameId: 0 })`);
  check(unsupportedPending.pending === true
      && run(`tabStates.get(22).status`) === "error"
      && run(`tabStates.get(22).captureStarted`) === true,
    "an HLS-less player receives a clear recoverable unsupported-format state instead of spinning forever");

  h.runtimeMessages.length = 0;
  h.events.length = 0;
  run(`tabStates.set(7, {
    tabId: 7, frameId: 0, jobId: "live-7", mediaEpoch: 0,
    captureStarted: true, status: "live", engine: "dashscope", sessionMode: "live",
    source: "tab", sourceUrl: "https://video.example/live.mp4", pageUrl: "https://site.example/watch", translate: true
  }); captureTabId = 7; captureStreamIds.set(7, "stream-7");`);
  h.localConfig.koeAsrEngine = "local";
  await run(`setCaptureConfig(7)`);
  check(h.runtimeMessages.some((message) => message.type === "CAPTURE_STOP"),
    "live to local mode switch stops the old offscreen capture before starting Helper");

  h.nativeMessages.length = 0;
  run(`tabStates.set(8, {
    tabId: 8, frameId: 0, jobId: "offline-8", mediaEpoch: 4,
    captureStarted: true, status: "live", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "https://video.example/local.mp4", pageUrl: "https://site.example/watch", translate: true
  }); captureTabId = 8;`);
  h.localConfig.koeAsrEngine = "dashscope";
  await run(`setCaptureConfig(8)`);
  check(h.nativeMessages.some((message) => message.type === "cancel" && message.jobId === "offline-8"),
    "local to live mode switch cancels the old Helper task");

  h.nativeMessages.length = 0;
  run(`tabStates.set(9, {
    tabId: 9, frameId: 0, jobId: "offline-9", mediaEpoch: 0,
    captureStarted: false, status: "idle", engine: "local", sessionMode: "offline",
    source: "tab", pageUrl: "https://site.example/watch", translate: false, userStopped: true
  });`);
  await run(`startOfflineSession(tabStates.get(9))`);
  check(h.nativeMessages.length === 0 && run(`tabStates.get(9).captureStarted`) === false,
    "page activity cannot restart a local session after the user explicitly stopped it");

  h.nativeMessages.length = 0;
  h.contentMessages.length = 0;
  h.localConfig.koeAsrEngine = "local";
  run(`discoverVideoSource = async () => ({
    hasVideo: true, playing: true, muted: false, frameId: 0,
    sourceUrl: "https://video.example/same.mp4", pageUrl: "https://site.example/watch"
  }); tabStates.set(11, {
    tabId: 11, frameId: 0, jobId: "offline-11", mediaEpoch: 3,
    captureStarted: true, status: "live", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "https://video.example/same.mp4", pageUrl: "https://site.example/watch",
    translate: false, offlineStartedEpoch: 3, lastDiscontinuityId: 7, mediaIdentity: "identity-before"
  }); captureTabId = 11;`);
  await run(`ensureLiveCaptions({
    tabId: 11, pageUrl: "https://site.example/watch", mediaChanged: true
  })`);
  check(run(`tabStates.get(11).mediaEpoch`) === 4
      && run(`tabStates.get(11).mediaIdentity`) !== "identity-before"
      && h.nativeMessages.some((message) => message.type === "cancel" && message.mediaEpoch === 3)
      && h.contentMessages.some((entry) => entry.message.type === "OFFLINE_RESET" && entry.message.mediaEpoch === 4)
      && h.contentMessages.some((entry) => entry.message.type === "OFFLINE_SESSION"
        && entry.message.mediaEpoch === 4 && entry.message.discontinuityId === 7),
    "a player source event rotates media identity and restores the content timeline even when its URL fingerprint is unchanged");

  h.nativeMessages.length = 0;
  h.contentMessages.length = 0;
  run(`tabStates.set(18, {
    tabId: 18, frameId: 0, jobId: "offline-18", mediaEpoch: 4,
    captureStarted: true, status: "live", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "https://video.example/same.mp4", pageUrl: "https://site.example/watch",
    translate: false, offlineStartedEpoch: 4, lastDiscontinuityId: 12, mediaIdentity: "identity-18"
  }); captureTabId = 18;`);
  await run(`ensureLiveCaptions({ tabId: 18, pageUrl: "https://site.example/watch" })`);
  const reconnectMessages = h.contentMessages.map((entry) => entry.message);
  check(reconnectMessages.some((message) => message.type === "OFFLINE_SESSION"
      && message.jobId === "offline-18" && message.discontinuityId === 12)
      && reconnectMessages.some((message) => message.type === "OFFLINE_DISCOVER"),
    "a fresh content script receives the active local session before media discovery");

  h.nativeMessages.length = 0;
  run(`tabStates.set(12, {
    tabId: 12, frameId: 0, jobId: "offline-12", mediaEpoch: 0,
    captureStarted: false, status: "idle", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "https://video.example/other.mp4", pageUrl: "https://site.example/other",
    translate: false
  }); captureTabId = 11;`);
  await run(`startOfflineSession(tabStates.get(12))`);
  check(run(`tabStates.get(11).userStopped`) === true && run(`captureTabId`) === 12,
    "switching the single local session marks the previous tab as handed off");
  h.nativeMessages.length = 0;
  await run(`ensureLiveCaptions({ tabId: 11, pageUrl: "https://site.example/watch" })`);
  check(!h.nativeMessages.some((message) => message.type === "start"),
    "the handed-off tab cannot steal the local session back through PAGE_READY");

  h.nativeMessages.length = 0;
  h.contentMessages.length = 0;
  run(`tabStates.set(14, {
    tabId: 14, frameId: 0, jobId: "offline-14-old", mediaEpoch: 7,
    captureStarted: false, status: "idle", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: "https://video.example/same.mp4", pageUrl: "https://site.example/watch",
    translate: false, userStopped: true
  });`);
  await run(`startCaptureForTab({ tabId: 14, streamId: "", pageUrl: "https://site.example/watch" })`);
  const restartedJob = run(`tabStates.get(14).jobId`);
  check(restartedJob !== "offline-14-old" && run(`tabStates.get(14).mediaEpoch`) === 8,
    "an explicit restart after stop mints a new local session identity");
  const beforeOldCue = h.contentMessages.length;
  await run(`handleNativeMessage({
    type: "cues", jobId: "offline-14-old", mediaEpoch: 7, revision: 99,
    cues: [{ cueId: "old", startMs: 1_000, endMs: 2_000, text: "Old queued cue." }]
  })`);
  check(h.contentMessages.length === beforeOldCue,
    "a cue queued before stop cannot enter the explicitly restarted session");

  h.nativeMessages.length = 0;
  h.contentMessages.length = 0;
  run(`
    tabStates.get(14).captureStarted = false;
    captureTabId = null;
    tabStates.set(15, {
      tabId: 15, frameId: 0, jobId: "offline-15", mediaEpoch: 0,
      captureStarted: false, status: "idle", engine: "local", sessionMode: "offline",
      source: "tab", sourceUrl: "https://video.example/same.mp4", pageUrl: "https://site.example/watch",
      translate: false, userStopped: false
    });
    originalClearTranscriptForTest = clearTranscript;
    clearTranscript = () => new Promise((resolve) => { releaseTranscriptClearForTest = resolve; });
  `);
  const pendingStart = run(`startOfflineSession(tabStates.get(15))`);
  await settle();
  await run(`stopCaptureForTab({ tabId: 15, jobId: "offline-15" })`);
  run(`releaseTranscriptClearForTest();`);
  await pendingStart;
  run(`clearTranscript = originalClearTranscriptForTest;`);
  const raceContentTypes = h.contentMessages
    .filter((entry) => entry.message.jobId === "offline-15")
    .map((entry) => entry.message.type);
  check(raceContentTypes.includes("OFFLINE_STOP") && !raceContentTypes.includes("OFFLINE_SESSION")
      && !h.nativeMessages.some((message) => message.type === "hello"),
    "stopping during local preparation prevents every late session and Helper-start message");

  h.runtimeMessages.length = 0;
  h.contentMessages.length = 0;
  h.localConfig.koeApiKey = "test-key";
  h.localConfig.koeAsrEngine = "dashscope";
  run(`
    captureTabId = null;
    tabStates.set(16, {
      tabId: 16, frameId: 0, jobId: "live-16", mediaEpoch: 0,
      captureStarted: false, status: "idle", engine: "dashscope", sessionMode: "live",
      source: "tab", sourceUrl: "https://video.example/same.mp4", pageUrl: "https://site.example/watch",
      translate: false, userStopped: false
    });
    originalClearTranscriptForTest = clearTranscript;
    clearTranscript = () => new Promise((resolve) => { releaseTranscriptClearForTest = resolve; });
  `);
  const pendingLiveStart = run(`startCapture(tabStates.get(16), "stream-16")`);
  await settle();
  await run(`stopCaptureForTab({ tabId: 16, jobId: "live-16" })`);
  run(`releaseTranscriptClearForTest();`);
  await pendingLiveStart;
  run(`clearTranscript = originalClearTranscriptForTest;`);
  check(!h.runtimeMessages.some((message) => message.type === "CAPTURE_START")
      && !h.contentMessages.some((entry) => entry.message.type === "LIVE_SESSION"),
    "stopping during live preparation prevents a late offscreen capture start");

  h.nativeMessages.length = 0;
  h.localConfig.koeAsrEngine = "local";
  run(`discoverVideoSource = async () => ({
    hasVideo: true, playing: true, muted: false, frameId: 0,
    sourceUrl: "https://video.example/unrelated.mp4", pageUrl: "https://site.example/watch"
  })`);
  await run(`ensureLiveCaptions({ tabId: 10, pageUrl: "https://site.example/watch" })`);
  check(run(`tabStates.has(10)`) === false && h.nativeMessages.length === 0,
    "an unrelated page-ready event cannot silently create a local analysis session");

  run(`tabStates.set(17, {
    tabId: 17, frameId: 0, jobId: "offline-17", mediaEpoch: 1,
    captureStarted: true, status: "live", engine: "local", sessionMode: "offline",
    source: "tab", sourceUrl: ${JSON.stringify(signed)}, pageUrl: "https://site.example/watch",
    offlineStartedEpoch: 1, offlineSourceUrl: ${JSON.stringify(signed)},
    offlineContext: { currentTimeMs: 10_000 }, mediaIdentity: "identity-17"
  }); captureTabId = 17;
  rememberMediaCandidate(17, { url: ${JSON.stringify(signed)}, frameId: 0, source: "test" });`);
  await run(`stopCapture(tabStates.get(17))`);
  check(run(`tabStates.get(17).offlineSourceUrl`) === ""
      && run(`tabStates.get(17).offlineContext`) === undefined
      && run(`mediaCandidatesByTab.has(17)`) === false
      && !run(`tabStates.get(17).sourceUrl`).includes("?"),
    "stopping local mode clears signed URLs and media context from memory");

  console.log(fail === 0 ? "offline media regression PASS" : `${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
