import test from "node:test";
import assert from "node:assert/strict";
import { isSupportedPageUrl, normalizeToWav, validateSourceRequest } from "../src/server/media.js";

test("recognizes supported adult video page hosts", () => {
  assert.equal(isSupportedPageUrl("https://www.pornhub.com/view_video.php?viewkey=abc"), true);
  assert.equal(isSupportedPageUrl("https://xvideos.com/video-123"), true);
  assert.equal(isSupportedPageUrl("https://example.com/video"), false);
});

test("validates public source URLs and blocks private hosts", () => {
  assert.deepEqual(validateSourceRequest({ sourceUrl: "https://cdn.example.com/video.mp4" }), {
    pageUrl: "",
    sourceUrl: "https://cdn.example.com/video.mp4"
  });
  assert.throws(() => validateSourceRequest({ sourceUrl: "http://127.0.0.1/video.mp4" }), /https_required|private_host/);
  assert.throws(() => validateSourceRequest({ pageUrl: "https://example.com/video" }), /unsupported_page_source/);
});

test("builds an ffmpeg normalization command without a shell", async () => {
  let captured;
  await normalizeToWav({
    inputPath: "/tmp/input video.mp4",
    outputPath: "/tmp/output.wav",
    ffmpegBin: "ffmpeg-test",
    run: async (command, args) => { captured = { command, args }; }
  });
  assert.equal(captured.command, "ffmpeg-test");
  assert.deepEqual(captured.args.slice(-7, -1), ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]);
  assert.equal(captured.args.at(-1), "/tmp/output.wav");
});
