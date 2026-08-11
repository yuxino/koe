let capture = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return undefined;
  if (message.type === "START_CAPTURE") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    stopCapture(Number(message.tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message.type === "VIDEO_CLOCK") {
    if (capture?.tabId === Number(message.tabId)) capture.videoClock = message.clock;
    sendResponse({ ok: true });
    return false;
  }
  return undefined;
});

async function startCapture({ tabId, streamId, serverUrl, apiToken, pageUrl }) {
  await stopCapture(tabId);
  const sessionResponse = await fetch(`${serverUrl}/api/session/start`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(apiToken) },
    body: JSON.stringify({ tabId, pageUrl })
  });
  const session = await sessionResponse.json().catch(() => ({}));
  if (!sessionResponse.ok || !session.id) {
    throw new Error(session.error || "字幕服务没有启动会话，请先运行 npm start。");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
  const audioContext = new AudioContext();
  await audioContext.resume();
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));
  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "koe-pcm-capture", { numberOfOutputs: 0 });
  source.connect(audioContext.destination);
  source.connect(worklet);

  capture = {
    tabId,
    serverUrl,
    apiToken: String(apiToken || ""),
    sessionId: session.id,
    stream,
    audioContext,
    source,
    worklet,
    sampleRate: audioContext.sampleRate,
    chunks: [],
    sampleCount: 0,
    videoClock: null,
    startedAt: performance.now(),
    chunkStartedAt: performance.now(),
    timer: null,
    sending: Promise.resolve()
  };
  worklet.port.onmessage = (event) => {
    if (!capture || capture.tabId !== tabId) return;
    const samples = new Float32Array(event.data);
    capture.chunks.push(samples);
    capture.sampleCount += samples.length;
  };
  capture.timer = setInterval(() => flushChunk(false).catch((error) => reportError(tabId, error)), 15_000);
  await notify({ type: "CAPTURE_STATUS", tabId, status: "running" });
}

async function stopCapture(tabId) {
  if (!capture || capture.tabId !== tabId) return;
  const active = capture;
  capture = null;
  clearInterval(active.timer);
  await flushChunkFor(active, true).catch((error) => reportError(tabId, error));
  active.worklet.disconnect();
  active.source.disconnect();
  active.stream.getTracks().forEach((track) => track.stop());
  await active.audioContext.close().catch(() => undefined);
  await fetch(`${active.serverUrl}/api/session/${active.sessionId}/stop`, { headers: authHeaders(active.apiToken), method: "POST" }).catch(() => undefined);
}

async function flushChunk(force) {
  if (!capture) return;
  const active = capture;
  active.sending = active.sending.then(() => flushChunkFor(active, force));
  await active.sending;
}

async function flushChunkFor(active, force) {
  if (!active.sampleCount) return;
  if (!force && performance.now() - active.chunkStartedAt < 5_000) return;

  const samples = new Float32Array(active.sampleCount);
  let offset = 0;
  for (const chunk of active.chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  active.chunks = [];
  active.sampleCount = 0;
  active.chunkStartedAt = performance.now();

  const output = resample(samples, active.sampleRate, 16_000);
  const wav = encodeWav(output, 16_000);
  const durationMs = Math.round(output.length / 16_000 * 1_000);
  const elapsedMs = Math.round(performance.now() - active.startedAt);
  const startMs = Number.isFinite(active.videoClock?.timeMs) ? active.videoClock.timeMs : Math.max(0, elapsedMs - durationMs);
  const endMs = startMs + durationMs;
  const response = await fetch(`${active.serverUrl}/api/session/${active.sessionId}/chunk`, {
    method: "POST",
    headers: {
      "content-type": "audio/wav",
      "x-start-ms": String(Math.round(startMs)),
      "x-end-ms": String(Math.round(endMs)),
      ...authHeaders(active.apiToken)
    },
    body: wav
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `字幕服务返回 ${response.status}`);
  for (const line of body.lines || []) await notify({ type: "SUBTITLE", tabId: active.tabId, line });
}

function resample(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const weight = position - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return buffer;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

async function notify(message) {
  await chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function reportError(tabId, error) {
  await notify({ type: "CAPTURE_ERROR", tabId, error: error instanceof Error ? error.message : String(error) });
}

function authHeaders(apiToken) {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}
