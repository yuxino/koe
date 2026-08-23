// Koe offscreen capture: tab audio -> 16 kHz PCM -> DashScope directly.
// No localhost helper is required at runtime.

const DASHSCOPE_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const TRANSLATE_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
const ASR_MODEL = "qwen-audio-3.0-asr-flash-streaming";
const TRANSLATE_MODEL = "qwen-mt-flash";
// 字幕风格提示（移植 Mimi）：让译文像影视剧字幕、保留语气词，更流畅自然
const TRANSLATE_DOMAIN_HINT =
  "Use concise, idiomatic Simplified Chinese, like subtitles for a TV drama, " +
  "and keep every natural particle: 嗯、啊、呢、吧、嘛、哦、唉. " +
  "Render English fillers (um, uh, oh, hmm, yeah) with their natural Chinese " +
  "equivalents; never drop a meaningful filler.";
// 翻译记忆：最近 9 条 源→译 对照，首轮 flash 翻译直接传入 tm_list，
// 在第一次可见结果里保持术语一致，不再依赖迟到的二次精修。
const translationMemory = [];
function rememberTranslation(source, target) {
  for (let index = translationMemory.length - 1; index >= 0; index -= 1) {
    if (translationMemory[index].source === source) translationMemory.splice(index, 1);
  }
  translationMemory.push({ source, target });
  while (translationMemory.length > 9) translationMemory.shift();
}
function recentTranslationMemory() {
  return translationMemory.slice(-5);
}
const PCM_FRAME_BYTES = 3_200; // 100 ms, 16 kHz mono int16
const PCM_QUEUE_LIMIT = 20; // 最多保留约 2 秒；网络追不上时优先保持实时
const SOCKET_BACKPRESSURE_BYTES = 128 * 1_024;
const MAX_AUTO_RETRIES = 5;

let stream = null;
let currentStreamSource = ""; // 当前流的来源："tab" | "mic"
let currentStreamId = "";
let monitorAudio = null;
let audioContext = null;
let processor = null;
let audioSource = null;
let silentGain = null;
let socket = null;
let pendingSocketStartCancel = null;
let taskId = "";
let taskReady = false;
let captureTranslate = false;
let captureApiKey = "";
let captureSource = "tab"; // "tab" | "mic"
let captureEngine = "dashscope"; // "dashscope" | "webspeech"
let recognition = null;
let retryCount = 0;
let retryTimer = null;
let pcmPending = new Uint8Array(0);
let frameQueue = [];
let emitSeq = 0;
let stopping = false;
let captureGeneration = 0;
let captureOperationId = 0;
let captureJobId = "";
let captureTabId = 0;
let captureMediaEpoch = 0;
let captureClockStartedAt = 0;
let capturedAudioSamples = 0;
let taskAudioOffsetMs = 0;
let activeSentenceId = 0;
let activeTiming = {};
// 高频草稿日志节流：asr-draft 至少间隔 300ms 才记一条
let lastDraftLogAt = 0;

// ===== 诊断日志：每条都带时间戳打点到后台（存环形缓冲，侧边栏可一键复制）=====
function logEvent(event, detail = "") {
  const line = `${new Date().toISOString().slice(11, 23)} ${event} ${detail}`;
  try {
    console.log(`[koe] ${line}`);
  } catch {
    // 控制台不可用时忽略
  }
  try {
    void chrome.runtime.sendMessage({ type: "KOE_LOG", event, detail: String(detail), ts: Date.now() })
      .catch(() => undefined);
  } catch {
    // 消息发不出不影响识别
  }
}

function monotonicNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function audioPositionMs() {
  if (captureEngine === "webspeech") return Math.max(0, monotonicNow() - captureClockStartedAt);
  return Math.max(0, capturedAudioSamples / 16);
}

function timingFields(timing = activeTiming) {
  const beginTimeMs = Number(timing?.beginTimeMs);
  const endTimeMs = Number(timing?.endTimeMs);
  const hasBegin = Number.isFinite(beginTimeMs);
  const hasEnd = Number.isFinite(endTimeMs);
  const validRange = !hasBegin || !hasEnd || endTimeMs >= beginTimeMs;
  return {
    beginTimeMs: validRange && hasBegin ? beginTimeMs : undefined,
    endTimeMs: validRange && hasEnd ? endTimeMs : undefined,
    audioPositionMs: audioPositionMs(),
    sentenceId: Number(timing?.sentenceId) || 0
  };
}

