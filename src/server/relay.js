import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function relayAudioToKoe({
  audioPath,
  filename = "audio.m4a",
  remoteUrl,
  remoteToken = "",
  pollIntervalMs = 2_000,
  maxPolls = 1_800,
  onProgress = () => undefined,
  fetchImpl = fetch
}) {
  const baseUrl = normalizeRemoteUrl(remoteUrl);
  const headers = authHeaders(remoteToken);
  const created = await requestJson(fetchImpl, `${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ upload: true, filename })
  }, "remote_job_create_failed");

  const file = await stat(audioPath);
  const upload = await fetchImpl(`${baseUrl}/api/jobs/${created.id}/source`, {
    method: "POST",
    headers: {
      "content-type": "audio/mp4",
      "content-length": String(file.size),
      "x-filename": filename,
      ...headers
    },
    body: createReadStream(audioPath),
    duplex: "half"
  });
  await expectSuccess(upload, "remote_audio_upload_failed");

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const job = await requestJson(fetchImpl, `${baseUrl}/api/jobs/${created.id}`, { headers }, "remote_job_read_failed");
    onProgress(Number(job.progress || 0));
    if (job.status === "error") throw new Error(`remote_job_failed:${job.error || "unknown"}`);
    if (job.status === "ready") {
      const response = await fetchImpl(`${baseUrl}/api/jobs/${created.id}/vtt`, { headers });
      if (!response.ok) await expectSuccess(response, "remote_vtt_download_failed");
      onProgress(1);
      return { vtt: await response.text(), remoteJobId: created.id };
    }
    await delay(pollIntervalMs);
  }
  throw new Error("remote_job_timeout");
}

async function requestJson(fetchImpl, url, options, fallback) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error("remote_unauthorized");
  if (!response.ok) throw new Error(`${fallback}:${body.error || response.status}`);
  return body;
}

async function expectSuccess(response, fallback) {
  if (response.status === 401) throw new Error("remote_unauthorized");
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  throw new Error(`${fallback}:${body.error || response.status}`);
}

function normalizeRemoteUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("remote_url_https_required");
  }
  return url.toString().replace(/\/+$/, "");
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
