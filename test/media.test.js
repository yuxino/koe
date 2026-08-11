import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSpeechRanges, extractAudioLocally, isSupportedPageUrl, normalizeToAac, normalizeToWav, validateSourceRequest } from "../src/server/media.js";

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

test("detects speech ranges from ffmpeg silence output", async () => {
  const fakeRun = async () => ({
    stdout: "",
    stderr: [
      "  Duration: 00:00:10.00, start: 0.000000, bitrate: 256 kb/s",
      "[silencedetect @ 0x0] silence_start: 2.5",
      "[silencedetect @ 0x0] silence_end: 4.5",
      "[silencedetect @ 0x0] silence_start: 8",
      "size=N/A time=00:00:10.00"
    ].join("\n")
  });
  const ranges = await detectSpeechRanges({ inputPath: "sample.wav", run: fakeRun });
  assert.deepEqual(ranges, [[0, 2.7], [4.3, 8.2]]);
});

test("returns no speech ranges for a fully silent file", async () => {
  const fakeRun = async () => ({
    stdout: "",
    stderr: [
      "  Duration: 00:00:05.00, start: 0.000000",
      "[silencedetect @ 0x0] silence_start: 0",
      "[silencedetect @ 0x0] silence_end: 5"
    ].join("\n")
  });
  const ranges = await detectSpeechRanges({ inputPath: "silent.wav", run: fakeRun });
  assert.deepEqual(ranges, []);
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

test("reports ffmpeg extraction progress from out_time", async () => {
  const progress = [];
  await normalizeToAac({
    input: "https://cdn.example/video.mp4",
    outputPath: "/tmp/audio.m4a",
    pageUrl: "https://video.example/watch/1",
    ffmpegBin: "ffmpeg-test",
    durationMs: 10_000,
    onProgress: (value) => progress.push(value),
    run: async (command, args, options = {}) => {
      options.onStdout?.("out_time_ms=1000\nprogress=continue\n");
      options.onStdout?.("out_time_ms=5000\nprogress=continue\n");
    }
  });
  assert.ok(progress.includes(0.1), `expected 0.1 in ${JSON.stringify(progress)}`);
  assert.ok(progress.includes(0.5), `expected 0.5 in ${JSON.stringify(progress)}`);
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
    fetchImpl: async () => ({
      ok: true,
      text: async () => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nvideo.m3u8"
    }),
    run: async (command, args) => { calls.push({ command, args }); }
  });

  assert.equal(outputPath, join(outputDir, "audio.m4a"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ffmpeg-test");
  assert.ok(calls[0].args.includes("https://cdn.example/master.m3u8?signature=ok"));
  assert.match(calls[0].args[calls[0].args.indexOf("-headers") + 1], /Referer: https:\/\/video\.example\/watch\/1/);
});

test("prefers the audio-only HLS variant when available", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "koe-media-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const inputs = [];

  const outputPath = await extractAudioLocally({
    pageUrl: "https://video.example/watch/1",
    sourceUrl: "https://cdn.example/hls/master.m3u8",
    outputDir,
    ffmpegBin: "ffmpeg-test",
    ytdlpBin: "yt-dlp-test",
    fetchImpl: async () => ({
      ok: true,
      text: async () => [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio/eng.m3u8"',
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS=\"avc1\"",
        "video-800k.m3u8"
      ].join("\n")
    }),
    run: async (command, args) => {
      const index = args.indexOf("-i");
      inputs.push(args[index + 1]);
    }
  });

  assert.equal(outputPath, join(outputDir, "audio.m4a"));
  assert.deepEqual(inputs, ["https://cdn.example/hls/audio/eng.m3u8"]);
});

test("passes non-HLS media URLs straight to ffmpeg", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "koe-media-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const inputs = [];

  await extractAudioLocally({
    pageUrl: "https://video.example/watch/1",
    sourceUrl: "https://cdn.example/media.mp4?token=1",
    outputDir,
    ffmpegBin: "ffmpeg-test",
    ytdlpBin: "yt-dlp-test",
    fetchImpl: async () => { throw new Error("should not fetch"); },
    run: async (command, args) => {
      const index = args.indexOf("-i");
      inputs.push(args[index + 1]);
    }
  });

  assert.deepEqual(inputs, ["https://cdn.example/media.mp4?token=1"]);
});

test("falls back to local yt-dlp when direct media extraction fails", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "koe-media-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const calls = [];
  const progress = [];

  await extractAudioLocally({
    pageUrl: "https://unknown.example/watch/1",
    sourceUrl: "https://cdn.example/expired.mp4",
    outputDir,
    ffmpegBin: "ffmpeg-test",
    ytdlpBin: "yt-dlp-test",
    onProgress: (value) => progress.push(value),
    run: async (command, args, options = {}) => {
      calls.push({ command, args });
      if (calls.length === 1) throw new Error("signed URL expired");
      if (command === "yt-dlp-test") {
        options.onStdout?.("download: 42.5%\n");
        await writeFile(join(outputDir, "source.mp4"), "media");
      }
    }
  });

  assert.deepEqual(calls.map((call) => call.command), ["ffmpeg-test", "yt-dlp-test", "ffmpeg-test"]);
  assert.ok(calls[1].args.includes("https://unknown.example/watch/1"));
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf("-f"), calls[1].args.indexOf("-f") + 2), ["-f", "bestaudio/worst"]);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf("--concurrent-fragments"), calls[1].args.indexOf("--concurrent-fragments") + 2), ["--concurrent-fragments", "8"]);
  assert.deepEqual(progress, [0.34]);
  assert.ok(calls[2].args.includes(join(outputDir, "source.mp4")));
});
