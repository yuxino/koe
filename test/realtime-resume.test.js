import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { streamRealtimeTranscribe } from "../src/server/stream.js";

const ffmpegBin = resolveFfmpeg();

test("reconnects and resumes after the realtime socket drops", { skip: !ffmpegBin && "ffmpeg not available" }, async (t) => {
  const sampleRate = 16_000;
  const seconds = 6;
  const pcm = Buffer.alloc(sampleRate * seconds * 2);
  for (let index = 0; index < pcm.length / 2; index += 1) {
    const value = Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 8_000);
    pcm.writeInt16LE(value, index * 2);
  }
  const wav = wrapWav(pcm, sampleRate);

  const http = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
    res.end(wav);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => http.close(resolve)));

  let connections = 0;
  const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => {
    for (const client of wsServer.clients) client.terminate();
    return new Promise((resolve) => wsServer.close(resolve));
  });
  await new Promise((resolve) => wsServer.once("listening", resolve));

  wsServer.on("connection", (socket) => {
    connections += 1;
    const isFirst = connections === 1;
    let binaryBytes = 0;
    console.log(`[mock] connection ${connections} opened`);
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        binaryBytes += raw.length;
        console.log(`[mock] connection ${connections} binary +${raw.length} (${binaryBytes})`);
        if (isFirst && binaryBytes > 16_000 && !socket.sentDrop) {
          socket.sentDrop = true;
          console.log(`[mock] dropping connection ${connections}`);
          socket.send(JSON.stringify({
            header: { task_id: "t", event: "result-generated", attributes: {} },
            payload: { output: { sentence: { begin_time: 0, end_time: 500, text: "first pass", sentence_end: true, sentence_id: 1, words: [] } } }
          }));
          socket.terminate();
        }
        return;
      }
      const message = JSON.parse(String(raw));
      if (message.header.action === "run-task") {
        socket.send(JSON.stringify({
          header: { task_id: message.header.task_id, event: "task-started", attributes: {} },
          payload: {}
        }));
        return;
      }
      if (message.header.action === "finish-task" && !isFirst) {
        socket.send(JSON.stringify({
          header: { task_id: message.header.task_id, event: "result-generated", attributes: {} },
          payload: { output: { sentence: { begin_time: 0, end_time: 400, text: "resumed pass", sentence_end: true, sentence_id: 2, words: [] } } }
        }));
        socket.send(JSON.stringify({
          header: { task_id: message.header.task_id, event: "task-finished", attributes: {} },
          payload: { output: {}, usage: { duration: 1 } }
        }));
      }
    });
  });

  const previousWsUrl = process.env.KOE_REALTIME_WS_URL;
  process.env.KOE_REALTIME_WS_URL = `ws://127.0.0.1:${wsServer.address().port}/`;
  t.after(() => {
    if (previousWsUrl === undefined) delete process.env.KOE_REALTIME_WS_URL;
    else process.env.KOE_REALTIME_WS_URL = previousWsUrl;
  });

  const lines = [];
  const result = await streamRealtimeTranscribe({
    pageUrl: "",
    sourceUrl: `http://127.0.0.1:${http.address().port}/audio.wav`,
    ffmpegBin,
    apiKey: "test-key",
    onLines: (segmentLines) => lines.push(...segmentLines),
    onPartial: () => undefined,
    onProgress: () => undefined,
    startMs: 0
  });

  assert.equal(result.realtime, true);
  assert.ok(connections >= 2, `expected a reconnect, saw ${connections} connections`);
  assert.ok(lines.length >= 1, "expected lines after the resume");
  assert.ok(lines.some((line) => line.text.includes("resumed pass")), "missing resumed-pass line");
  assert.ok(lines.some((line) => line.startMs >= 400), "resumed line should be offset past the drop point");
});

function wrapWav(pcm, sampleRate) {
  const buffer = Buffer.alloc(44 + pcm.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcm.length, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcm.length, 40);
  pcm.copy(buffer, 44);
  return buffer;
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
