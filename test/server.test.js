import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server/index.js";

test("mock server runs a full caption session", async (t) => {
  const app = createServer({ port: 0, provider: "mock" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, service: "koe", provider: "mock", authRequired: false, chunkSeconds: 15 });

  const session = await fetch(`${baseUrl}/api/session/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: 7 })
  }).then((response) => response.json());

  const result = await fetch(`${baseUrl}/api/session/${session.id}/chunk`, {
    method: "POST",
    headers: { "content-type": "audio/wav", "x-start-ms": "300", "x-end-ms": "1300" },
    body: Buffer.from("RIFF-test")
  }).then((response) => response.json());

  assert.equal(result.chunkCount, 1);
  assert.equal(result.lines[0].startMs, 300);
  assert.equal(result.lines[0].provider, "mock");
});

test("protects caption sessions when an API token is configured", async (t) => {
  const app = createServer({ port: 0, provider: "mock", apiToken: "secret-token" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${baseUrl}/api/session/start`, { method: "POST" });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/api/session/start`, {
    method: "POST",
    headers: { Authorization: "Bearer secret-token" }
  });
  assert.equal(authorized.status, 201);
});
