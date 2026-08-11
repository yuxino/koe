import test from "node:test";
import assert from "node:assert/strict";
import { transcribeCompleteWav, transcribeWav } from "../src/server/asr.js";

test("maps Fun-ASR word timestamps back onto the tab timeline", async () => {
  const lines = await transcribeWav({
    audio: Buffer.from("RIFF-test"),
    startMs: 10_000,
    endMs: 14_000,
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        output: {
          output: {
            sentence: {
              words: [
                { begin_time: 200, end_time: 600, text: "你好", punctuation: "" },
                { begin_time: 600, end_time: 1_000, text: "。", punctuation: "。" }
              ]
            }
          }
        }
      })
    })
  });

  assert.deepEqual(lines, [{
    startMs: 10_200,
    endMs: 11_000,
    text: "你好。",
    provider: "dashscope"
  }]);
});

test("retries rate-limited ASR requests with backoff", async () => {
  let calls = 0;
  const lines = await transcribeWav({
    audio: Buffer.from("RIFF-test"),
    startMs: 0,
    endMs: 1_000,
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({ message: "throttled" }) };
      return {
        ok: true,
        json: async () => ({
          output: {
            output: {
              sentence: {
                words: [{ begin_time: 0, end_time: 200, text: "好", punctuation: "" }]
              }
            }
          }
        })
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "好");
});

test("transcribes a complete PCM WAV in internal segments while keeping absolute offsets", async () => {
  const audio = createWav(16_000 * 2);
  const starts = [];
  const lines = await transcribeCompleteWav({
    audio,
    apiKey: "test-key",
    segmentMs: 1_000,
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const data = Buffer.from(payload.input.messages[0].content[0].input_audio.data.split(",")[1], "base64");
      starts.push(data.length);
      return {
        ok: true,
        json: async () => ({ output: { output: { sentence: { words: [{ begin_time: 0, end_time: 200, text: "字", punctuation: "" }] } } } })
      };
    }
  });
  assert.equal(starts.length, 2);
  assert.deepEqual(lines.map((line) => line.startMs), [0, 1_000]);
});

test("transcribes segments concurrently while keeping timeline order", async () => {
  const audio = createWav(16_000 * 4);
  let inFlight = 0;
  let maxInFlight = 0;
  const lines = await transcribeCompleteWav({
    audio,
    apiKey: "test-key",
    segmentMs: 1_000,
    concurrency: 3,
    fetchImpl: async (_url, options) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const payload = JSON.parse(options.body);
      const data = Buffer.from(payload.input.messages[0].content[0].input_audio.data.split(",")[1], "base64");
      return {
        ok: true,
        json: async () => ({ output: { output: { sentence: { words: [{ begin_time: 0, end_time: 100, text: "字", punctuation: "" }] } } } })
      };
    }
  });
  assert.ok(maxInFlight >= 2, `expected parallel segments, saw at most ${maxInFlight} in flight`);
  assert.deepEqual(lines.map((line) => line.startMs), [0, 1_000, 2_000, 3_000]);
});

test("transcribes only provided speech ranges with absolute offsets", async () => {
  const audio = createWav(16_000 * 10);
  const calls = [];
  const lines = await transcribeCompleteWav({
    audio,
    apiKey: "test-key",
    segmentMs: 5_000,
    speechRangesMs: [[1_000, 4_000], [7_000, 9_000]],
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const data = Buffer.from(payload.input.messages[0].content[0].input_audio.data.split(",")[1], "base64");
      calls.push(data.length);
      return {
        ok: true,
        json: async () => ({ output: { output: { sentence: { words: [{ begin_time: 0, end_time: 100, text: "字", punctuation: "" }] } } } })
      };
    }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(lines.map((line) => line.startMs), [1_000, 7_000]);
});

test("reports segment progress detail", async () => {
  const audio = createWav(16_000 * 3);
  const details = [];
  await transcribeCompleteWav({
    audio,
    apiKey: "test-key",
    segmentMs: 1_000,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ output: { output: { sentence: { words: [{ begin_time: 0, end_time: 100, text: "字", punctuation: "" }] } } } })
    }),
    onProgress: (_value, detail) => details.push(detail)
  });
  assert.deepEqual(details, ["第 1/3 段", "第 2/3 段", "第 3/3 段"]);
});

test("splits long speech ranges into capped chunks", async () => {
  const audio = createWav(16_000 * 20);
  let calls = 0;
  const lines = await transcribeCompleteWav({
    audio,
    apiKey: "test-key",
    segmentMs: 5_000,
    speechRangesMs: [[0, 12_000]],
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ output: { output: { sentence: { words: [{ begin_time: 0, end_time: 100, text: "字", punctuation: "" }] } } } })
      };
    }
  });
  assert.equal(calls, 3);
  assert.deepEqual(lines.map((line) => line.startMs), [0, 5_000, 10_000]);
});

test("merges a tiny tail into the previous speech chunk", async () => {
  const audio = createWav(16_000 * 20);
  let calls = 0;
  await transcribeCompleteWav({
    audio,
    apiKey: "test-key",
    segmentMs: 5_000,
    speechRangesMs: [[0, 5_400]],
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ output: { output: { sentence: { words: [{ begin_time: 0, end_time: 100, text: "字", punctuation: "" }] } } } })
      };
    }
  });
  assert.equal(calls, 1);
});

function createWav(sampleCount) {
  const data = Buffer.alloc(sampleCount * 2);
  const wav = Buffer.alloc(44 + data.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write("WAVEfmt ", 8, "ascii");
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
