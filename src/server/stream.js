import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { transcribeCompleteWav } from "./asr.js";
import { detectSpeechRanges, MEDIA_USER_AGENT } from "./media.js";

const CHUNK_SECONDS = 60;

export async function streamExtractAndTranscribe({
  pageUrl,
  sourceUrl,
  directory,
  ffmpegBin,
  ytdlpBin,
  apiKey,
  asrAcquire,
  onLines,
  onProgress
}) {
  const segDir = join(directory, "segments");
  await mkdir(segDir, { recursive: true });

  const { closePromise } = startPipeline({ pageUrl, sourceUrl, segDir, ffmpegBin, ytdlpBin });
  const processed = new Set();
  let offsetMs = 0;
  let chunkCount = 0;
  let closed = false;
  void closePromise.then(() => { closed = true; });

  while (true) {
    const ready = await collectReadySegments(segDir, closed);
    for (const { index, path } of ready) {
      if (processed.has(index)) continue;
      processed.add(index);
      chunkCount += 1;
      try {
        const audio = await readFile(path);
        let speechRangesMs = null;
        if (process.env.ASR_VAD !== "0") {
          const rangesSec = await detectSpeechRanges({ inputPath: path, ffmpegBin });
          speechRangesMs = rangesSec.map(([startSec, endSec]) => [Math.round(startSec * 1_000), Math.round(endSec * 1_000)]);
        }
        await rm(path, { force: true }).catch(() => undefined);
        const chunkMs = Math.max(1_000, Math.round((audio.length - 44) / 32));
        const lines = await transcribeCompleteWav({
          audio,
          apiKey,
          segmentMs: CHUNK_SECONDS * 1_000,
          concurrency: 2,
          speechRangesMs,
          acquire: asrAcquire
        });
        const offsetLines = lines.map((line) => ({
          ...line,
          startMs: line.startMs + offsetMs,
          endMs: line.endMs + offsetMs
        }));
        onLines(offsetLines);
        offsetMs += chunkMs;
        onProgress(Math.min(1, chunkCount * 0.05));
        console.log(`[koe] stream chunk ${index} done (${offsetLines.length} lines)`);
      } catch (error) {
        console.log(`[koe] stream chunk ${index} skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (closed) break;
    await delay(400);
  }
  return { chunks: chunkCount };
}

function startPipeline({ pageUrl, sourceUrl, segDir, ffmpegBin, ytdlpBin }) {
  const segmentArgs = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    "-segment_format",
    "wav",
    join(segDir, "seg_%05d.wav")
  ];
  const children = [];
  const useYtDlp = Boolean(pageUrl) && pageUrl !== sourceUrl && Boolean(ytdlpBin);
  if (useYtDlp) {
    const yt = spawn(ytdlpBin, [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--no-color",
      "--no-part",
      "-f",
      "bestaudio/worst",
      "-o",
      "-",
      pageUrl
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const ff = spawn(ffmpegBin, ["-i", "pipe:0", ...segmentArgs], { stdio: ["pipe", "ignore", "ignore"] });
    yt.stdout.pipe(ff.stdin);
    yt.stderr.on("data", () => undefined);
    children.push(yt, ff);
  } else {
    const headers = pageUrl
      ? ["-headers", `Referer: ${pageUrl}\r\nUser-Agent: ${MEDIA_USER_AGENT}\r\n`]
      : [];
    const ff = spawn(ffmpegBin, [...headers, "-i", sourceUrl, ...segmentArgs], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(ff);
  }
  const closePromise = Promise.all(children.map((child) => new Promise((resolve) => child.on("close", resolve))));
  return { closePromise };
}

async function collectReadySegments(segDir, closed) {
  const files = (await readdir(segDir)).filter((name) => /^seg_\d+\.wav$/.test(name));
  if (!files.length) return [];
  const maxIndex = Math.max(...files.map((name) => Number(name.match(/\d+/)[0])));
  const ready = [];
  for (const name of files) {
    const index = Number(name.match(/\d+/)[0]);
    if (closed || index < maxIndex) ready.push({ index, path: join(segDir, name) });
  }
  return ready;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
