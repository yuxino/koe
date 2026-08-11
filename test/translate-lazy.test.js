import test from "node:test";
import assert from "node:assert/strict";
import { flushPendingTranslations } from "../src/server/jobs.js";

test("translates only lines within the playback horizon", async () => {
  const job = {
    translate: true,
    positionMs: 0,
    streamStartMs: 0,
    lines: [
      { startMs: 0, endMs: 2_000, text: "a" },
      { startMs: 60_000, endMs: 62_000, text: "b" },
      { startMs: 180_000, endMs: 182_000, text: "c" }
    ],
    pendingTranslation: []
  };
  job.pendingTranslation.push(...job.lines);
  const translated = [];
  const fakeTranslate = async (lines) => {
    for (const line of lines) line.translated = `zh:${line.text}`;
    translated.push(...lines.map((line) => line.startMs));
  };

  await flushPendingTranslations(job, { apiKey: "k", horizonMs: 90_000, translate: fakeTranslate });
  assert.deepEqual(translated, [0, 60_000]);
  assert.equal(job.lines[0].translated, "zh:a");
  assert.equal(job.lines[1].translated, "zh:b");
  assert.equal(job.lines[2].translated, undefined);
  assert.equal(job.pendingTranslation.length, 1);

  job.positionMs = 120_000;
  await flushPendingTranslations(job, { apiKey: "k", horizonMs: 90_000, translate: fakeTranslate });
  assert.deepEqual(translated, [0, 60_000, 180_000]);
  assert.equal(job.lines[2].translated, "zh:c");
  assert.equal(job.pendingTranslation.length, 0);
});

test("does nothing when translation is disabled", async () => {
  const job = {
    translate: false,
    positionMs: 0,
    streamStartMs: 0,
    lines: [{ startMs: 0, endMs: 1_000, text: "a" }],
    pendingTranslation: [{ startMs: 0, endMs: 1_000, text: "a" }]
  };
  await flushPendingTranslations(job, {
    apiKey: "k",
    translate: async () => { throw new Error("should not run"); }
  });
  assert.equal(job.lines[0].translated, undefined);
});
