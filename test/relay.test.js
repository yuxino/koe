import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server/index.js";
import { relayAudioToKoe } from "../src/server/relay.js";

test("uploads only extracted audio to remote Koe and returns completed VTT", async (t) => {
  const remote = createServer({ port: 0, provider: "mock", apiToken: "remote-secret" });
  await new Promise((resolve) => remote.server.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.server.close());
  const directory = await mkdtemp(join(tmpdir(), "koe-relay-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audioPath = join(directory, "audio.m4a");
  await writeFile(audioPath, Buffer.from("audio-only"));
  const progress = [];

  const result = await relayAudioToKoe({
    audioPath,
    filename: "audio.m4a",
    remoteUrl: `http://127.0.0.1:${remote.server.address().port}`,
    remoteToken: "remote-secret",
    pollIntervalMs: 1,
    onProgress: (value) => progress.push(value)
  });

  assert.match(result.vtt, /^WEBVTT/);
  assert.match(result.vtt, /演示字幕/);
  assert.ok(progress.some((value) => value === 1));
});

test("reports a clear error for an invalid remote Koe token", async (t) => {
  const remote = createServer({ port: 0, provider: "mock", apiToken: "remote-secret" });
  await new Promise((resolve) => remote.server.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.server.close());
  const directory = await mkdtemp(join(tmpdir(), "koe-relay-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audioPath = join(directory, "audio.m4a");
  await writeFile(audioPath, Buffer.from("audio-only"));

  await assert.rejects(() => relayAudioToKoe({
    audioPath,
    remoteUrl: `http://127.0.0.1:${remote.server.address().port}`,
    remoteToken: "wrong-token",
    pollIntervalMs: 1
  }), /remote_unauthorized/);
});
