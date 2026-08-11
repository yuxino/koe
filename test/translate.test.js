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