function sendCaptureMessage(message, timing = activeTiming) {
  return chrome.runtime.sendMessage({
    ...message,
    ...timingFields(timing),
    tabId: captureTabId,
    jobId: captureJobId,
    mediaEpoch: captureMediaEpoch
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === "CAPTURE_START") {
    startCapture(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }  
  if (message.type === "CAPTURE_STOP") {
    // 用户主动停止 = 彻底释放：停识别 + 释放音频流 + 停监听器。
    // 之前为了"再开不冲突"只停识别、保留流，导致点停止后标签页仍显示在捕获、
    // 声音仍走 Koe 通道，感觉"关不掉"。同类软件（Mimi/YouTube 实时字幕）
    // 停止即彻底释放。重新开启时 popup 点击会拿新的流，不受影响。
    stopCapture().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === "CAPTURE_RESET") {
    captureTranslate = Boolean(message.translate);
    if (Number.isFinite(Number(message.mediaEpoch))) captureMediaEpoch = Number(message.mediaEpoch);
    if (message.source) captureSource = message.source === "mic" ? "mic" : "tab";
    if (message.engine) captureEngine = String(message.engine);
    // 内置识别不需要重连 WebSocket：重启识别会话即可
    const restart = captureEngine === "webspeech"
      ? restartWebSpeech()
      : resetSocket();
    restart.then(() => sendResponse({ ok: true, audioPositionMs: audioPositionMs() })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  return false;
});

// 并发启动合并：弹窗自动开启 + 按钮点击可能同时到达，只允许一次启动在跑，
// 避免双识别会话产生重复字幕。
let startCapturePromise = null;

async function startCapture(message) {
  if (startCapturePromise) return startCapturePromise;
  startCapturePromise = runStartCapture(message).finally(() => {
    startCapturePromise = null;
  });
  return startCapturePromise;
}

async function runStartCapture({ streamId, translate, apiKey, source, engine, jobId, tabId, mediaEpoch }) {
  const operationId = ++captureOperationId;
  const nextJobId = String(jobId || "");
  const nextMediaEpoch = Number(mediaEpoch) || 0;
  const sameTimeline = Boolean(
    nextJobId
    && nextJobId === captureJobId
    && nextMediaEpoch === captureMediaEpoch
  );
  retryCount = 0;
  stopping = false;
  clearRetryTimer();
  await stopRecognitionOnly();
  if (operationId !== captureOperationId) throw captureCancelledError();
  stopping = false;
  assertCaptureOperation(operationId);
  captureSource = source === "mic" ? "mic" : "tab";
  captureEngine = ["webspeech"].includes(engine) ? engine : "dashscope";
  captureApiKey = String(apiKey || "").trim();
  captureTranslate = Boolean(translate);
  captureJobId = nextJobId;
  captureTabId = Number(tabId) || 0;
  captureMediaEpoch = nextMediaEpoch;
  if (!sameTimeline) {
    emitSeq = 0;
    capturedAudioSamples = 0;
  }
  captureClockStartedAt = monotonicNow();
  activeSentenceId = 0;
  activeTiming = {};
  logEvent("start", `source=${captureSource} engine=${captureEngine} translate=${captureTranslate}`);

  try {
    if (captureEngine === "webspeech") {
    // Chrome 内置语音识别：仅支持麦克风来源；免 Key、免手势（一次麦克风授权后永久生效）
    if (captureSource !== "mic") {
      throw new Error("内置语音识别只支持「麦克风」声音来源，请在设置里切换。");
    }
    await acquireStreamForSource("");
    assertCaptureOperation(operationId);
    startWebSpeech();
    logEvent("started", "mode=webspeech");
      return { ok: true, mode: "webspeech", audioPositionMs: audioPositionMs() };
    }

    await acquireStreamForSource(streamId);
    assertCaptureOperation(operationId);

    // 先开始采集再连接识别会话：连接期间的音频先排队，连上后立即补发，开播头几秒不丢
    const started = await startPcmCapture();
    assertCaptureOperation(operationId);
    if (!started) throw new Error("浏览器不支持 16kHz 音频采集。");
    await connectRealtime();
    assertCaptureOperation(operationId);
    flushFrames();
    logEvent("started", "mode=direct");
    return { ok: true, mode: "direct", audioPositionMs: audioPositionMs() };
  } catch (error) {
    logEvent("start-failed", String(error?.message || error));
    await stopCapture();
    throw error;
  }
}

function assertCaptureOperation(operationId) {
  if (operationId === captureOperationId && !stopping) return;
  throw captureCancelledError();
}

function captureCancelledError() {
  const error = new Error("capture_start_cancelled");
  error.name = "AbortError";
  return error;
}

// 获取（或复用）音频流：来源未变时直接复用已存在的流，
// 只有来源切换或首次开启时才真正调用 getUserMedia。
async function acquireStreamForSource(streamId) {
  const requestedStreamId = captureSource === "tab" ? String(streamId || "") : "mic";
  if (stream && currentStreamSource === captureSource && currentStreamId === requestedStreamId) return;
  releaseStream();
  if (captureSource === "mic") {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } else {
    if (!streamId) throw new Error("缺少标签页音频流。");
    if (!captureApiKey) throw new Error("请先在 Koe 中保存 DashScope API Key。");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/active stream|already|captur/i.test(message)) {
        // 标签页可能被旧会话占用：稍等后重试一次，仍失败则给出明确指引
        await new Promise((resolve) => setTimeout(resolve, 800));
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
          }
        }).catch(() => null);
        if (!stream) {
          throw new Error("标签页音频被旧会话占用：请刷新视频页面，或先按 Alt+K 重试。");
        }
      } else {
        throw error;
      }
    }
    // tabCapture 会把标签页自身的声音静音、只交给捕获流，
    // 因此这里必须把捕获到的声音原样播放出来，用户才能继续听到视频。
    // Chrome 已抑制标签页直出，不会出现双重声音。
    monitorAudio = new Audio();
    monitorAudio.srcObject = stream;
    monitorAudio.play().catch(() => undefined);
  }
  currentStreamSource = captureSource;
  currentStreamId = requestedStreamId;
}

function releaseStream() {
  if (monitorAudio) {
    try { monitorAudio.srcObject = null; } catch { /* ignore */ }
    try { monitorAudio.pause(); } catch { /* ignore */ }
    monitorAudio = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* ignore */ }
    });
    stream = null;
  }
  currentStreamSource = "";
  currentStreamId = "";
}

// ===== Chrome 内置语音识别（webkitSpeechRecognition）=====
// 识别结果直接复用断句器与翻译管线：中间结果当草稿，最终结果当服务端 final。
function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error("此环境不支持内置语音识别（webkitSpeechRecognition）。");
  recognition = new SR();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = String(result?.[0]?.transcript || "").trim();
      if (!text) continue;
      const now = audioPositionMs();
      const timing = {
        sentenceId: index + 1,
        beginTimeMs: Math.max(0, now - 1_500),
        endTimeMs: result.isFinal ? now : undefined
      };
      if (result.isFinal) handleServerFinal(text, timing);
      else handleServerDraft(text, timing);
    }
  };
  recognition.onerror = (event) => {
    const error = String(event?.error || "");
    if (error === "not-allowed" || error === "service-not-allowed") {
      sendCaptureMessage({
        type: "CAPTURE_ERROR",
        error: "麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试。"
      }).catch(() => undefined);
    }
    // no-speech 等瞬时错误：onend 里自动重启
  };
  recognition.onend = () => {
    if (!stopping && captureEngine === "webspeech") {
      try { recognition.start(); } catch { /* 已在运行 */ }
    }
  };
  recognition.start();
}

async function restartWebSpeech() {
  if (recognition) {
    try { recognition.onend = null; recognition.abort(); } catch { /* ignore */ }
    recognition = null;
  }
  resetDraftCommitter();
  await acquireStreamForSource("");
  startWebSpeech();
}


async function connectRealtime() {
  taskReady = false;
  const nextTaskId = randomTaskId();
  taskId = nextTaskId;
  taskAudioOffsetMs = audioPositionMs();
  const nextSocket = new WebSocket(DASHSCOPE_WS);
  socket = nextSocket;
  nextSocket.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const clearPending = () => {
      if (pendingSocketStartCancel === cancel) pendingSocketStartCancel = null;
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearPending();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearPending();
      reject(error);
    };
    const cancel = () => finishResolve(false);
    pendingSocketStartCancel = cancel;
    timer = setTimeout(() => {
      if (socket === nextSocket) socket = null;
      try { nextSocket.close(1000, "timeout"); } catch { /* ignore */ }
      finishReject(new Error("DashScope 连接超时。"));
    }, 20_000);
    nextSocket.onopen = () => {
      // 旧连接可能比替代它的新连接更晚触发 open；绝不能借用全局 socket
      // 把 run-task 发给仍处于 CONNECTING 的新实例。
      if (socket !== nextSocket || stopping) {
        clearTimeout(timer);
        try { nextSocket.close(1000, "superseded"); } catch { /* ignore */ }
        finishResolve(false);
        return;
      }
      nextSocket.send(JSON.stringify({
        header: { action: "run-task", task_id: nextTaskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: ASR_MODEL,
          // 与 Mimi 一致：服务端开语义断句（权威、带标点），节奏由客户端掌握——
          // 草稿稳定 500ms 就结句、最长 2s 强制切块，字幕不会等服务端慢慢断句。
          // 静音期间发心跳防止服务端断连。
          parameters: {
            format: "pcm",
            sample_rate: 16_000,
            semantic_punctuation_enabled: true,
            heartbeat: true
          },
          input: {}
        }
      }));
    };
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket) return;
      const message = parseJson(event.data);
      if (!message) return;
      const type = message?.header?.event || "";
      if (type === "task-started") {
        clearTimeout(timer);
        taskReady = true;
        retryCount = 0;
        clearRetryTimer();
        logEvent("ws-task-started", `task=${nextTaskId}`);
        finishResolve();
        return;
      }
      if (type === "task-failed") {
        const error = message?.header?.error_message || "DashScope 实时识别失败";
        clearTimeout(timer);
        handleDashScopeMessage(message);
        if (isRetryable(error)) finishResolve(false);
        else finishReject(new Error(error));
        return;
      }
      handleDashScopeMessage(message);
    };
    nextSocket.onerror = () => {
      clearTimeout(timer);
      if (socket !== nextSocket) {
        finishResolve(false);
        return;
      }
      logEvent("ws-error", "");
      finishReject(new Error("无法连接 DashScope 实时识别。"));
    };
    nextSocket.onclose = (event) => {
      clearTimeout(timer);
      if (socket !== nextSocket) {
        finishResolve(false);
        return;
      }
      const wasReady = taskReady;
      taskReady = false;
      socket = null;
      // close code 能区分断连原因：1000/1001 = 服务端/主动关闭，1006 = 网络断，
      // 4000+ = 服务端业务错误（如认证失败、配额）
      logEvent("ws-closed", `code=${event?.code ?? "?"} reason=${JSON.stringify(String(event?.reason || "").slice(0, 60))} stopping=${stopping}`);
      if (!stopping && stream) {
        scheduleAutoReconnect();
        if (!wasReady) finishReject(new Error("DashScope 连接在启动前关闭。"));
      }
    };
  });
}

