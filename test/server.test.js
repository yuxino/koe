import test from "node:test";
import assert from "node:assert/strict";
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

async function waitForJob(baseUrl, id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const job = await fetch(`${baseUrl}/api/jobs/${id}`).then((response) => response.json());
    if (job.status === "ready" || job.status === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish in time");
}
