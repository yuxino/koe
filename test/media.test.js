import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractAudioLocally, isSupportedPageUrl, normalizeToWav, validateSourceRequest } from "../src/server/media.js";

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
  assert.deepEqual(validateSourceRequest(
    { pageUrl: "http://video.example/watch", sourceUrl: "http://cdn.example/video.mp4" },
    { allowAnyPage: true }
  ), {
    pageUrl: "http://video.example/watch",
    sourceUrl: "http://cdn.example/video.mp4"
  });
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

test("extracts browser-discovered media directly with ffmpeg and referer", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "koe-media-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const calls = [];

  const outputPath = await extractAudioLocally({
    pageUrl: "https://video.example/watch/1",
    sourceUrl: "https://cdn.example/master.m3u8?signature=ok",
    outputDir,
    ffmpegBin: "ffmpeg-test",
    ytdlpBin: "yt-dlp-test",
    run: async (command, args) => { calls.push({ command, args }); }
  });

  assert.equal(outputPath, join(outputDir, "audio.m4a"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ffmpeg-test");
  assert.ok(calls[0].args.includes("https://cdn.example/master.m3u8?signature=ok"));
  assert.match(calls[0].args[calls[0].args.indexOf("-headers") + 1], /Referer: https:\/\/video\.example\/watch\/1/);
});

test("falls back to local yt-dlp when direct media extraction fails", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "koe-media-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const calls = [];

  await extractAudioLocally({
    pageUrl: "https://unknown.example/watch/1",
    sourceUrl: "https://cdn.example/expired.mp4",
    outputDir,
    ffmpegBin: "ffmpeg-test",
    ytdlpBin: "yt-dlp-test",
    run: async (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) throw new Error("signed URL expired");
      if (command === "yt-dlp-test") await writeFile(join(outputDir, "source.mp4"), "media");
    }
  });

  assert.deepEqual(calls.map((call) => call.command), ["ffmpeg-test", "yt-dlp-test", "ffmpeg-test"]);
  assert.ok(calls[1].args.includes("https://unknown.example/watch/1"));
  assert.ok(calls[2].args.includes(join(outputDir, "source.mp4")));
});
