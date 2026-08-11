import test from "node:test";
import assert from "node:assert/strict";
import { translateLines } from "../src/server/translate.js";

test("translates lines in order across batched requests", async () => {
  const calls = [];
  const lines = await translateLines({
    lines: [
      { startMs: 0, endMs: 1_000, text: "Hello world" },
      { startMs: 1_000, endMs: 2_000, text: "How are you" },
      { startMs: 2_000, endMs: 3_000, text: "See you later" }
    ],
    apiKey: "test-key",
    batchSize: 2,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.input.messages[0].content);
      const numbered = body.input.messages[0].content.match(/\d+\. [^\n]+/g) || [];
      const content = numbered.map((line) => `${line.split(".")[0]}. 译:${line.split(". ")[1]}`).join("\n");
      return { ok: true, json: async () => ({ output: { choices: [{ message: { content } }] } }) };
    }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(lines.map((line) => line.translated), ["译:Hello world", "译:How are you", "译:See you later"]);
});

test("returns lines unchanged when translation is not configured", async () => {
  const input = [{ startMs: 0, endMs: 1_000, text: "Hello" }];
  const lines = await translateLines({ lines: input, apiKey: "" });
  assert.equal(lines, input);
  assert.equal(lines[0].translated, undefined);
});

test("falls back to ordered parsing when numbering is missing", async () => {
  const lines = await translateLines({
    lines: [
      { startMs: 0, endMs: 1_000, text: "A" },
      { startMs: 1_000, endMs: 2_000, text: "B" }
    ],
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ output: { choices: [{ message: { content: "甲\n乙" } }] } })
    })
  });
  assert.deepEqual(lines.map((line) => line.translated), ["甲", "乙"]);
});

test("retries translation on transient failures", async () => {
  let calls = 0;
  const lines = await translateLines({
    lines: [{ startMs: 0, endMs: 1_000, text: "Hello" }],
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({ message: "throttled" }) };
      return { ok: true, json: async () => ({ output: { choices: [{ message: { content: "1. 你好" } }] } }) };
    }
  });
  assert.equal(calls, 2);
  assert.equal(lines[0].translated, "你好");
});

test("keeps line alignment when some lines are empty", async () => {
  const lines = await translateLines({
    lines: [
      { startMs: 0, endMs: 1_000, text: "hello" },
      { startMs: 1_000, endMs: 2_000, text: "" },
      { startMs: 2_000, endMs: 3_000, text: "world" }
    ],
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ output: { choices: [{ message: { content: "1. 你好\n2. 世界" } }] } })
    })
  });
  assert.equal(lines[0].translated, "你好");
  assert.equal(lines[1].translated, undefined);
  assert.equal(lines[2].translated, "世界");
});