function cancelPendingSocketStart() {
  const cancel = pendingSocketStartCancel;
  pendingSocketStartCancel = null;
  if (cancel) cancel();
}

function handleDashScopeMessage(message) {
  const event = message?.header?.event || "";
  if (event === "result-generated") {
    const sentence = message?.payload?.output?.sentence;
    if (!sentence || sentence.heartbeat) return;
    const sentenceId = Number(sentence.sentence_id) || 0;
    if (sentenceId && sentenceId !== activeSentenceId) {
      if (activeSentenceId) {
        lastUnitTexts.length = 0;
        resetDraftCommitter();
      }
      activeSentenceId = sentenceId;
    }
    const timing = {
      sentenceId,
      beginTimeMs: Number.isFinite(Number(sentence.begin_time))
        ? taskAudioOffsetMs + Number(sentence.begin_time)
        : undefined,
      endTimeMs: Number.isFinite(Number(sentence.end_time))
        ? taskAudioOffsetMs + Number(sentence.end_time)
        : undefined
    };
    activeTiming = timing;
    // 注意：不在这里根据 sentence_begin 重置断句状态。
    // 若服务端在句子的多个中间结果上都带 sentence_begin（或 final 晚于下一句
    // 的中间结果到达），重置会把已提交边界清空，导致同一个句子被重复上屏。
    // 句子切换由服务端 final 重置 + pendingText 前缀判断兜底。
    const text = String(sentence.text || "").trim();
    if (!text) return;
    const isFinal = Boolean(sentence.sentence_end);
    if (isFinal) {
      logEvent("asr-final", `len=${Array.from(text).length} sentence=${sentenceId}`);
      handleServerFinal(text, timing);
    } else {
      // 草稿是高频消息（每 100~300ms 一条）：日志节流到 300ms 一条，
      // 避免 KOE_LOG 写入风暴拖慢后台、字幕消息被排队（"卡住"）。
      // 识别与草稿显示不受影响，只少写日志。
      const now = Date.now();
      if (now - lastDraftLogAt >= 300) {
        lastDraftLogAt = now;
        logEvent("asr-draft", `len=${Array.from(text).length} sentence=${sentenceId}`);
      }
      handleServerDraft(text, timing);
    }
    return;
  }
  if (event === "task-failed") {
    const error = message?.header?.error_message || "DashScope 实时识别失败";
    logEvent("ws-task-failed", String(error).slice(0, 120));
    // 可重试的失败交给自动重连静默处理，重连耗尽时才上报——
    // 否则后台会立刻结束会话，而这边重连成功后字幕就成了没人接收的孤儿。
    if (isRetryable(error)) {
      scheduleAutoReconnect();
    } else {
      sendCaptureMessage({ type: "CAPTURE_ERROR", error }).catch(() => undefined);
    }
  }
}

// ===== 客户端断句器（移植 Mimi 的 ASRDraftCommitter，字幕阅读参数）=====
// 服务端只提供“权威结果”，节奏由客户端掌握：
// - 草稿持续流式翻译，不人为等待；
// - 完整句稳定 700ms 后提交，但单块仍受字幕宽度上限约束；
// - 连续无停顿讲话最多等待 2.2s，达到可翻译的最小长度便在自然边界切块；
// - 服务端 final 到达时去重，并用同一宽度策略切块。
const SENTENCE_DELIMITERS = ["。", "！", "？", ".", "!", "?", "\n"];
const PAUSE_DELIMITERS = new Set(["，", "、", ",", "；", ";", "：", ":", "—", "–", "-"]);
const STABLE_DRAFT_DELAY = 700;
const MAXIMUM_WAIT_DELAY = 2_200;
// 64 个拉丁字符 / 28 个 CJK 字符约等于视频字幕的两行上限。
// 最小值保证强切块仍有足够上下文，不把翻译切成三四个词的碎片。
const SUBTITLE_LIMITS = Object.freeze({
  latin: Object.freeze({ minimum: 36, maximum: 64 }),
  cjk: Object.freeze({ minimum: 14, maximum: 28 })
});

let latestDraft = "";
let committedText = "";
let lastCommittedChunk = "";
let lastCommitProvisional = false;
let stableTimer = null;
let maxWaitTimer = null;
let lastEmittedTail = "";
// 最近一次上屏的字幕块（seq + 文本），供“识别修正撤回”使用
let lastEmittedUnitSeq = 0;
let lastEmittedUnitText = "";
// 当前句子的第一块 seq（识别修正时按范围撤回整句，而不是只撤最后一块）
let currentSentenceStartSeq = 0;
// 最近上屏的字幕块（最多 3 条），用于与迟到的服务端 final 对账：
// 重复的 final、或只是已上屏块的一部分，都不再上屏，避免字幕重复。
const lastUnitTexts = [];

const codePoints = (text) => Array.from(String(text));

// 两段文本的公共前缀长度（按字符），用于区分“正常延伸”与“识别修正”
function longestCommonPrefix(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

function isMeaningful(text) {
  return codePoints(text).some((ch) => !/\s/.test(ch) && !isPunctuation(ch));
}

function isPunctuation(ch) {
  // 与 Swift 的 is_alphanumeric 语义一致：字母/数字/空白/控制符之外都算标点
  if (/[\p{L}\p{N}]/u.test(ch) || /\s/.test(ch) || /[\u0000-\u001f\u007f]/.test(ch)) return false;
  return true;
}

// 只取第一个完整句（到第一个句末标点为止）。一次提交一句，
// 避免草稿里积累的多个句子被一次性扔上字幕——那就是"突然一大片"的来源。
function firstCompleteSentence(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (SENTENCE_DELIMITERS.includes(text[index])) return text.slice(0, index + 1).trim();
  }
  return "";
}

