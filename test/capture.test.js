import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createCaptureManager } from "../src/server/capture.js";
import { createServer } from "../src/server/index.js";

test("capture ws streams pcm frames into the realtime asr and returns translated lines", async (t) => {
  const fake = createFakeAsr({ finalText: "你好世界" });
  const manager = createCaptureManager({
    apiKey: "test-key",
    asrFactory: () => fake
  });
  const { httpServer, wss, port } = await listen((ws) => manager.handleConnection(ws));
  t.after(() => { httpServer.close(); wss.close(); });

  const client = await connect(`ws://127.0.0.1:${port}/api/capture/ws`);
  t.after(() => client.close());
  client.send(JSON.stringify({ type: "start", format: "pcm", translate: false }));
  await client.waitFor((message) => message.type === "ready");

  client.send(Buffer.alloc(9_000, 1));
  const lines = await client.waitFor((message) => message.type === "lines");
  assert.equal(lines.lines.length, 1);
  assert.equal(lines.lines[0].text, "你好世界");
  assert.ok(fake.frames.length > 0);
  assert.equal(fake.frames[0].length, 3_200, "pcm 按 100ms 帧切块后发送");
});

test("capture ws attaches the translation and sends it to the client", async (t) => {
  const fake = createFakeAsr({ finalText: "Hello world" });
  const manager = createCaptureManager({
    apiKey: "test-key",
    asrFactory: () => fake,
    translate: async ({ lines }) => lines.map((line) => ({ ...line, translated: `译:${line.text}` }))
  });
  const { httpServer, wss, port } = await listen((ws) => manager.handleConnection(ws));
  t.after(() => { httpServer.close(); wss.close(); });

  const client = await connect(`ws://127.0.0.1:${port}/api/capture/ws`);
  t.after(() => client.close());
  client.send(JSON.stringify({ type: "start", format: "pcm", translate: true }));
  await client.waitFor((message) => message.type === "ready");

  client.send(Buffer.alloc(9_000, 1));
  const message = await client.waitFor((event) => event.type === "lines");
  assert.equal(message.lines[0].text, "Hello world");
  assert.equal(message.lines[0].translated, "译:Hello world");
});

test("capture ws forwards in-progress partial sentences", async (t) => {
  const fake = createFakeAsr({ partialText: "正在…" });
  const manager = createCaptureManager({
    apiKey: "test-key",
    asrFactory: () => fake
  });
  const { httpServer, wss, port } = await listen((ws) => manager.handleConnection(ws));
  t.after(() => { httpServer.close(); wss.close(); });

  const client = await connect(`ws://127.0.0.1:${port}/api/capture/ws`);
  t.after(() => client.close());
  client.send(JSON.stringify({ type: "start", format: "pcm", translate: false }));
  await client.waitFor((message) => message.type === "ready");
  client.send(Buffer.alloc(8_000, 2));
  const partial = await client.waitFor((message) => message.type === "partial");
  assert.equal(partial.lines[0].text, "正在…");
});

test("capture ws drops single-letter and symbol-only noise", async (t) => {
  const fake = createFakeAsr({ finalText: "T" });
  const manager = createCaptureManager({
    apiKey: "test-key",
    asrFactory: () => fake
  });
  const { httpServer, wss, port } = await listen((ws) => manager.handleConnection(ws));
  t.after(() => { httpServer.close(); wss.close(); });

  const client = await connect(`ws://127.0.0.1:${port}/api/capture/ws`);
  t.after(() => client.close());
  client.send(JSON.stringify({ type: "start", format: "pcm", translate: false }));
  await client.waitFor((message) => message.type === "ready");

  client.send(Buffer.alloc(9_000, 1));
  await new Promise((resolve) => setTimeout(resolve, 400));
  // 单字母噪声应被过滤，不产生字幕行
  assert.ok(fake.frames.length > 0);
  await assert.rejects(
    client.waitFor((message) => message.type === "lines", 400),
    /timeout/
  );
});

test("capture ws rejects a second session while one is active", async (t) => {
  const fake = createFakeAsr();
  const manager = createCaptureManager({
    apiKey: "test-key",
    asrFactory: () => fake
  });
  const { httpServer, wss, port } = await listen((ws) => manager.handleConnection(ws));
  t.after(() => { httpServer.close(); wss.close(); });

  const first = await connect(`ws://127.0.0.1:${port}/api/capture/ws`);
  t.after(() => first.close());
  first.send(JSON.stringify({ type: "start", format: "pcm", translate: false }));
  await first.waitFor((message) => message.type === "ready");

  const second = await connect(`ws://127.0.0.1:${port}/api/capture/ws`);
  t.after(() => second.close());
  const error = await second.waitFor((message) => message.type === "error");
  assert.equal(error.error, "capture_session_busy");
});

test("index server exposes the capture ws endpoint and reports active captures in health", async (t) => {
  const app = createServer({ port: 0, apiKey: "" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const port = app.server.address().port;

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(typeof health.activeCaptures, "number");

  const client = await connect(`ws://127.0.0.1:${port}/api/capture/ws`);
  t.after(() => client.close());
  client.send(JSON.stringify({ type: "start", format: "pcm", translate: false }));
  const error = await client.waitFor((message) => message.type === "error");
  assert.match(error.error, /DASHSCOPE_API_KEY/);
});

function createFakeAsr({ finalText = "", partialText = "" } = {}) {
  let callbacks = null;
  let emittedFinal = false;
  const frames = [];
  return {
    frames,
    async connect(cb) {
      callbacks = cb;
    },
    async sendFrame(frame) {
      frames.push(Buffer.from(frame));
      if (partialText && !emittedFinal) {
        callbacks.onSentence({ text: partialText, begin_time: 100, end_time: 900, sentence_end: false }, false);
      }
      if (finalText && frames.length >= 1 && !emittedFinal) {
        emittedFinal = true;
        callbacks.onSentence({
          text: finalText,
          begin_time: 0,
          end_time: 2_400,
          sentence_end: true
        }, true);
      }
    },
    async finish() {
      return { duration: 0 };
    },
    close() {},
    terminate() {}
  };
}

function listen(handler) {
  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => handler(ws));
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      resolve({ httpServer, wss, port: httpServer.address().port });
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const index = waiters.findIndex((entry) => entry.predicate(message));
      if (index >= 0) {
        const [entry] = waiters.splice(index, 1);
        clearTimeout(entry.timer);
        entry.resolve(message);
      } else {
        queue.push(message);
      }
    });
    ws.on("open", () => resolve({
      ws,
      send: (...args) => ws.send(...args),
      close: () => ws.close(),
      waitFor: (predicate, timeoutMs = 3_000) => new Promise((resolveWait, rejectWait) => {
        const existing = queue.findIndex(predicate);
        if (existing >= 0) {
          resolveWait(queue.splice(existing, 1)[0]);
          return;
        }
        const entry = { predicate, resolve: resolveWait };
        entry.timer = setTimeout(() => {
          const index = waiters.indexOf(entry);
          if (index >= 0) waiters.splice(index, 1);
          rejectWait(new Error("waitFor timeout"));
        }, timeoutMs);
        waiters.push(entry);
      })
    }));
    ws.on("error", reject);
  });
}
