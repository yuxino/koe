import test from "node:test";
import assert from "node:assert/strict";
import { groupWordsToSubtitles, toWebVtt } from "../src/server/transcript.js";

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

test("keeps short complete sentences on their own lines", () => {
  const result = groupWordsToSubtitles([
    { begin_time: 0, end_time: 200, text: "好", punctuation: "" },
    { begin_time: 200, end_time: 400, text: "。", punctuation: "。" },
    { begin_time: 500, end_time: 1_000, text: "我们走吧", punctuation: "" },
    { begin_time: 1_000, end_time: 1_200, text: "。", punctuation: "。" }
  ]);
  assert.deepEqual(result.map((line) => line.text), ["好。", "我们走吧。"]);
});

test("breaks overlong lines at the last comma", () => {
  const result = groupWordsToSubtitles([
    { begin_time: 0, end_time: 2_000, text: "第一", punctuation: "" },
    { begin_time: 2_000, end_time: 4_000, text: "部分", punctuation: "" },
    { begin_time: 4_000, end_time: 4_200, text: "，", punctuation: "，" },
    { begin_time: 4_200, end_time: 6_500, text: "第二", punctuation: "" },
    { begin_time: 6_500, end_time: 8_500, text: "部分", punctuation: "" },
    { begin_time: 8_500, end_time: 11_000, text: "第三", punctuation: "" }
  ]);
  assert.deepEqual(result.map((line) => line.text), ["第一部分，", "第二部分第三"]);
});

test("formats the complete transcript as WebVTT", () => {
  assert.equal(toWebVtt([{ startMs: 1_000, endMs: 2_500, text: "你好" }]), [
    "WEBVTT",
    "",
    "1",
    "00:00:01.000 --> 00:00:02.500",
    "你好",
    ""
  ].join("\n"));
});

test("formats bilingual cues with original and translated lines", () => {
  assert.equal(toWebVtt([{ startMs: 1_000, endMs: 2_500, text: "Hello world", translated: "你好世界" }]), [
    "WEBVTT",
    "",
    "1",
    "00:00:01.000 --> 00:00:03.750",
    "Hello world",
    "你好世界",
    ""
  ].join("\n"));
});

test("enforces a minimum display duration without overlapping the next cue", () => {
  const vtt = toWebVtt([
    { startMs: 1_000, endMs: 1_300, text: "嗯" },
    { startMs: 1_500, endMs: 2_000, text: "好的" }
  ]);
  assert.match(vtt, /00:00:01\.000 --> 00:00:01\.420/);
  assert.match(vtt, /00:00:01\.500 --> 00:00:02\.500/);
});
