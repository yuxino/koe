let recorder = null;
let stream = null;
let monitorAudio = null;
let captureServerUrl = "";
let captureOffsetMs = 0;
let chunkIndex = 0;
let chain = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_START") {
    startCapture(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }
  if (message.type === "CAPTURE_STOP") {
    stopCapture().then(sendResponse).catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }
  return false;
});

async function startCapture({ streamId, serverUrl, offsetMs }) {
  await stopCapture();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
    }
  });
  // tabCapture 会静音标签页，把采集到的声音在后台播回去，保证能听到
  monitorAudio = new Audio();
  monitorAudio.srcObject = stream;
  monitorAudio.play().catch(() => {
    try {
      const context = new AudioContext();
      const sourceNode = context.createMediaStreamSource(stream);
      sourceNode.connect(context.destination);
    } catch {
      // 自动播放被拦时保持录制，声音缺失由浏览器策略决定
    }
  });
  captureServerUrl = String(serverUrl || "").replace(/\/+$/, "");
  captureOffsetMs = Number(offsetMs) || 0;
  chunkIndex = 0;
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) sendChunk(event.data);
  };
  recorder.start(3_000);
  return { ok: true };
}

async function stopCapture() {
  if (!recorder) return { ok: true, stopped: false };
  const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(); });
  if (recorder.state !== "inactive") recorder.stop();
  await stopped;
  recorder = null;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (monitorAudio) {
    monitorAudio.srcObject = null;
    monitorAudio = null;
  }
  await chain.catch(() => undefined);
  return { ok: true, stopped: true };
}

function sendChunk(blob) {
  const index = chunkIndex;
  chunkIndex += 1;
  const startMs = captureOffsetMs + index * 3_000;
  chain = chain.then(async () => {
    try {
      const response = await fetch(`${captureServerUrl}/api/capture/analyze`, {
        method: "POST",
        headers: {
          "content-type": blob.type || "audio/webm",
          "x-start-ms": String(startMs)
        },
        body: blob
      });
      if (response.ok) {
        const body = await response.json();
        if (body.lines?.length) {
          chrome.runtime.sendMessage({ type: "CAPTURE_LINES", lines: body.lines }).catch(() => undefined);
        }
      }
    } catch {
      // 单个块失败不影响后续
    }
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
