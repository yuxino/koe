// Koe offscreen capture: tab audio -> 16 kHz PCM -> DashScope directly.
// No localhost helper is required at runtime.

const DASHSCOPE_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const TRANSLATE_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
const ASR_MODEL = "qwen-audio-3.0-asr-flash-streaming";
const TRANSLATE_MODEL = "qwen-mt-turbo";
const PCM_FRAME_BYTES = 3_200; // 100 ms, 16 kHz mono int16
const MAX_AUTO_RETRIES = 5;

let stream = null;
let monitorAudio = null;
let audioContext = null;
let processor = null;
let socket = null;
let taskId = "";
let taskReady = false;
let captureTranslate = false;
let captureApiKey = "";
let retryCount = 0;
let retryTimer = null;
let frameTimer = null;
let pcmPending = new Uint8Array(0);
let frameQueue = [];
let sentenceSeq = 0;
let stopping = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === "CAPTURE_START") {
    startCapture(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === "CAPTURE_STOP") {
    stopCapture().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === "CAPTURE_RESET") {
    captureTranslate = Boolean(message.translate);
    resetSocket().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  return false;
});

async function startCapture({ streamId, translate, apiKey }) {
  retryCount = 0;
  stopping = false;
  clearRetryTimer();
  await stopCapture();
  stopping = false;
  if (!streamId) throw new Error("缺少标签页音频流。");
  captureApiKey = String(apiKey || "").trim();
  if (!captureApiKey) throw new Error("请先在 Koe 中保存 DashScope API Key。");
  captureTranslate = Boolean(translate);
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
    }
  });

  monitorAudio = new Audio();
  monitorAudio.srcObject = stream;
  monitorAudio.play().catch(() => undefined);

  try {
    await connectRealtime();
    const started = await startPcmCapture();
    if (!started) throw new Error("浏览器不支持 16kHz 音频采集。");
    return { ok: true, mode: "direct" };
  } catch (error) {
    await stopCapture();
    throw error;
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
          parameters: { format: "pcm", sample_rate: 16_000 },
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
        resolve();
        return;
      }
      handleDashScopeMessage(message);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("无法连接 DashScope 实时识别。"));
    };
    socket.onclose = () => {
      clearTimeout(timer);
      taskReady = false;
      if (!stopping && stream) scheduleAutoReconnect();
    };
  });
}

function handleDashScopeMessage(message) {
  const event = message?.header?.event || "";
  if (event === "result-generated") {
    const sentence = message?.payload?.output?.sentence;
    if (!sentence || sentence.heartbeat) return;
    const text = String(sentence.text || "").trim();
    if (!text) return;
    const final = Boolean(sentence.sentence_end);
    const seq = final ? ++sentenceSeq : sentenceSeq + 1;
    const line = {
      text,
      beginTime: Number(sentence.begin_time || 0),
      endTime: Number(sentence.end_time || 0)
    };
    chrome.runtime.sendMessage({
      type: final ? "CAPTURE_LINES" : "CAPTURE_PARTIAL",
      lines: [line],
      seq
    }).catch(() => undefined);
    if (final && captureTranslate) void translateFinal(line, seq);
    return;
  }
  if (event === "task-failed") {
    const error = message?.header?.error_message || "DashScope 实时识别失败";
    chrome.runtime.sendMessage({ type: "CAPTURE_ERROR", error }).catch(() => undefined);
    if (isRetryable(error)) scheduleAutoReconnect();
  }
}

async function translateFinal(line, seq) {
  try {
    if (isAlreadyChinese(line.text)) {
      await chrome.runtime.sendMessage({
        type: "CAPTURE_TRANSLATED",
        lines: [{ ...line, translated: line.text }],
        seq
      });
      return;
    }
    const apiKey = captureApiKey;
    if (!apiKey) return;
    const response = await fetch(TRANSLATE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-DashScope-SSE": "disable"
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        input: {
          messages: [
            {
              role: "system",
              content: "你是字幕翻译器。把输入翻译成自然、简洁、口语化的简体中文，只输出译文，不解释。保留人名、地名和品牌名。"
            },
            { role: "user", content: line.text }
          ]
        },
        parameters: { result_format: "message" }
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || `translate_failed:${response.status}`);
    const translated = String(
      body?.output?.choices?.[0]?.message?.content || body?.output?.text || ""
    ).trim();
    if (!translated) return;
    await chrome.runtime.sendMessage({
      type: "CAPTURE_TRANSLATED",
      lines: [{ ...line, translated }],
      seq
    });
  } catch {
    // Translation failure must not interrupt original subtitles.
  }
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
    processor = audioContext.createScriptProcessor(4_096, 1, 1);
    processor.onaudioprocess = (event) => enqueueSamples(event.inputBuffer.getChannelData(0));
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(audioContext.destination);
    frameTimer = setInterval(flushFrame, 100);
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

function flushFrame() {
  if (!taskReady || !socket || socket.readyState !== WebSocket.OPEN) return;
  const frame = frameQueue.shift();
  if (!frame) return;
  try { socket.send(frame.buffer); } catch { scheduleAutoReconnect(); }
}

async function resetSocket() {
  if (!stream) throw new Error("capture_not_running");
  closeSocket(false);
  frameQueue = [];
  pcmPending = new Uint8Array(0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await connectRealtime();
}

function scheduleAutoReconnect() {
  if (stopping || retryTimer) return;
  if (retryCount >= MAX_AUTO_RETRIES) {
    chrome.runtime.sendMessage({
      type: "CAPTURE_ERROR",
      error: "DashScope 重连失败，请检查网络或 API Key。"
    }).catch(() => undefined);
    return;
  }
  retryCount += 1;
  const delayMs = Math.min(4_000, 300 * 2 ** Math.max(0, retryCount - 1));
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
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
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

async function stopCapture() {
  stopping = true;
  clearRetryTimer();
  await stopPcmCapture();
  if (monitorAudio) {
    try { monitorAudio.srcObject = null; } catch { /* ignore */ }
    try { monitorAudio.pause(); } catch { /* ignore */ }
    monitorAudio = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  closeSocket(true);
  taskId = "";
  sentenceSeq = 0;
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
