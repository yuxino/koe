import test from "node:test";
import assert from "node:assert/strict";
import { groupWordsToSubtitles } from "../src/server/transcript.js";

test("groups words at terminal punctuation", () => {
  const result = groupWordsToSubtitles([
    { begin_time: 0, end_time: 300, text: "你好", punctuation: "" },
    { begin_time: 300, end_time: 700, text: "。", punctuation: "。" },
    { begin_time: 900, end_time: 1_300, text: "这是第二句", punctuation: "" },
    { begin_time: 1_300, end_time: 1_700, text: "！", punctuation: "！" }
  ]);

  assert.deepEqual(result, [
    { startMs: 0, endMs: 700, text: "你好。" },
    { startMs: 900, endMs: 1_700, text: "这是第二句！" }
  ]);
});

test("groups words after a long pause", () => {
  const result = groupWordsToSubtitles([
    { begin_time: 0, end_time: 500, text: "前半段", punctuation: "" },
    { begin_time: 2_200, end_time: 2_700, text: "后半段", punctuation: "" }
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[1].startMs, 2_200);
});