// 判断文本以哪种语言为主：英文长尾可以多攒一会儿再切（单词长、切碎了译文也碎）
function textLanguage(text) {
  const points = codePoints(text);
  let cjk = 0;
  let latin = 0;
  for (const ch of points) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  return latin >= cjk ? "latin" : "cjk";
}

function subtitleLimits(text) {
  return SUBTITLE_LIMITS[textLanguage(text)];
}

// 取第一块字幕宽度内的文本。优先在逗号/分号等停顿处切，其次在词边界切；
// CJK 没有空格时直接按字数硬切。剩余文本留给下一块。
function firstLongChunk(text) {
  const points = codePoints(text);
  const { minimum, maximum } = subtitleLimits(text);
  if (points.length <= maximum) return String(text).trim();
  const floor = Math.max(1, Math.min(minimum, Math.floor(maximum * 0.58)));
  let end = -1;
  for (let index = maximum - 1; index >= floor; index -= 1) {
    if (PAUSE_DELIMITERS.has(points[index])) {
      end = index + 1;
      break;
    }
  }
  if (end < 0) {
    for (let index = maximum; index >= floor; index -= 1) {
      if (/\s/.test(points[index - 1])) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) end = maximum;
  return points.slice(0, end).join("").trim();
}

function pendingText() {
  const draft = latestDraft.trim();
  if (!committedText) return draft;
  // 服务端草稿回退到已提交内容的前缀（重新识别中）：此时草稿里没有新内容，
  // 返回空——否则整句会被当新内容重新提交，同一句上屏两次（日志里
  // seq=36 与 seq=56 都是 "I do, and I want to lose the weight."）。
  if (committedText.startsWith(draft)) return "";
  if (!draft.startsWith(committedText)) return draft;
  // 去掉紧贴已提交内容的标点/空白，避免草稿和切块以 "." 之类开头
  return draft.slice(committedText.length).replace(/^[\s\p{P}\p{S}]+/u, "").trim();
}

function updateDraft(text) {
  latestDraft = String(text).trim();
  return pendingText();
}

function commitPendingDraft({ forceLongIncomplete = false } = {}) {
  const pending = pendingText();
  if (!isMeaningful(pending)) return null;
  // 一次提交一个语义块。完整句超过字幕宽度时也在自然边界切，避免句号很晚
  // 才出现时把整段独白作为一个 unit 上屏。
  const firstSentence = firstCompleteSentence(pending);
  if (isMeaningful(firstSentence)) {
    // 完整句是翻译的最小语义单位，不再按显示宽度切碎。页面负责两行布局；
    // 只有迟迟没有标点的连续语音才走下面的长度兜底。
    commitChunk(firstSentence, pending);
    return firstSentence;
  }
  if (forceLongIncomplete) {
    const longChunk = firstLongChunk(pending);
    const { minimum } = subtitleLimits(pending);
    if (codePoints(pending).length >= minimum) {
      commitChunk(longChunk, pending);
      return longChunk;
    }
  }
  return null;
}

function commitChunk(chunk, pendingBefore) {
  const draftPoints = codePoints(latestDraft.trim());
  const remaining = codePoints(pendingBefore).length - codePoints(chunk).length;
  committedText = draftPoints.slice(0, Math.max(0, draftPoints.length - remaining)).join("");
  lastCommittedChunk = chunk;
  lastCommitProvisional = true;
}

function finishSentence(text) {
  const finalText = String(text).trim();
  if (!isMeaningful(finalText)) return { kind: "none" };
  const finalPoints = codePoints(finalText);
  if (committedText && finalPoints.length >= 2 && committedText.includes(finalText)) {
    lastCommitProvisional = false;
    lastCommittedChunk = "";
    return { kind: "none" };
  }
  if (lastCommitProvisional && lastCommittedChunk && finalPoints.length >= 2) {
    const chunk = lastCommittedChunk;
    // final 以最后提交块开头 = 该块被权威版取代/延伸 → replaced。
    // 只用 startsWith，不用 includes：includes 会把"最后一块恰好是 final
    // 中间内容"（多句累积后 final 整段）误判成取代 → 整段重发（字幕刷两遍）。
    const supersedes = finalText !== chunk && finalText.startsWith(chunk);
    if (supersedes) {
      if (committedText.endsWith(chunk)) {
        committedText = dropSuffix(committedText, codePoints(chunk).length);
      } else {
        committedText = "";
      }
      committedText += finalText;
      lastCommitProvisional = false;
      lastCommittedChunk = "";
      return { kind: "replaced", text: finalText };
    }
  }
  // 计算 final 相对 committedText 的新增起点：
  // ① committed 是 final 的前缀（整体延伸，如 "A. B." → "A. B. C."）→ 从 committed 末尾补发；
  // ② 否则看 committed 后缀与 final 前缀的重叠（尾部延伸）。
  // 只用 suffixOverlap 时，整体前缀相同但结尾微调的情况会算出 overlap=0，
  // 导致 final 整段被当新增重发（字幕刷两遍）。
  const prefixOverlap = longestCommonPrefix(committedText, finalText);
  const overlap = prefixOverlap >= codePoints(committedText).length
    ? prefixOverlap
    : suffixOverlap(committedText, finalText);
  const newText = finalPoints.slice(overlap).join("").trim();
  if (!isMeaningful(newText)) {
    lastCommitProvisional = false;
    lastCommittedChunk = "";
    return { kind: "none" };
  }
  committedText += newText;
  lastCommitProvisional = false;
  lastCommittedChunk = "";
  return { kind: "appended", text: newText };
}

function dropSuffix(text, count) {
  return codePoints(text).slice(0, Math.max(0, codePoints(text).length - count)).join("");
}

function suffixOverlap(text, prefix) {
  const textPoints = codePoints(text);
  const prefixPoints = codePoints(prefix);
  if (textPoints.length === 0 || prefixPoints.length === 0) return 0;
  const maximum = Math.min(textPoints.length, prefixPoints.length);
  for (let length = maximum; length >= 1; length -= 1) {
    const textSuffix = textPoints.slice(textPoints.length - length).join("");
    const prefixHead = prefixPoints.slice(0, length).join("");
    if (textSuffix === prefixHead) return length;
  }
  return 0;
}

// 计时器采用 Mimi 的锚定方式：待提交文本出现时各创建一个计时器，后续草稿更新
// 不重置它们。稳定计时器不取消兜底计时器，连续独白也会按字幕块持续提交。
function scheduleDraftTimers() {
  if (!stableTimer) {
    stableTimer = setTimeout(() => {
      stableTimer = null;
      const chunk = commitPendingDraft({ forceLongIncomplete: false });
      if (chunk) emitCommittedUnit(chunk);
      if (isMeaningful(firstCompleteSentence(pendingText()))) scheduleDraftTimers();
    }, STABLE_DRAFT_DELAY);
  }
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      const chunk = commitPendingDraft({ forceLongIncomplete: true });
      if (chunk) emitCommittedUnit(chunk);
      if (isMeaningful(pendingText())) scheduleDraftTimers();
    }, MAXIMUM_WAIT_DELAY);
  }
}

