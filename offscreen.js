// Koe offscreen capture: tab audio -> 16 kHz PCM -> DashScope directly.
// No localhost helper is required at runtime.

const DASHSCOPE_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const TRANSLATE_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
const ASR_MODEL = "qwen-audio-3.0-asr-flash-streaming";
const TRANSLATE_MODEL_DRAFT = "qwen-mt-flash";
const TRANSLATE_MODEL_FINAL = "qwen-mt-plus";
// 字幕风格提示（移植 Mimi）：让译文像影视剧字幕、保留语气词，更流畅自然
const TRANSLATE_DOMAIN_HINT =
  "Use concise, idiomatic Simplified Chinese, like subtitles for a TV drama, " +
  "and keep every natural particle: 嗯、啊、呢、吧、嘛、哦、唉. " +
  "Render English fillers (um, uh, oh, hmm, yeah) with their natural Chinese " +
  "equivalents; never drop a meaningful filler.";
// 翻译记忆：最近 9 条 源→译 对照，final 翻译时传入 tm_list，
// 保持术语一致（如 "Cash for Chunkers program" 每次都译成同一个说法）
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
const MAX_AUTO_RETRIES = 5;

let stream = null;
let currentStreamSource = ""; // 当前流的来源："tab" | "mic"
let monitorAudio = null;
let audioContext = null;
let processor = null;
let socket = null;
let taskId = "";
let taskReady = false;
let captureTranslate = false;
let captureApiKey = "";
let captureSource = "tab"; // "tab" | "mic"
let captureEngine = "dashscope"; // "dashscope" | "webspeech" | "vosk-zh" | "vosk-en"
let recognition = null;
let retryCount = 0;
let retryTimer = null;
let pcmPending = new Uint8Array(0);
let frameQueue = [];
let emitSeq = 0;
let stopping = false;
let captureGeneration = 0;
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
    if (message.source) captureSource = message.source === "mic" ? "mic" : "tab";
    if (message.engine) captureEngine = String(message.engine);
    // 内置识别/本地模型不需要重连 WebSocket：重启识别会话即可
    const restart = captureEngine === "webspeech"
      ? restartWebSpeech()
      : captureEngine.startsWith("vosk")
        ? restartVosk()
        : resetSocket();
    restart.then(() => sendResponse({ ok: true })).catch((error) => {
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

async function runStartCapture({ streamId, translate, apiKey, source, engine }) {
  retryCount = 0;
  stopping = false;
  clearRetryTimer();
  await stopRecognitionOnly();
  stopping = false;
  captureSource = source === "mic" ? "mic" : "tab";
  captureEngine = ["webspeech", "vosk-zh", "vosk-en"].includes(engine) ? engine : "dashscope";
  captureApiKey = String(apiKey || "").trim();
  captureTranslate = Boolean(translate);
  logEvent("start", `source=${captureSource} engine=${captureEngine} translate=${captureTranslate}`);

  if (captureEngine === "webspeech") {
    // Chrome 内置语音识别：仅支持麦克风来源；免 Key、免手势（一次麦克风授权后永久生效）
    if (captureSource !== "mic") {
      throw new Error("内置语音识别只支持「麦克风」声音来源，请在设置里切换。");
    }
    await acquireStreamForSource("");
    startWebSpeech();
    logEvent("started", "mode=webspeech");
    return { ok: true, mode: "webspeech" };
  }

  await acquireStreamForSource(streamId);

  try {
    // 先开始采集再连接识别会话：连接期间的音频先排队，连上后立即补发，开播头几秒不丢
    const started = await startPcmCapture();
    if (!started) throw new Error("浏览器不支持 16kHz 音频采集。");
    if (captureEngine.startsWith("vosk")) {
      await startVosk();
      flushFrames();
      logEvent("started", `mode=vosk ${captureEngine}`);
      return { ok: true, mode: "vosk" };
    }
    await connectRealtime();
    flushFrames();
    logEvent("started", "mode=direct");
    return { ok: true, mode: "direct" };
  } catch (error) {
    logEvent("start-failed", String(error?.message || error));
    await stopCapture();
    throw error;
  }
}

// 获取（或复用）音频流：来源未变时直接复用已存在的流，
// 只有来源切换或首次开启时才真正调用 getUserMedia。
async function acquireStreamForSource(streamId) {
  if (stream && currentStreamSource === captureSource) return;
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
      if (result.isFinal) handleServerFinal(text);
      else handleServerDraft(text);
    }
  };
  recognition.onerror = (event) => {
    const error = String(event?.error || "");
    if (error === "not-allowed" || error === "service-not-allowed") {
      chrome.runtime.sendMessage({
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

// ===== 本地离线识别（Vosk，WASM，运行在沙箱页里）=====
// MV3 扩展页 CSP 不允许 eval/Function，而 Vosk 的 Emscripten 运行时需要它们；
// 因此模型与识别器跑在 sandbox.html（manifest 里声明，自带宽松 CSP）的 iframe 中，
// 离屏页通过 postMessage 驱动它：加载模型、创建识别器、喂 PCM、回收识别结果。
// 结果复用断句器与翻译管线：partial 当草稿，final 当服务端 final。
const VOSK_MODEL_FILES = {
  "vosk-zh": "models/vosk-model-small-cn-0.22.tar.gz",
  "vosk-en": "models/vosk-model-small-en-us-0.15.tar.gz"
};

let voskFrame = null;
let voskReady = false;
let voskRecognizerId = 0;
let voskRecognizerIdCounter = 0;

// 沙箱识别结果的常驻监听（partial → 草稿、final → 字幕块、错误 → 上报）
window.addEventListener("message", (event) => {
  if (event.source !== voskFrame?.contentWindow) return;
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "vosk-partial") {
    const text = String(message.text || "").trim();
    if (text) handleServerDraft(text);
  } else if (message.type === "vosk-result") {
    const text = String(message.text || "").trim();
    if (text) handleServerFinal(text);
  } else if (message.type === "vosk-error") {
    chrome.runtime.sendMessage({
      type: "CAPTURE_ERROR",
      error: `本地识别错误：${message.error || "未知"}`
    }).catch(() => undefined);
  }
});

function postToVosk(message) {
  if (!voskFrame) {
    voskFrame = document.createElement("iframe");
    voskFrame.style.display = "none";
    voskFrame.src = chrome.runtime.getURL("sandbox.html");
    document.body.appendChild(voskFrame);
  }
  voskFrame.contentWindow.postMessage(message, "*");
}

// 等待某个沙箱消息：加载模型最多等 60 秒（首次解压较慢），
// 超时必须报错而不是永远挂起——之前按钮"像死了一样"就是因为挂起无超时。
function waitForVosk(predicate, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", handler);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const handler = (event) => {
      if (event.source !== voskFrame?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message.type !== "string") return;
      if (message.type === "vosk-error") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        reject(new Error(message.error || "本地识别初始化失败"));
        return;
      }
      if (predicate(message)) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(message);
      }
    };
    window.addEventListener("message", handler);
  });
}

