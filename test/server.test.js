import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server/index.js";

test("health reports capture state and api configuration", async (t) => {
  const app = createServer({ port: 0, apiKey: "test-key" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const port = app.server.address().port;

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.service, "koe");
  assert.equal(health.apiConfigured, true);
  assert.equal(health.localProcessing, true);
  assert.equal(typeof health.activeCaptures, "number");
});

test("root lists only the realtime endpoints", async (t) => {
  const app = createServer({ port: 0, apiKey: "test-key" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const port = app.server.address().port;

  const body = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.json());
  assert.equal(body.mode, "realtime");
  assert.equal(body.capture, "/api/capture/ws");
  assert.equal(body.jobs, undefined);
});

test("unknown routes return 404", async (t) => {
  const app = createServer({ port: 0, apiKey: "test-key" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const port = app.server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/jobs`);
  assert.equal(response.status, 404);
});

test("rejects requests from unknown web origins", async (t) => {
  const app = createServer({ port: 0, apiKey: "test-key" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const port = app.server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { origin: "https://evil.example" }
  });
  assert.equal(response.status, 403);
});

test("accepts trace messages", async (t) => {
  const app = createServer({ port: 0, apiKey: "test-key" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const port = app.server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/trace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: 1, event: "test" })
  });
  assert.equal(response.status, 202);
});