function cancelDraftTimers() {
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = null;
  if (maxWaitTimer) clearTimeout(maxWaitTimer);
  maxWaitTimer = null;
}

function resetDraftCommitter() {
  cancelDraftTimers();
  latestDraft = "";
  committedText = "";
  lastCommittedChunk = "";
  lastCommitProvisional = false;
  lastEmittedTail = "";
  currentSentenceStartSeq = 0;
}

// 撤回当前句子的全部字幕块（识别修正时用），并清空待提交状态
function revokeCurrentSentence(reason) {
  const fromSeq = currentSentenceStartSeq || lastEmittedUnitSeq;
  if (!fromSeq || !lastEmittedUnitSeq) return;
  logEvent("revoke", `${reason} from=${fromSeq} to=${lastEmittedUnitSeq} oldChars=${Array.from(lastEmittedUnitText).length}`);
  sendCaptureMessage({
    type: "CAPTURE_REVOKE",
    fromSeq,
    toSeq: lastEmittedUnitSeq,
    text: lastEmittedUnitText
  }).catch(() => undefined);
  lastUnitTexts.length = 0;
  lastEmittedUnitSeq = 0;
  lastEmittedUnitText = "";
  currentSentenceStartSeq = 0;
  committedText = "";
  lastCommittedChunk = "";
  lastCommitProvisional = false;
  lastEmittedTail = "";
  cancelDraftTimers();
}

// 词尾修正的精细化撤回：只撤"最后一块被替换"的那一块（如 "I am." → "Yes? Yes."），
// 并把 committedText 截断到与最新草稿的公共前缀——已确认的前缀（"Are you ready? "）
// 保留不动，待提交区从新草稿继续，避免整句重新提交造成字幕重复。
function revokeLastUnitForDrift(draftText, lcp) {
  if (!lastEmittedUnitSeq) return;
  logEvent("revoke-tail", `from=${lastEmittedUnitSeq} to=${lastEmittedUnitSeq} oldChars=${Array.from(lastEmittedUnitText).length} newChars=${Array.from(draftText).length}`);
  sendCaptureMessage({
    type: "CAPTURE_REVOKE",
    fromSeq: lastEmittedUnitSeq,
    toSeq: lastEmittedUnitSeq,
    text: lastEmittedUnitText
  }).catch(() => undefined);
  lastUnitTexts.pop();
  lastEmittedUnitSeq = 0;
  lastEmittedUnitText = "";
  currentSentenceStartSeq = 0;
  // 截断到公共前缀（保留已确认部分），待提交区从 draft.slice(lcp) 继续
  committedText = codePoints(committedText).slice(0, lcp).join("");
  lastCommittedChunk = "";
  lastCommitProvisional = false;
  lastEmittedTail = "";
  cancelDraftTimers();
}

