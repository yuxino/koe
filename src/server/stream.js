import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { transcribeWav } from "./asr.js";
import { MEDIA_USER_AGENT } from "./media.js";

const CHUNK_SECONDS = Math.max(10, Number(process.env.KOE_STREAM_CHUNK_SECONDS || 30));

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

  const { closePromise, diagnostics } = startPipeline({ pageUrl, sourceUrl, segDir, ffmpegBin, ytdlpBin });
  const processed = new Set();
  let offsetMs = 0;
  let chunkCount = 0;
  const failures = [];
  let closed = false;
  void closePromise.then(() => { closed = true; });

  while (true) {
    const ready = await collectReadySegments(segDir, closed);
    for (const { index, path } of ready) {
      if (processed.has(index)) continue;
      processed.add(index);
      chunkCount += 1;
      let audio;
      try {
        audio = await readFile(path);
      } catch {
        continue;
      }
      await rm(path, { force: true }).catch(() => undefined);
      const chunkMs = Math.max(1_000, Math.round((audio.length - 44) / 32));
      const chunkStartMs = offsetMs;
      offsetMs += chunkMs;
      try {
        const lines = await transcribeChunk(audio, chunkMs, apiKey, asrAcquire);
        onLines(lines.map((line) => ({
          ...line,
          startMs: line.startMs + chunkStartMs,
          endMs: line.endMs + chunkStartMs
        })));
        onProgress(Math.min(1, chunkCount * 0.05));
        console.log(`[koe] stream chunk ${index} done`);
      } catch (error) {
        console.log(`[koe] stream chunk ${index} failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
        failures.push({ index, audio, chunkStartMs });
      }
    }
    if (closed) break;
    await delay(400);
  }
  const failed = diagnostics.filter((entry) => entry.code !== 0);
  if (failed.length) {
    throw new Error(`stream pipeline failed (${failed.map((entry) => `${entry.command} exit ${entry.code}`).join(", ")})`);
  }
  if (chunkCount === 0) throw new Error("stream pipeline produced no audio");
  for (const failure of failures) {
    try {
      const lines = await transcribeChunk(failure.audio, chunkMsOf(failure.audio), apiKey, asrAcquire);
      onLines(lines.map((line) => ({
        ...line,
        startMs: line.startMs + failure.chunkStartMs,
        endMs: line.endMs + failure.chunkStartMs
      })));
      console.log(`[koe] stream chunk ${failure.index} recovered`);
    } catch (error) {
      throw new Error(`stream chunk ${failure.index} failed after retry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { chunks: chunkCount };
}

async function transcribeChunk(audio, chunkMs, apiKey, asrAcquire) {
  const run = () => transcribeWav({ audio, startMs: 0, endMs: chunkMs, apiKey });
  if (!asrAcquire) return run();
  const release = await asrAcquire();
  try {
    return await run();
  } finally {
    release();
  }
}

function chunkMsOf(audio) {
  return Math.max(1_000, Math.round((audio.length - 44) / 32));
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
  const diagnostics = [];
  for (const child of children) {
    child.on("close", (code) => {
      diagnostics.push({ command: String(child.spawnargs?.[0] || "child").split("/").pop(), code });
    });
  }
  return { closePromise, diagnostics };
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
