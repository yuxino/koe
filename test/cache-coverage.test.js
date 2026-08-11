import test from "node:test";
import assert from "node:assert/strict";
import { coversWholeVideo } from "../src/server/jobs.js";

test("marks gap-free coverage that reaches near the end as complete", () => {
  const lines = [
    { startMs: 0, endMs: 5_000, text: "a" },
    { startMs: 8_000, endMs: 90_000, text: "b" },
    { startMs: 92_000, endMs: 295_000, text: "c" }
  ];
  assert.equal(coversWholeVideo(lines, 300_000), true);
});

test("keeps coverage with a long gap incomplete", () => {
  const lines = [
    { startMs: 0, endMs: 60_000, text: "a" },
    { startMs: 200_000, endMs: 295_000, text: "b" }
  ];
  assert.equal(coversWholeVideo(lines, 300_000), false);
});

test("tolerates silent stretches up to the configured gap", () => {
  const lines = [
    { startMs: 0, endMs: 10_000, text: "a" },
    { startMs: 70_000, endMs: 200_000, text: "b" },
    { startMs: 240_000, endMs: 285_000, text: "c" }
  ];
  assert.equal(coversWholeVideo(lines, 300_000), true);
});

test("keeps coverage missing the ending incomplete", () => {
  const lines = [{ startMs: 0, endMs: 200_000, text: "a" }];
  assert.equal(coversWholeVideo(lines, 300_000), false);
});

test("requires a known duration and non-empty lines", () => {
  assert.equal(coversWholeVideo([{ startMs: 0, endMs: 1_000, text: "a" }], 0), false);
  assert.equal(coversWholeVideo([], 300_000), false);
});