async function startVosk() {
  const modelFile = VOSK_MODEL_FILES[captureEngine];
  if (!modelFile) throw new Error("未知的本地模型配置。");
  if (!voskReady) {
    const modelUrl = chrome.runtime.getURL(modelFile);
    postToVosk({ type: "load-model", url: modelUrl });
    await waitForVosk(
      (message) => message.type === "model-ready",
      60_000,
      "本地模型加载超时，请重试或改用其他模式。"
    );
    voskReady = true;
  }
  const recognizerId = ++voskRecognizerIdCounter;
  postToVosk({ type: "create-recognizer", recognizerId, sampleRate: 16_000 });
  await waitForVosk(
    (message) => message.type === "recognizer-ready" && message.recognizerId === recognizerId,
    20_000,
    "本地识别器创建超时，请重试。"
  );
  voskRecognizerId = recognizerId;
}

async function restartVosk() {
  stopVoskRecognizer();
  resetDraftCommitter();
  if (captureSource === "mic") {
    await acquireStreamForSource("");
  } else if (!stream) {
    throw new Error("capture_not_running");
  }
  await startVosk();
}

function stopVoskRecognizer() {
  if (voskRecognizerId && voskFrame) {
    try {
      voskFrame.contentWindow.postMessage(
        { type: "remove-recognizer", recognizerId: voskRecognizerId },
        "*"
      );
    } catch { /* ignore */ }
  }
  voskRecognizerId = 0;
}