// 判断两段文本是否共享词（同一句话的修正通常保留尾词，换句则无关）
function hasSharedWord(left, right) {
  const words = new Set(String(left || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const rightWords = String(right || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return rightWords.slice(-2).some((word) => words.has(word));
}

function handleServerDraft(text, timing = activeTiming) {
  activeTiming = timing || {};
  // 识别修正检测：
  // ① 整句换词（"Okayur assets" → "Identify your assets"，公共前缀极短但保留尾词）
  //    → 撤回整句重来；
  // ② 词尾修正（"I am." → "Yes? Yes."，最后上屏块被替换、不再出现在新草稿中）
  //    → 只撤回最后一块 + 把 committedText 对齐到公共前缀，保留已确认部分，
  //      避免整句重新提交造成重复（日志里 "Are you ready?" 上屏 3 次的根因）。
  // 词尾震荡（"All right." → "All right, there's..."，最后一块仍是新草稿的前缀）
  // 不 revoke，等 final 权威修正。
  const draftText = String(text || "").trim();
  if (committedText && lastEmittedUnitSeq && draftText && !draftText.startsWith(committedText)) {
    // 服务端草稿临时截短/回退（重识别中）：draft 是已提交文本的前缀时，
    // 已上屏内容仍是正确前缀，绝不 revoke。
    if (!committedText.startsWith(draftText)) {
      const lcp = longestCommonPrefix(draftText, committedText);
      const fullSwap = lcp < 3 && hasSharedWord(draftText, committedText);
      if (fullSwap) {
        revokeCurrentSentence("draft-swap");
      } else if (lcp >= 4 && lastEmittedUnitText) {
        // 词尾修正判定：最后上屏块的开头（去尾标点）不再出现在新草稿中
        // （"I am." 被替换成 "Yes? Yes."）→ 该块已失效，撤回它并对齐前缀。
        // 词尾震荡（"All right." → "All right, there's..."）时最后一块仍是前缀，
        // 不会被误判。
        const unitHead = codePoints(lastEmittedUnitText).slice(0, 10).join("")
          .replace(/[\s\p{P}\p{S}]+$/u, "");
        if (unitHead.length >= 3 && !draftText.includes(unitHead)) {
          revokeLastUnitForDrift(draftText, lcp);
        }
      }
    }
  }
  const tail = updateDraft(text);
  if (!tail || !isMeaningful(tail)) return;
  scheduleDraftTimers();
  if (tail === lastEmittedTail) return;
  lastEmittedTail = tail;
  const seq = ++emitSeq;
  logEvent("draft-emit", `seq=${seq} chars=${Array.from(tail).length}`);
  sendCaptureMessage({
    type: "CAPTURE_PARTIAL",
    lines: [{ text: tail }],
    seq
  }, timing).catch(() => undefined);
  if (captureTranslate) {
    // 显示宽度和翻译上下文分开处理：页面仍用两行样式约束视觉高度，但翻译模型
    // 收到完整的当前句，避免 64 字符硬截断破坏指代、语义和句尾信息。
    const translationSource = firstCompleteSentence(tail) || tail;
    scheduleDraftTranslation(translationSource, seq, timing);
  }
}

function handleServerFinal(text, timing = activeTiming) {
  activeTiming = timing || {};
  cancelDraftTimers();
  const finalText = String(text).trim();
  const lastUnit = lastUnitTexts[lastUnitTexts.length - 1] || "";

  // 对账：final 与最近上屏的块完全相同，或只是其中一部分 → 已经显示过，跳过
  if (lastUnit && (lastUnitTexts.includes(finalText) || lastUnit.startsWith(finalText))) {
    logEvent("final-dup", `finalChars=${Array.from(finalText).length} lastUnitChars=${Array.from(lastUnit).length}`);
    dropQueuedDrafts();
    resetDraftCommitter();
    return;
  }

  // 权威 final 修正了草稿内容（如 "her too" → "her titties"）：
  // 前缀高度重合但词尾被换（final 不以 committedText 开头）时，
  // 撤回当前句的全部字幕块，按句切块重发权威版，错行不再残留。
  // 注意两种绝不 revoke 的情况：
  // ① final 以 committedText 开头（正常延伸）——finishSentence 只补发新增；
  // ② 最后上屏块是 committedText 的尾部、且仍出现在 final 中（差异只在它之后，
  //    如 program. → program?）——已上屏内容没错，revoke 重发只会造成"字幕刷两遍"，
  //    只补发最后一块之后的新内容。
  if (committedText && lastEmittedUnitSeq && finalText) {
    const isExtension = finalText.startsWith(committedText);
    if (!isExtension) {
      const lastUnitIsTail = Boolean(lastUnit && committedText.endsWith(lastUnit) && finalText.includes(lastUnit));
      if (lastUnitIsTail) {
        // 只补发最后上屏块之后的新内容（按句切块），不重发已上屏部分
        const index = finalText.indexOf(lastUnit);
        const tail = finalText.slice(index + lastUnit.length).trim();
        if (isMeaningful(tail)) emitFinalSentences(tail, timing);
        logEvent("final-tail-only", `afterChars=${Array.from(tail).length}`);
        dropQueuedDrafts();
        resetDraftCommitter();
        return;
      }
      const lcp = longestCommonPrefix(finalText, committedText);
      const committedLen = codePoints(committedText).length;
      const finalLen = codePoints(finalText).length;
      const sameSentence = committedLen >= 8 && finalLen >= 8 && lcp >= 8;
      if (sameSentence) {
        revokeCurrentSentence(`final-fix lcp=${lcp}`);
        emitFinalSentences(finalText, timing);
        dropQueuedDrafts();
        resetDraftCommitter();
        return;
      }
    }
  }

  const outcome = finishSentence(finalText);
  logEvent(`final-${outcome.kind}`,
    `finalChars=${Array.from(finalText).length} outChars=${Array.from(String(outcome.text || "")).length} committedLen=${Array.from(committedText).length}`);
  if (outcome.kind === "replaced" || outcome.kind === "appended") {
    // appended：final 只是把已上屏内容往后延长 → 只补发新增后缀，
    // 否则整段（含已显示的部分）会再上一次屏，看起来就是字幕重复。
    // replaced：整句换词 → 发替换后的文本；若权威整句以最后上屏块开头，也只补发新增部分。
    let unitText = outcome.kind === "replaced" ? outcome.text : (outcome.text || finalText);
    if (outcome.kind === "replaced" && lastUnit && finalText.startsWith(lastUnit)) {
      unitText = finalText.slice(lastUnit.length).trim();
    }
    if (isMeaningful(unitText)) {
      // 权威 final 可能是多句（语义断句一次性给出整段）：按句切块逐条上屏，
      // 避免一大段突然出现、译文也超长；已上屏过的块直接跳过。
      emitFinalSentences(unitText, timing);
    }
  }
  // 旧草稿尾的翻译已过期，丢弃；下一句从头开始
  dropQueuedDrafts();
  resetDraftCommitter();
}

// 一个权威 final 对应一个语义 cue。按显示宽度拆成多条会让它们共享同一时间区间、
// 在同一毫秒连发，页面只能看到最后一条，翻译也失去完整上下文。
function emitFinalSentences(text, timing = activeTiming) {
  const unit = String(text || "").trim();
  if (!isMeaningful(unit) || lastUnitTexts.includes(unit)) return;
  emitUnit(unit, timing);
}

function emitCommittedUnit(text, timing = activeTiming) {
  emitUnit(text, timing);
}

function emitUnit(text, timing = activeTiming) {
  const unitText = String(text).trim();
  if (!isMeaningful(unitText)) return;
  lastUnitTexts.push(unitText);
  if (lastUnitTexts.length > 3) lastUnitTexts.shift();
  const seq = ++emitSeq;
  lastEmittedUnitSeq = seq;
  lastEmittedUnitText = unitText;
  // 完整句（以句末标点结尾）上屏后，当前句子已闭合：
  // 之后若再修正，只影响下一句，revoke 范围从下一块开始。
  // 无句号的强切块（长句中间态）仍在同一句内，revoke 从本块覆盖。
  const isComplete = SENTENCE_DELIMITERS.includes(unitText[unitText.length - 1]);
  currentSentenceStartSeq = isComplete ? 0 : (currentSentenceStartSeq || seq);
  logEvent("unit-emit", `seq=${seq} chars=${Array.from(unitText).length}`);
  sendCaptureMessage({
    type: "CAPTURE_LINES",
    lines: [{ text: unitText }],
    seq,
    unit: true
  }, timing).catch(() => undefined);
  if (captureTranslate) scheduleUnitTranslation(unitText, seq, timing);
}

// ===== 翻译调度：flash 增量流 + 稳定句抢占 =====
// 原文草稿到达后立即发起一次 qwen-mt-flash 增量翻译，首个中文块直接上屏。
// 队列里的草稿始终只保留最新一条；稳定字幕块会中止正在执行的旧草稿并
// 插到所有草稿前面。正常路径不做固定等待、不批量，避免人为增加首字延迟。
const TRANSLATE_COOLDOWN_MS = 20_000;
const translationQueue = []; // { kind: "unit" | "draft", text, seq }
let translatorRunning = false;
let throttleCooldownUntil = 0;
let inFlightItem = null;
let inFlightController = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function translationContent(payload) {
  return String(
    payload?.output?.choices?.[0]?.message?.content || payload?.output?.text || ""
  );
}

function mergeTranslationChunk(current, chunk) {
  const previous = String(current || "");
  const next = String(chunk || "");
  if (!next) return previous;
  // incremental_output 通常返回增量块；兼容网关偶尔返回累计全文。
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return previous + next;
}

async function readTranslationStream(response, onUpdate) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let translated = "";

  const consumeEvent = (eventText) => {
    const data = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    const payload = parseJson(data);
    if (!payload) return;
    if (payload.code || payload?.header?.event === "task-failed") {
      throw new Error(payload.message || payload?.header?.error_message || "translate_stream_failed");
    }
    const next = mergeTranslationChunk(translated, translationContent(payload));
    if (next === translated) return;
    translated = next;
    if (typeof onUpdate === "function") onUpdate(translated.trim());
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(0), { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const eventText of events) consumeEvent(eventText);
    if (done) break;
  }
  if (buffer.trim()) consumeEvent(buffer);
  return translated.trim();
}

async function translateText(text, {
  model = TRANSLATE_MODEL,
  memory = [],
  signal,
  onUpdate
} = {}) {
  if (isAlreadyChinese(text)) {
    if (typeof onUpdate === "function") onUpdate(text);
    return text;
  }
  const apiKey = captureApiKey;
  if (!apiKey) return "";
  const incremental = model === TRANSLATE_MODEL;
  const body = {
    model,
    // qwen-mt 只接受一条 user 消息；目标语言必须由 translation_options 指定。
    input: {
      messages: [{ role: "user", content: text }]
    },
    parameters: {
      result_format: "message",
      incremental_output: incremental ? true : undefined,
      translation_options: {
        source_lang: "auto",
        target_lang: "Chinese",
        domains: TRANSLATE_DOMAIN_HINT,
        tm_list: memory.length > 0 ? memory : undefined
      }
    }
  };
  const response = await fetch(TRANSLATE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "X-DashScope-SSE": incremental ? "enable" : "disable"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const bodyJson = await response.json().catch(() => ({}));
    throw new Error(bodyJson?.message || `translate_failed:${response.status}`);
  }
  if (incremental && response.body && typeof response.body.getReader === "function") {
    return readTranslationStream(response, onUpdate);
  }
  const bodyJson = await response.json().catch(() => ({}));
  const translated = translationContent(bodyJson).trim();
  if (translated && typeof onUpdate === "function") onUpdate(translated);
  return translated;
}

function scheduleUnitTranslation(text, seq, timing = activeTiming) {
  // 稳定句是当前最可信文本：中止旧草稿，把稳定句插到所有草稿前。
  dropQueuedDrafts({ abortInFlight: true });
  const item = { kind: "unit", text, seq, timing: { ...timing } };
  const firstDraft = translationQueue.findIndex((entry) => entry.kind === "draft");
  if (firstDraft < 0) translationQueue.push(item);
  else translationQueue.splice(firstDraft, 0, item);
  void runTranslationWorker();
}

function scheduleDraftTranslation(text, seq, timing = activeTiming) {
  // 不为每次 ASR 微调中止网络请求；旧结果立即失效，请求结束后只处理最新草稿。
  dropQueuedDrafts({ abortInFlight: false });
  translationQueue.push({ kind: "draft", text, seq, timing: { ...timing } });
  void runTranslationWorker();
}

function dropQueuedDrafts({ abortInFlight = true } = {}) {
  if (inFlightItem && inFlightItem.kind === "draft") {
    inFlightItem.superseded = true;
    if (abortInFlight && inFlightController) inFlightController.abort();
  }
  for (let index = translationQueue.length - 1; index >= 0; index -= 1) {
    if (translationQueue[index].kind === "draft") translationQueue.splice(index, 1);
  }
}

function cancelTranslationWork() {
  translationQueue.length = 0;
  if (inFlightItem) inFlightItem.superseded = true;
  if (inFlightController) inFlightController.abort();
}

function emitTranslatedItem(item, translated, { streaming = false } = {}) {
  if (!translated) return;
  sendCaptureMessage({
    type: "CAPTURE_TRANSLATED",
    lines: [{ text: item.text, translated }],
    seq: item.seq,
    // unit 表示译文属于稳定字幕；streaming 只表示结果仍在增长。两者不能混用，
    // 否则稳定字幕的首个流式译文会被页面当成草稿而不可见。
    unit: item.kind === "unit",
    streaming
  }, item.timing).catch(() => undefined);
}

function createTranslationController() {
  if (typeof AbortController === "function") return new AbortController();
  // 仅供旧测试/旧运行环境兜底；现代 Chrome 始终使用原生 AbortController。
  const signal = { aborted: false, addEventListener: () => undefined };
  return {
    signal,
    abort() { signal.aborted = true; }
  };
}

async function runTranslationWorker() {
  if (translatorRunning) return;
  translatorRunning = true;
  while (translationQueue.length > 0) {
    const item = translationQueue.shift();
    inFlightItem = item;
    inFlightController = createTranslationController();
    const controller = inFlightController;
    const generation = captureGeneration;

    if (item.kind === "draft" && Date.now() < throttleCooldownUntil) {
      logEvent("translation-skip", "cooldown draft");
      inFlightItem = null;
      inFlightController = null;
      continue;
    }
    if (item.kind === "draft" && item.superseded) {
      logEvent("translation-skip", "superseded draft");
      inFlightItem = null;
      inFlightController = null;
      continue;
    }

    let translated = "";
    let lastStreamed = "";
    let firstOutputLogged = false;
    const startedAt = monotonicNow();
    logEvent("translation-request", `kind=${item.kind} model=${TRANSLATE_MODEL} chars=${Array.from(item.text).length}`);
    try {
      translated = await translateWithRetry(item.text, {
        model: TRANSLATE_MODEL,
        memory: recentTranslationMemory(),
        signal: controller.signal,
        onUpdate: (value) => {
          const current = String(value || "").trim();
          if (!current || current === lastStreamed) return;
          if (generation !== captureGeneration || item.superseded || controller.signal.aborted) return;
          lastStreamed = current;
          if (!firstOutputLogged) {
            firstOutputLogged = true;
            logEvent("translation-first", `kind=${item.kind} seq=${item.seq} ms=${Math.round(monotonicNow() - startedAt)}`);
          }
          emitTranslatedItem(item, current, { streaming: true });
        }
      });
    } catch (error) {
      if (error?.name !== "AbortError" && !item.superseded) {
        logEvent("translation-failed", `kind=${item.kind} chars=${Array.from(item.text).length}`);
      }
      translated = lastStreamed;
    }
    const finishedAt = monotonicNow();
    inFlightItem = null;
    inFlightController = null;
    if (generation !== captureGeneration) {
      translationQueue.length = 0;
      break;
    }
    if (item.kind === "draft" && item.superseded) continue;

    translated = String(translated || lastStreamed || "").trim();
    logEvent("translation-complete", `kind=${item.kind} seq=${item.seq} ms=${Math.round(finishedAt - startedAt)} ok=${Boolean(translated)}`);
    if (translated) logEvent("translation-ok", `kind=${item.kind} seq=${item.seq} chars=${Array.from(translated).length}`);
    if (item.kind === "unit") {
      if (translated) rememberTranslation(item.text, translated);
      // 完成时再发一次冻结值；失败则空译文让显示端稳定回退原文。
      sendCaptureMessage({
        type: "CAPTURE_TRANSLATED",
        lines: [{ text: item.text, translated }],
        seq: item.seq,
        unit: true,
        streaming: false
      }, item.timing).catch(() => undefined);
    } else if (translated && translated !== lastStreamed) {
      emitTranslatedItem(item, translated, { streaming: false });
    }
  }
  translatorRunning = false;
}

async function translateWithRetry(text, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await translateText(text, options);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      if (/429|throttl|rate.?limit|quota/i.test(message)) {
        // 触发限流：进入冷却期，退避后重试一次
        throttleCooldownUntil = Date.now() + TRANSLATE_COOLDOWN_MS;
        logEvent("translation-429", `cool=${TRANSLATE_COOLDOWN_MS}ms attempt=${attempt}`);
        await sleep(1_200 + attempt * 1_500);
        continue;
      }
      if (attempt === 0 && /5\d\d|timeout|network|fetch/i.test(message)) {
        await sleep(700);
        continue;
      }
      // flash 未开通时回退到 turbo，避免翻译全挂；turbo 走非增量 JSON。
      if (attempt === 0 && options.model && options.model !== "qwen-mt-turbo"
        && /model|not.?found|invalid|unsupported|permission/i.test(message)) {
        logEvent("translation-model-fallback", `from=${options.model} to=turbo err=${String(message).slice(0, 60)}`);
        return await translateText(text, { ...options, model: "qwen-mt-turbo" });
      }
      break;
    }
  }
  throw lastError || new Error("translate_failed");
}

