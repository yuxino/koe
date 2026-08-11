import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createRealtimeAsr } from "../src/server/realtime.js";

test("streams PCM frames and returns final sentences from a realtime ASR server", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const received = [];

  server.on("connection", (socket) => {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        received.push(Buffer.from(raw));
        return;
      }
      const message = JSON.parse(String(raw));
      if (message.header.action === "run-task") {
        assert.equal(message.payload.model, "test-asr-model");
        assert.equal(message.payload.parameters.sample_rate, 16_000);
        socket.send(JSON.stringify({
          header: { task_id: message.header.task_id, event: "task-started", attributes: {} },
          payload: {}
        }));
        return;
      }
      if (message.header.action === "finish-task") {
        socket.send(JSON.stringify({
          header: { task_id: message.header.task_id, event: "result-generated", attributes: {} },
          payload: {
            output: {
              sentence: {
                begin_time: 100,
                end_time: 700,
                text: "你好世界",
                sentence_end: true,
                sentence_id: 1,
                words: [
                  { begin_time: 100, end_time: 300, text: "你好", punctuation: "" },
                  { begin_time: 300, end_time: 700, text: "世界", punctuation: "" }
                ]
              }
            }
          }
        }));
        socket.send(JSON.stringify({
          header: { task_id: message.header.task_id, event: "task-finished", attributes: {} },
          payload: { output: {}, usage: { duration: 2 } }
        }));
      }
    });
  });

  const asr = createRealtimeAsr({
    apiKey: "test-key",
    model: "test-asr-model",
    wsUrl: `ws://127.0.0.1:${port}/`
  });
  const sentences = [];
  await asr.connect({
    onSentence: (sentence, final) => {
      if (final) sentences.push(sentence);
    }
  });
  await asr.sendFrame(Buffer.alloc(8_000));
  const result = await asr.finish();
  asr.close();

  assert.equal(received.length, 1);
  assert.equal(received[0].length, 8_000);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, "你好世界");
  assert.equal(sentences[0].sentence_end, true);
  assert.equal(result.duration, 2);
});

test("rejects when the server reports a failed task", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.header.action === "run-task") {
        socket.send(JSON.stringify({
          header: {
            task_id: message.header.task_id,
            event: "task-failed",
            error_code: "MODEL_NOT_FOUND",
            error_message: "model unavailable",
            attributes: {}
          },
          payload: {}
        }));
      }
    });
  });

  const asr = createRealtimeAsr({
    apiKey: "test-key",
    wsUrl: `ws://127.0.0.1:${port}/`
  });
  await assert.rejects(
    asr.connect({ onSentence: () => undefined }),
    /model unavailable/
  );
  asr.terminate();
});
