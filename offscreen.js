let recorder = null;
let stream = null;
let chunks = [];
let captureServerUrl = "";

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

async function startCapture({ streamId, serverUrl }) {
  await stopCapture();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
    }
  });
  chunks = [];
  captureServerUrl = String(serverUrl || "").replace(/\/+$/, "");
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.start(1_000);
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
  if (!chunks.length) {
    chunks = [];
    return { ok: false, error: "没有采集到声音，请确认视频已经播放。" };
  }
  const blob = new Blob(chunks, { type: "audio/webm" });
  chunks = [];
  const jobId = await uploadBlob(blob);
  return { ok: true, stopped: true, jobId };
}

async function uploadBlob(blob) {
  const created = await fetch(`${captureServerUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload: true, filename: "capture.webm" })
  });
  const body = await created.json().catch(() => ({}));
  if (!created.ok) throw new Error(body.error || `创建任务失败（${created.status}）`);
  const upload = await fetch(`${captureServerUrl}/api/jobs/${body.id}/source`, {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm", "x-filename": "capture.webm" },
    body: blob
  });
  if (!upload.ok) {
    const err = await upload.json().catch(() => ({}));
    throw new Error(err.error || `上传声音失败（${upload.status}）`);
  }
  return body.id;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