async function startPcmCapture() {
  try {
    audioContext = new AudioContext({ sampleRate: 16_000 });
    if (audioContext.state === "suspended") await audioContext.resume();
    if (audioContext.state !== "running" || Math.abs(audioContext.sampleRate - 16_000) > 100) {
      await audioContext.close().catch(() => undefined);
      audioContext = null;
      return false;
    }
    audioSource = audioContext.createMediaStreamSource(stream);
    audioSource.channelCount = 1;
    audioSource.channelCountMode = "explicit";
    audioSource.channelInterpretation = "speakers";
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    // AudioWorklet 在音频渲染线程里稳定收集 PCM，不再触发 ScriptProcessorNode
    // 的废弃警告，也不会因为主线程忙而让声画延迟越积越大。
    if (audioContext.audioWorklet && typeof AudioWorkletNode === "function") {
      await audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
      processor = new AudioWorkletNode(audioContext, "koe-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      processor.port.onmessage = (event) => {
        const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
        enqueueSamples(samples);
        flushFrames();
      };
    } else {
      // 仅给旧版浏览器保留兼容兜底；现代 Chrome 永远走 AudioWorklet。
      processor = audioContext.createScriptProcessor(2_048, 1, 1);
      processor.onaudioprocess = (event) => {
        enqueueSamples(event.inputBuffer.getChannelData(0));
        flushFrames();
      };
    }
    audioSource.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
    return true;
  } catch {
    await stopPcmCapture();
    return false;
  }
}