function flushVoskFrames() {
  if (!voskReady || !voskRecognizerId) return;
  while (frameQueue.length > 0) {
    const frame = frameQueue.shift();
    const samples = new Float32Array(frame.length / 2);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
    try {
      voskFrame.contentWindow.postMessage(
        { type: "audio-chunk", recognizerId: voskRecognizerId, data: samples },
        "*"
      );
    } catch {
      // 沙箱异常时停止投喂，等待错误路径处理
      return;
    }
  }
}

async function connectRealtime() {
  taskReady = false;
  taskId = randomTaskId();
  socket = new WebSocket(DASHSCOPE_WS);
  socket.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DashScope 连接超时。")), 20_000);
    socket.onopen = () => {
      socket.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
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
    socket.onmessage = (event) => {
      const message = parseJson(event.data);
      if (!message) return;
      const type = message?.header?.event || "";
      if (type === "task-started") {
        clearTimeout(timer);
        taskReady = true;
        retryCount = 0;
        clearRetryTimer();
        logEvent("ws-task-started", `task=${taskId}`);
        resolve();
        return;
      }
      handleDashScopeMessage(message);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      logEvent("ws-error", "");
      reject(new Error("无法连接 DashScope 实时识别。"));
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      taskReady = false;
      // close code 能区分断连原因：1000/1001 = 服务端/主动关闭，1006 = 网络断，
      // 4000+ = 服务端业务错误（如认证失败、配额）
      logEvent("ws-closed", `code=${event?.code ?? "?"} reason=${JSON.stringify(String(event?.reason || "").slice(0, 60))} stopping=${stopping}`);
      if (!stopping && stream) scheduleAutoReconnect();
    };
  });
}

function handleDashScopeMessage(message) {
  const event = message?.header?.event || "";
  if (event === "result-generated") {
    const sentence = message?.payload?.output?.sentence;
    if (!sentence || sentence.heartbeat) return;
    // 注意：不在这里根据 sentence_begin 重置断句状态。
    // 若服务端在句子的多个中间结果上都带 sentence_begin（或 final 晚于下一句
    // 的中间结果到达），重置会把已提交边界清空，导致同一个句子被重复上屏。
    // 句子切换由服务端 final 重置 + pendingText 前缀判断兜底。
    const text = String(sentence.text || "").trim();
    if (!text) return;
    const isFinal = Boolean(sentence.sentence_end);
    if (isFinal) {
      logEvent("asr-final",
        `text=${JSON.stringify(text.slice(0, 80))} len=${Array.from(text).length}`);
      handleServerFinal(text);
    } else {
      // 草稿是高频消息（每 100~300ms 一条）：日志节流到 300ms 一条，
      // 避免 KOE_LOG 写入风暴拖慢后台、字幕消息被排队（"卡住"）。
      // 识别与草稿显示不受影响，只少写日志。
      const now = Date.now();
      if (now - lastDraftLogAt >= 300) {
        lastDraftLogAt = now;
        logEvent("asr-draft",
          `text=${JSON.stringify(text.slice(0, 80))} len=${Array.from(text).length}`);
      }
      handleServerDraft(text);
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
      chrome.runtime.sendMessage({ type: "CAPTURE_ERROR", error }).catch(() => undefined);
    }
  }
}

// ===== 客户端断句器（移植 Mimi 的 ASRDraftCommitter，Turbo 参数）=====
// 服务端只提供“权威结果”，节奏由客户端掌握：
// - 草稿稳定 500ms → 按句末标点结句，立即作为字幕块提交；
// - 最长 2s 强制提交（长尾 ≥ 12 字也切），说话人一直不停顿也每 2s 出一块；
// - 服务端 final 到达时去重：已提交过的丢弃，延伸了本地块的用整句替换。
// 翻译因此永远拿到的是短文本，不会等整段独白。
const SENTENCE_DELIMITERS = ["。", "！", "？", ".", "!", "?", "\n"];
const LONG_INCOMPLETE_THRESHOLD = 12;
const STABLE_DRAFT_DELAY = 700;
const MAXIMUM_WAIT_DELAY = 4_000;
// 长句兜底切块阈值：服务端 final 发得很勤（每句都发），客户端强切只做极端兜底。
// 只有真正超长且无句号的长句（英文 120 字符 / 中文 60 字）才切，
// 否则无句号的草稿块也会上屏又撤回，造成"中间字幕闪一下"。
const LONG_CHUNK_LATIN = 120;
const LONG_CHUNK_CJK = 60;

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
    if (/[\u4e00-\u9fff]/.test(ch)) cjk += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  return latin >= cjk ? "latin" : "cjk";
}

