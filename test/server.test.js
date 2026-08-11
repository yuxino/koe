import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server/index.js";

test("mock server creates a complete batch caption job", async (t) => {
  const app = createServer({ port: 0, provider: "mock" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.mode, "batch");
  assert.equal(health.provider, "mock");

  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageUrl: "https://www.pornhub.com/view_video.php?viewkey=test", filename: "sample.mp4" })
  }).then((response) => response.json());
  assert.ok(["queued", "downloading", "analyzing", "ready"].includes(created.status));

  const ready = await waitForJob(baseUrl, created.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.lineCount, 1);

  const vtt = await fetch(`${baseUrl}/api/jobs/${created.id}/vtt`).then((response) => response.text());
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /演示字幕/);
});

test("accepts a local video upload as a batch job", async (t) => {
  const app = createServer({ port: 0, provider: "mock" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload: true, filename: "local.mp4" })
  }).then((response) => response.json());
  assert.equal(created.status, "queued");

  const upload = await fetch(`${baseUrl}/api/jobs/${created.id}/source`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "x-filename": "local.mp4" },
    body: Buffer.from("fake-video")
  });
  assert.equal(upload.status, 202);
  assert.equal((await waitForJob(baseUrl, created.id)).status, "ready");
});

test("rejects unsupported page sources", async (t) => {
  const app = createServer({ port: 0, provider: "mock" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageUrl: "https://example.com/video" })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unsupported_page_source");
});

test("protects batch jobs when an API token is configured", async (t) => {
  const app = createServer({ port: 0, provider: "mock", apiToken: "secret-token" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${baseUrl}/api/jobs`, { method: "POST" });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { Authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ pageUrl: "https://xvideos.com/video-test" })
  });
  assert.equal(authorized.status, 202);
});

test("reports in-flight job count in health", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = createServer({
    port: 0,
    provider: "mock",
    processJob: async () => {
      await gate;
      return { vtt: "WEBVTT\n\n", lines: [] };
    }
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload: true, filename: "busy.wav" })
  }).then((response) => response.json());
  await fetch(`${baseUrl}/api/jobs/${created.id}/source`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: Buffer.from("x")
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const busy = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(busy.activeJobs, 1);

  release();
  assert.equal((await waitForJob(baseUrl, created.id)).status, "ready");
  const idle = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(idle.activeJobs, 0);
});

test("local relay mode accepts a generic public video page", async (t) => {
  const app = createServer({
    port: 0,
    remoteUrl: "https://koe-api.example.test",
    remoteToken: "remote-secret",
    processJob: async () => ({ vtt: "WEBVTT\n\n", lines: [] })
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.mode, "local-relay");
  assert.equal(health.localProcessing, true);
  assert.equal(health.provider, "relay");

  const response = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageUrl: "https://unknown.example/watch/1", filename: "generic-video" })
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.equal((await waitForJob(baseUrl, created.id)).status, "ready");
});

const ffmpegBin = resolveFfmpeg();

test("local relay mode relays an uploaded audio file", { skip: !ffmpegBin && "ffmpeg not available" }, async (t) => {
  const remote = createServer({ port: 0, provider: "mock" });
  await new Promise((resolve) => remote.server.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.server.close());
  const app = createServer({
    port: 0,
    ffmpegBin,
    remoteUrl: `http://127.0.0.1:${remote.server.address().port}`,
    remoteToken: ""
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload: true, filename: "capture.wav" })
  }).then((response) => response.json());
  assert.equal(created.status, "queued");

  const upload = await fetch(`${baseUrl}/api/jobs/${created.id}/source`, {
    method: "POST",
    headers: { "content-type": "audio/wav", "x-filename": "capture.wav" },
    body: createSilentWav(1_600)
  });
  assert.equal(upload.status, 202);
  assert.equal((await waitForJob(baseUrl, created.id)).status, "ready");
});

async function waitForJob(baseUrl, id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const job = await fetch(`${baseUrl}/api/jobs/${id}`).then((response) => response.json());
    if (job.status === "ready" || job.status === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish in time");
}

function createSilentWav(sampleCount) {
  const data = Buffer.alloc(sampleCount * 2);
  const wav = Buffer.alloc(44 + data.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_BIN,
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    join(homedir(), ".local/share/koe/venv/lib/python3.9/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate) || spawnSync("which", [candidate]).status === 0) return candidate;
  }
  return null;
}