function enqueueSamples(samples) {
  capturedAudioSamples += samples.length;
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(i * 2, value, true);
  }
  const merged = new Uint8Array(pcmPending.length + bytes.length);
  merged.set(pcmPending, 0);
  merged.set(bytes, pcmPending.length);
  pcmPending = merged;
  while (pcmPending.length >= PCM_FRAME_BYTES) {
    frameQueue.push(pcmPending.slice(0, PCM_FRAME_BYTES));
    pcmPending = pcmPending.slice(PCM_FRAME_BYTES);
  }
  if (frameQueue.length > PCM_QUEUE_LIMIT) {
    frameQueue.splice(0, frameQueue.length - PCM_QUEUE_LIMIT);
  }
}

function flushFrames() {
  if (!taskReady || !socket || socket.readyState !== WebSocket.OPEN) return;
  while (frameQueue.length > 0 && Number(socket.bufferedAmount || 0) < SOCKET_BACKPRESSURE_BYTES) {
    const frame = frameQueue.shift();
    try {
      socket.send(frame.buffer);
    } catch {
      scheduleAutoReconnect();
      return;
    }
  }
}

async function resetSocket() {
  if (!stream) throw new Error("capture_not_running");
  logEvent("ws-reconnect", `retry=${retryCount}`);
  captureGeneration += 1;
  cancelTranslationWork();
  cancelPendingSocketStart();
  closeSocket(false);
  frameQueue = [];
  pcmPending = new Uint8Array(0);
  inFlightItem = null;
  inFlightController = null;
  lastUnitTexts.length = 0;
  activeSentenceId = 0;
  activeTiming = {};
  resetDraftCommitter();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await connectRealtime();
}

function scheduleAutoReconnect() {
  if (stopping || retryTimer) return;
  if (retryCount >= MAX_AUTO_RETRIES) {
    logEvent("ws-reconnect-exhausted", `retries=${retryCount}`);
    sendCaptureMessage({
      type: "CAPTURE_ERROR",
      error: "DashScope 重连失败，请检查网络或 API Key。"
    }).catch(() => undefined);
    return;
  }
  retryCount += 1;
  const delayMs = Math.min(4_000, 300 * 2 ** Math.max(0, retryCount - 1));
  logEvent("ws-reconnect-scheduled", `retry=${retryCount} delay=${delayMs}ms`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void resetSocket().catch(() => scheduleAutoReconnect());
  }, delayMs);
}

function clearRetryTimer() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function isRetryable(error) {
  return /socket|connection|timeout|closed|network|1006|econnreset|etimedout/i.test(String(error || ""));
}

async function stopPcmCapture() {
  frameQueue = [];
  pcmPending = new Uint8Array(0);
  if (processor) {
    if (processor.port) processor.port.onmessage = null;
    try { processor.disconnect(); } catch { /* ignore */ }
    if ("onaudioprocess" in processor) processor.onaudioprocess = null;
    processor = null;
  }
  if (audioSource) {
    try { audioSource.disconnect(); } catch { /* ignore */ }
    audioSource = null;
  }
  if (silentGain) {
    try { silentGain.disconnect(); } catch { /* ignore */ }
    silentGain = null;
  }
  if (audioContext) {
    try { await audioContext.close(); } catch { /* ignore */ }
    audioContext = null;
  }
}

function closeSocket(finish = true) {
  taskReady = false;
  if (!socket) return;
  // 先摘掉回调再关闭：否则主动关闭（重连/停止）时 onclose 仍会触发
  // 自动重连，与 resetSocket 里的手动重连叠加，造成重连风暴
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  try {
    if (finish && socket.readyState === WebSocket.OPEN && taskId) {
      socket.send(JSON.stringify({
        header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
        payload: { input: {} }
      }));
    }
  } catch { /* ignore */ }
  try { socket.close(1000, "bye"); } catch { /* ignore */ }
  socket = null;
}

// 只停识别、保留音频流与监听器：再次开启时直接复用流，
// 避免“Cannot capture a tab with an active stream”冲突。
// 注意：标签页来源的监听器必须继续播放（tabCapture 会静音标签页自身）。
async function stopRecognitionOnly() {
  stopping = true;
  captureGeneration += 1;
  cancelPendingSocketStart();
  clearRetryTimer();
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.abort();
    } catch { /* ignore */ }
    recognition = null;
  }
  await stopPcmCapture();
  closeSocket(true);
  taskId = "";
  cancelTranslationWork();
  inFlightItem = null;
  inFlightController = null;
  throttleCooldownUntil = 0;
  lastUnitTexts.length = 0;
  resetDraftCommitter();
  // stream 与 monitorAudio 保留，供下次开启复用
  logEvent("stopped", "recognition-only (stream kept)");
}

async function stopCapture() {
  logEvent("stop", "full (stream released)");
  captureOperationId += 1;
  stopping = true;
  captureGeneration += 1;
  cancelPendingSocketStart();
  clearRetryTimer();
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.abort();
    } catch { /* ignore */ }
    recognition = null;
  }
  await stopPcmCapture();
  releaseStream();
  closeSocket(true);
  taskId = "";
  emitSeq = 0;
  cancelTranslationWork();
  inFlightItem = null;
  inFlightController = null;
  throttleCooldownUntil = 0;
  lastUnitTexts.length = 0;
  resetDraftCommitter();
}

function parseJson(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function randomTaskId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
}

function isAlreadyChinese(value) {
  const text = String(value || "");
  // 日语也大量使用汉字；只要出现假名就必须继续翻译，不能把
  // “気持ちいい”这类文本误判成已经是中文。
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(text)) return false;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cjk > 0 && cjk >= latin;
}