// 长尾强制切块也有限长：英文最多 48 字符、中文最多 24 字，英文尽量在单词边界切。
// 剩下的继续留在待提交区，由下一个计时器再切。
function firstLongChunk(text) {
  const points = codePoints(text);
  const maxLen = textLanguage(text) === "latin" ? LONG_CHUNK_LATIN : LONG_CHUNK_CJK;
  if (points.length <= maxLen) return text;
  let end = maxLen;
  for (let index = maxLen; index >= Math.floor(maxLen / 2); index -= 1) {
    if (/\s/.test(points[index - 1])) {
      end = index;
      break;
    }
  }
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
  // 一句一块：只提交第一个完整句，其余留待下一次计时器继续切
  const firstSentence = firstCompleteSentence(pending);
  if (isMeaningful(firstSentence)) {
    commitChunk(firstSentence, pending);
    return firstSentence;
  }
  if (forceLongIncomplete) {
    const longChunk = firstLongChunk(pending);
    // 触发阈值也按语言：英文攒够 48 字符、中文 24 字才切，避免半句碎上屏。
    // 词边界切不满阈值时（长单词把边界顶到 40-47），只要待提交总量达阈值也切——
    // 否则超长句会一直卡在待提交区，字幕永远出不来。
    const minLen = textLanguage(pending) === "latin" ? LONG_CHUNK_LATIN : LONG_CHUNK_CJK;
    if (codePoints(longChunk).length >= minLen || codePoints(pending).length >= minLen) {
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

// 计时器采用 Mimi 的锚定方式：待提交文本出现时各创建一个计时器，
// 后续草稿更新不重置它们（所以说话中途出现的句号，最迟 ~500ms 后就被提交）。
// 与 Mimi 不同的是：稳定计时器不取消兜底计时器——连续不停顿的独白
// 每 2s 仍会被强制切一块（≥12 字长尾，最多 16 字）。
// 每次提交后若还有完整句在排队，就继续武装稳定计时器，一句一块按节奏出。
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

// 按句切块（保留句末标点），供权威 final 整段按句上屏，避免一大段/超长译文
function splitSentences(text) {
  const points = codePoints(text);
  const result = [];
  let start = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (SENTENCE_DELIMITERS.includes(points[index])) {
      const sentence = points.slice(start, index + 1).join("").trim();
      if (sentence) result.push(sentence);
      start = index + 1;
    }
  }
  const tail = points.slice(start).join("").trim();
  if (tail) result.push(tail);
  return result;
}

// 撤回当前句子的全部字幕块（识别修正时用），并清空待提交状态
function revokeCurrentSentence(reason) {
  const fromSeq = currentSentenceStartSeq || lastEmittedUnitSeq;
  if (!fromSeq || !lastEmittedUnitSeq) return;
  logEvent("revoke", `${reason} from=${fromSeq} to=${lastEmittedUnitSeq} old=${JSON.stringify(lastEmittedUnitText.slice(0, 40))}`);
  chrome.runtime.sendMessage({
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

// 判断两段文本是否共享词（同一句话的修正通常保留尾词，换句则无关）
function hasSharedWord(left, right) {
  const words = new Set(String(left || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const rightWords = String(right || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return rightWords.slice(-2).some((word) => words.has(word));
}

function handleServerDraft(text) {
  // 识别修正检测：服务端把已上屏的**整句换词**时（如 "Okayur assets" → "Identify your assets"，
  // 公共前缀极短但保留尾词），撤回当前句的字幕块，让修正后的文本重新累积。
  // 注意：词尾微调（"All right." → "All right, there's..."、way → weight、perfectright → perfect）
  // **绝不**在草稿阶段 revoke——服务端草稿在词尾震荡是常态，revoke 会把刚上屏的
  // 行连同译文一起删掉（"一开始字幕一直覆盖"）。词尾真修正交给 final 权威阶段处理。
  const draftText = String(text || "").trim();
  if (committedText && lastEmittedUnitSeq && draftText && !draftText.startsWith(committedText)) {
    // 服务端草稿临时截短/回退（重识别中）：draft 是已提交文本的前缀时，
    // 已上屏内容仍是正确前缀，绝不 revoke。
    if (!committedText.startsWith(draftText)) {
      const lcp = longestCommonPrefix(draftText, committedText);
      const fullSwap = lcp < 3 && hasSharedWord(draftText, committedText);
      if (fullSwap) {
        revokeCurrentSentence(`draft-swap new=${JSON.stringify(draftText.slice(0, 40))}`);
      }
    }
  }
  const tail = updateDraft(text);
  if (!tail || !isMeaningful(tail)) return;
  scheduleDraftTimers();
  if (tail === lastEmittedTail) return;
  lastEmittedTail = tail;
  const seq = ++emitSeq;
  logEvent("draft-emit", `seq=${seq} tail=${JSON.stringify(tail.slice(0, 60))}`);
  chrome.runtime.sendMessage({
    type: "CAPTURE_PARTIAL",
    lines: [{ text: tail }],
    seq
  }).catch(() => undefined);
  if (captureTranslate) {
    // 翻译只译“即将上屏的那一句”，与字幕块对齐——译整段待提交文本
    // 会让译文比字幕多出后续内容，图文对不上。
    const first = firstCompleteSentence(tail) || tail;
    scheduleDraftTranslation(first, seq);
  }
}

function handleServerFinal(text) {
  cancelDraftTimers();
  const finalText = String(text).trim();
  const lastUnit = lastUnitTexts[lastUnitTexts.length - 1] || "";

  // 对账：final 与最近上屏的块完全相同，或只是其中一部分 → 已经显示过，跳过
  if (lastUnit && (lastUnitTexts.includes(finalText) || lastUnit.startsWith(finalText))) {
    logEvent("final-dup", `final=${JSON.stringify(finalText.slice(0, 60))} lastUnit=${JSON.stringify(lastUnit.slice(0, 60))}`);
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
        if (isMeaningful(tail)) emitFinalSentences(tail);
        logEvent("final-tail-only", `after=${JSON.stringify(tail.slice(0, 40))}`);
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
        emitFinalSentences(finalText);
        dropQueuedDrafts();
        resetDraftCommitter();
        return;
      }
    }
  }

  const outcome = finishSentence(finalText);
  logEvent(`final-${outcome.kind}`,
    `final=${JSON.stringify(finalText.slice(0, 60))} out=${JSON.stringify(String(outcome.text || "").slice(0, 60))} committedLen=${Array.from(committedText).length}`);
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
      emitFinalSentences(unitText);
    }
  }
  // 旧草稿尾的翻译已过期，丢弃；下一句从头开始
  dropQueuedDrafts();
  resetDraftCommitter();
}

// final 文本按句切块逐条上屏；已上屏过的块跳过（防重复）
function emitFinalSentences(text) {
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (lastUnitTexts.includes(sentence)) continue;
    if (!isMeaningful(sentence)) continue;
    emitUnit(sentence);
  }
}

function emitCommittedUnit(text) {
  emitUnit(text);
}

function emitUnit(text) {
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
  logEvent("unit-emit", `seq=${seq} text=${JSON.stringify(unitText.slice(0, 80))}`);
  chrome.runtime.sendMessage({
    type: "CAPTURE_LINES",
    lines: [{ text: unitText }],
    seq,
    unit: true
  }).catch(() => undefined);
  if (captureTranslate) scheduleUnitTranslation(unitText, seq);
}

// ===== 翻译调度：单队列串行 + 统一限速 =====
// 之前两条翻译管线（字幕块队列 + 草稿链）并行发请求，短块变多后请求频率
// 翻倍，容易触发 DashScope 限流（429）→ 全部翻译失败退原文。
// 现在合并成一条串行队列：字幕块优先，草稿尾只保留最新一条补位；
// 请求至少间隔 700ms；限流后进入冷却期，冷却期内跳过草稿；
// 积压时一次请求批量译 2 个字幕块，把请求频率压回配额内。
const MIN_TRANSLATION_INTERVAL = 700;
const TRANSLATE_COOLDOWN_MS = 20_000;
const translationQueue = []; // { kind: "unit" | "draft", text, seq }
let translatorRunning = false;
let lastTranslationAt = 0;
let throttleCooldownUntil = 0;
let inFlightItem = null; // 正在处理的请求；草稿被更新的草稿取代时标记 superseded

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function translateText(text, { model = TRANSLATE_MODEL_FINAL, memory = [] } = {}) {
  if (isAlreadyChinese(text)) return text;
  const apiKey = captureApiKey;
  if (!apiKey) return "";
  const body = {
    model,
    // 官方文档要求：qwen-mt 只接受一条 user 消息，不支持 system 消息——
    // 之前靠 system 提示词指定目标语言是无效的，模型会自己猜方向，
    // 译文语言完全随机。必须用 translation_options 显式指定目标语言。
    input: {
      messages: [{ role: "user", content: text }]
    },
    parameters: {
      result_format: "message",
      translation_options: {
        source_lang: "auto",
        target_lang: "Chinese",
        // 字幕风格提示（domains）+ 翻译记忆（tm_list）：移植 Mimi 的参数
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
      "X-DashScope-SSE": "disable"
    },
    body: JSON.stringify(body)
  });
  const bodyJson = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(bodyJson?.message || `translate_failed:${response.status}`);
  return String(
    bodyJson?.output?.choices?.[0]?.message?.content || bodyJson?.output?.text || ""
  ).trim();
}

function scheduleUnitTranslation(text, seq) {
  translationQueue.push({ kind: "unit", text, seq });
  void runTranslationWorker();
}

function scheduleDraftTranslation(text, seq) {
  // 合并：队列里只保留最新一条草稿，避免草稿翻译堆积挤占字幕块
  dropQueuedDrafts();
  translationQueue.push({ kind: "draft", text, seq });
  void runTranslationWorker();
}

function dropQueuedDrafts() {
  // 队列里只保留最新一条草稿；正在翻译的草稿也标记作废（完成后直接丢弃）
  if (inFlightItem && inFlightItem.kind === "draft") inFlightItem.superseded = true;
  for (let index = translationQueue.length - 1; index >= 0; index -= 1) {
    if (translationQueue[index].kind === "draft") translationQueue.splice(index, 1);
  }
}

async function runTranslationWorker() {
  if (translatorRunning) return;
  translatorRunning = true;
  while (translationQueue.length > 0) {
    const item = translationQueue.shift();
    inFlightItem = item;
    const generation = captureGeneration;

    // 限流冷却期内直接跳过草稿（字幕块仍会重试，稳定行不能断）
    if (item.kind === "draft" && Date.now() < throttleCooldownUntil) {
      logEvent("translation-skip", "cooldown draft");
      inFlightItem = null;
      continue;
    }

    // 与上一请求至少间隔 700ms，避免请求频率触顶
    const waitMs = lastTranslationAt + MIN_TRANSLATION_INTERVAL - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    // 草稿已被更新的草稿取代：省掉这次请求
    if (item.kind === "draft" && item.superseded) {
      logEvent("translation-skip", "superseded draft");
      inFlightItem = null;
      continue;
    }

    // 积压时相邻两个字幕块合并成一次编号翻译
    const batch = [item];
    if (item.kind === "unit") {
      while (batch.length < 2 && translationQueue.length > 0 && translationQueue[0].kind === "unit") {
        batch.push(translationQueue.shift());
      }
    }

    let parts = [];
    // 双模型分工（移植 Mimi）：草稿翻译用 flash（快、及时），
    // 权威 final 翻译用 plus（准、流畅）+ 翻译记忆保持术语一致
    const isDraft = item.kind === "draft";
    const model = isDraft ? TRANSLATE_MODEL_DRAFT : TRANSLATE_MODEL_FINAL;
    const memory = isDraft ? [] : recentTranslationMemory();
    logEvent("translation-request", `kind=${item.kind} model=${model} batch=${batch.length} text=${JSON.stringify(batch[0].text.slice(0, 40))}`);
    try {
      if (batch.length === 1) {
        parts = [await translateWithRetry(batch[0].text, { model, memory })];
      } else {
        const numbered = batch.map((entry, index) => `${index + 1}. ${entry.text}`).join("\n");
        parts = parseNumberedTranslations(await translateWithRetry(numbered, { model, memory }), batch.length);
      }
    } catch {
      parts = [];
      logEvent("translation-failed", `kind=${item.kind} text=${JSON.stringify(batch[0].text.slice(0, 40))}`);
    }
    lastTranslationAt = Date.now();
    inFlightItem = null;
    if (generation !== captureGeneration) {
      translationQueue.length = 0;
      break;
    }
    if (item.kind === "draft" && item.superseded) continue; // 翻译期间被取代：丢弃结果
    batch.forEach((entry, index) => {
      const translated = parts[index] || "";
      if (translated) logEvent("translation-ok", `kind=${entry.kind} seq=${entry.seq} out=${JSON.stringify(translated.slice(0, 40))}`);
      if (entry.kind === "unit") {
        if (translated) rememberTranslation(entry.text, translated);
        // 彻底失败才退原文，保证稳定行不断
        chrome.runtime.sendMessage({
          type: "CAPTURE_TRANSLATED",
          // 失败时发空译文（translated=""），侧边栏会跳过该句——
          // 不把原文混进译文历史（移植 Mimi：宁缺毋滥，避免"字幕变英文"）
          lines: [{ text: entry.text, translated }],
          seq: entry.seq,
          unit: true
        }).catch(() => undefined);
      } else if (translated) {
        chrome.runtime.sendMessage({
          type: "CAPTURE_TRANSLATED",
          lines: [{ text: entry.text, translated }],
          seq: entry.seq
        }).catch(() => undefined);
      }
    });
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
      // 新模型（qwen-mt-flash/plus）未开通时回退到 turbo，避免翻译全挂
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

// 批量翻译结果解析：模型按 "1. xxx\n2. xxx" 返回时逐条对应；
// 没有按编号返回时整段当作第一条译文，其余由调用方退回原文。
function parseNumberedTranslations(result, count) {
  const text = String(result || "").trim();
  if (count <= 1) return [text];
  const pieces = text
    .split(/\n+/)
    .map((line) => line.replace(/^\d+[.、．)]\s*/, "").trim())
    .filter(Boolean);
  if (pieces.length === count) return pieces;
  return [text, ...new Array(count - 1).fill("")];
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
    const source = audioContext.createMediaStreamSource(stream);
    source.channelCount = 1;
    source.channelCountMode = "explicit";
    source.channelInterpretation = "speakers";
    // 2048 样本 @ 16 kHz = 128 ms 一块：块一到手立刻发送，不依赖定时器。
    // 离屏页的 setInterval 可能被浏览器节流，之前靠定时器发帧会让字幕越来越滞后。
    processor = audioContext.createScriptProcessor(2_048, 1, 1);
    processor.onaudioprocess = (event) => {
      enqueueSamples(event.inputBuffer.getChannelData(0));
      flushFrames();
    };
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(audioContext.destination);
    return true;
  } catch {
    await stopPcmCapture();
    return false;
  }
}

function enqueueSamples(samples) {
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
  if (frameQueue.length > 50) frameQueue.splice(0, frameQueue.length - 50);
}

function flushFrames() {
  if (captureEngine.startsWith("vosk")) {
    flushVoskFrames();
    return;
  }
  if (!taskReady || !socket || socket.readyState !== WebSocket.OPEN) return;
  while (frameQueue.length > 0) {
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
  closeSocket(false);
  frameQueue = [];
  pcmPending = new Uint8Array(0);
  translationQueue.length = 0;
  lastUnitTexts.length = 0;
  resetDraftCommitter();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await connectRealtime();
}

function scheduleAutoReconnect() {
  if (stopping || retryTimer) return;
  if (retryCount >= MAX_AUTO_RETRIES) {
    logEvent("ws-reconnect-exhausted", `retries=${retryCount}`);
    chrome.runtime.sendMessage({
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
    try { processor.disconnect(); } catch { /* ignore */ }
    processor.onaudioprocess = null;
    processor = null;
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
  stopVoskRecognizer();
  await stopPcmCapture();
  closeSocket(true);
  taskId = "";
  emitSeq = 0;
  translationQueue.length = 0;
  inFlightItem = null;
  throttleCooldownUntil = 0;
  lastTranslationAt = 0;
  lastUnitTexts.length = 0;
  resetDraftCommitter();
  // stream 与 monitorAudio 保留，供下次开启复用
  logEvent("stopped", "recognition-only (stream kept)");
}

async function stopCapture() {
  logEvent("stop", "full (stream released)");
  stopping = true;
  captureGeneration += 1;
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
  stopVoskRecognizer();
  await stopPcmCapture();
  releaseStream();
  closeSocket(true);
  taskId = "";
  emitSeq = 0;
  translationQueue.length = 0;
  inFlightItem = null;
  throttleCooldownUntil = 0;
  lastTranslationAt = 0;
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
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cjk > 0 && cjk >= latin;
}
