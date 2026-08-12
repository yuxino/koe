// 离屏采集页：把标签页声音转成 16kHz PCM，通过 WebSocket 送给本地助手。
// 不做任何视频下载/格式转换，只负责“声音 → 字节流”。

let stream = null;
let monitorAudio = null;
let audioContext = null;
let processor = null;
let socket = null;
let captureServerUrl = "";
let captureTranslate = false;

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
    resetSocket(message).then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  return false;
});

async function startCapture({ streamId, serverUrl, translate }) {
  await stopCapture();
  if (!streamId || !serverUrl) throw new Error("缺少标签页音频流或服务地址。");
  captureServerUrl = String(serverUrl || "").replace(/\/+$/, "");
  captureTranslate = Boolean(translate);

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
    }
  });

  // tabCapture 会静音标签页，把采集到的声音播回去，保证用户仍能听到
  monitorAudio = new Audio();
  monitorAudio.srcObject = stream;
  monitorAudio.play().catch(() => undefined);

  try {
    socket = await openSocket();
    socket.onmessage = (event) => handleServerMessage(event);
    const started = await startPcmCapture();
    if (!started) throw new Error("浏览器不支持 16kHz 音频采集。");
    socket.send(JSON.stringify({ type: "start", format: "pcm", translate: captureTranslate }));
    return { ok: true, mode: "pcm" };
  } catch (error) {
    await stopCapture();
    throw error;
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
    processor.onaudioprocess = (event) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      socket.send(pcm.buffer);
    };
    // 处理器连到 0 增益输出，只驱动 onaudioprocess，不产生第二份声音
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

async function resetSocket({ serverUrl, translate }) {
  // 同一标签页换了视频：保持已授权的音频流不断，只重连识别会话，
  // 这样点一次图标，本页里切多少个视频都能继续出实时字幕
  if (!stream) throw new Error("capture_not_running");
  captureServerUrl = String(serverUrl || "").replace(/\/+$/, "");
  captureTranslate = Boolean(translate);
  if (socket) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
    } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
  }
  // 等旧会话在服务端释放，避免新会话被“busy”拒绝
  await new Promise((resolve) => setTimeout(resolve, 400));
  socket = await openSocket();
  socket.onmessage = (event) => handleServerMessage(event);
  socket.send(JSON.stringify({ type: "start", format: "pcm", translate: captureTranslate }));
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${captureServerUrl.replace(/^http/, "ws")}/api/capture/ws`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("无法连接本地助手采集接口。"));
  });
}

function handleServerMessage(event) {
  if (typeof event.data !== "string") return;
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === "lines" || message.type === "partial") {
    const lines = Array.isArray(message.lines) ? message.lines : [];
    if (!lines.length) return;
    chrome.runtime.sendMessage({
      type: message.type === "lines" ? "CAPTURE_LINES" : "CAPTURE_PARTIAL",
      lines,
      seq: message.seq
    }).catch(() => undefined);
    return;
  }
  if (message.type === "translated") {
    const lines = Array.isArray(message.lines) ? message.lines : [];
    if (!lines.length) return;
    chrome.runtime.sendMessage({
      type: "CAPTURE_TRANSLATED",
      lines,
      seq: message.seq
    }).catch(() => undefined);
    return;
  }
  if (message.type === "error") {
    chrome.runtime.sendMessage({
      type: "CAPTURE_ERROR",
      error: message.error || "实时字幕采集失败"
    }).catch(() => undefined);
    void stopCapture();
    return;
  }
  if (message.type === "done") {
    void stopCapture();
  }
}

async function stopPcmCapture() {
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

async function stopCapture() {
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
  if (socket) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
    } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
  }
  captureServerUrl = "";
}
