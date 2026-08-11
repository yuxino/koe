import test from "node:test";
import assert from "node:assert/strict";
import { transcribeWav } from "../src/server/asr.js";

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
