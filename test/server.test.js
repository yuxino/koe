import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  assert.equal(ready.stageDetail, "模拟识别");

  const vtt = await fetch(`${baseUrl}/api/jobs/${created.id}/vtt`).then((response) => response.text());
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /演示字幕/);
});

test("reuses cached subtitles for the same source url", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "koe-cache-test-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  let runs = 0;
  const app = createServer({
    port: 0,
    provider: "mock",
    cacheRoot: cacheDir,
    processJob: async () => {
      runs += 1;
      const lines = [{ startMs: 0, endMs: 1_000, text: "缓存测试", translated: "缓存测试" }];
      return { lines, vtt: `WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n缓存测试\n缓存测试\n` };
    }
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const sourceUrl = "https://cdn.example.com/video.mp4";

  const first = await createJob({ sourceUrl });
  assert.equal((await waitForJob(baseUrl, first.id)).status, "ready");
  assert.equal(runs, 1);

  const second = await createJob({ sourceUrl });
  assert.equal(second.status, "ready");
  assert.equal(second.fromCache, true);
  assert.equal(runs, 1);

  const seek = await createJob({ sourceUrl, startMs: 500 });
  assert.equal(seek.status, "ready");
  assert.equal(seek.fromCache, true);
  assert.equal(runs, 1);

  async function createJob(body) {
    return fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageUrl: "https://www.pornhub.com/view_video.php?viewkey=test", filename: "cached.mp4", ...body })
    }).then((response) => response.json());
  }
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

test("cancels a running job and marks it cancelled", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = createServer({
    port: 0,
    provider: "mock",
    processJob: async (job, context) => {
      await gate;
      if (context.signal?.aborted) {
        const error = new Error("job_cancelled");
        error.name = "AbortError";
        throw error;
      }
      return { lines: [], vtt: "WEBVTT\n\n" };
    }
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload: true, filename: "cancel.wav" })
  }).then((response) => response.json());
  await fetch(`${baseUrl}/api/jobs/${created.id}/source`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: Buffer.from("x")
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cancelled = await fetch(`${baseUrl}/api/jobs/${created.id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 202);
  release();

  const job = await waitForJob(baseUrl, created.id);
  assert.equal(job.status, "cancelled");
});

test("streams partial subtitles and accepts seek prioritization", async (t) => {
  const app = createServer({
    port: 0,
    provider: "mock",
    processJob: async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      job.lines.push({ startMs: 0, endMs: 1_000, text: "你好" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { lines: job.lines, vtt: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n你好\n" };
    }
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload: true, filename: "progressive.wav" })
  }).then((response) => response.json());
  await fetch(`${baseUrl}/api/jobs/${created.id}/source`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: Buffer.from("x")
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const partial = await fetch(`${baseUrl}/api/jobs/${created.id}/partial`).then((response) => response.json());
  assert.equal(partial.lineCount, 1);
  assert.match(partial.vtt, /你好/);

  const prioritize = await fetch(`${baseUrl}/api/jobs/${created.id}/prioritize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeMs: 12_000 })
  });
  assert.equal(prioritize.status, 202);
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

test("local dashscope mode reports fully local processing", async (t) => {
  const app = createServer({ port: 0, provider: "dashscope", apiKey: "test-key", localAsr: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.provider, "dashscope");
  assert.equal(health.mode, "local");
  assert.equal(health.localProcessing, true);
});

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
    if (job.status === "ready" || job.status === "error" || job.status === "cancelled") return job;
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
