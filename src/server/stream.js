import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transcribeWav } from "./asr.js";
import { detectSpeechRanges } from "./media.js";

const FIRST_CHUNK_MS = 5_000;
const CHUNK_MS = Math.max(10_000, Number(process.env.KOE_STREAM_CHUNK_SECONDS || 30) * 1_000);

export async function streamExtractAndTranscribe({
  pageUrl,
  sourceUrl,
  ffmpegBin,
  apiKey,
  asrAcquire,
  onLines,
  onProgress,
  startMs = 0
}) {
  if (!/^https?:/i.test(sourceUrl || "")) {
    throw new Error("页面没有可直接获取的视频地址，无法分析。");
  }
  const headers = pageUrl
    ? ["-headers", `Referer: ${pageUrl}\r\nUser-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36\r\n`]
    : [];
  const seekArgs = Number(startMs) > 0 ? ["-ss", String(Number(startMs) / 1_000)] : [];
  return runPipeline(() => spawnFfmpeg(ffmpegBin, [...headers, ...seekArgs, "-i", sourceUrl]), {
    ffmpegBin,
    apiKey,
    asrAcquire,
    onLines,
    onProgress,
    startMs
  });
}

async function runPipeline(factory, { ffmpegBin, apiKey, asrAcquire, onLines, onProgress, startMs = 0 }) {
  const startedAt = Date.now();
  const log = (message) => console.log(`[koe] stream +${((Date.now() - startedAt) / 1_000).toFixed(1)}s ${message}`);
  const { stream, closePromise, diagnostics } = factory();
  const queue = [];
  const failures = [];
  const processed = new Set();
  const workerCount = Math.max(1, Number(process.env.KOE_STREAM_WORKERS || 8));
  let offsetMs = Number(startMs) || 0;
  let chunkCount = 0;
  let collectorDone = false;

  async function collector() {
    let header = null;
    let buffer = Buffer.alloc(0);
    let index = 0;
    let bytesPerMs = 32;

    const targetMs = (segmentIndex) => (segmentIndex === 0 ? FIRST_CHUNK_MS : CHUNK_MS);

    const emit = (audio, segmentIndex) => {
      if (processed.has(segmentIndex)) return;
      processed.add(segmentIndex);
      queue.push({ index: segmentIndex, audio });
    };

    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!header) {
        if (buffer.length < 44) return;
        header = {
          sampleRate: buffer.readUInt32LE(24),
          blockAlign: buffer.readUInt16LE(32)
        };
        bytesPerMs = Math.max(1, Math.round((header.sampleRate * header.blockAlign) / 1_000));
        buffer = buffer.subarray(44);
      }
      while (buffer.length >= targetMs(index) * bytesPerMs) {
        const segmentBytes = targetMs(index) * bytesPerMs;
        const pcm = buffer.subarray(0, segmentBytes);
        buffer = buffer.subarray(segmentBytes);
        emit(wrapWav(pcm, header), index);
        index += 1;
      }
    });

    await new Promise((resolve) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", () => resolve());
    });
    if (header && buffer.length >= 500 * bytesPerMs) {
      emit(wrapWav(buffer, header), index);
    }
    collectorDone = true;
  }

  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) {
        if (collectorDone) break;
        await delay(100);
        continue;
      }
      const { index, audio } = item;
      const chunkMs = Math.max(1_000, Math.round((audio.length - 44) / 32));
      const chunkStartMs = offsetMs;
      offsetMs += chunkMs;
      chunkCount += 1;
      if (process.env.ASR_VAD !== "0" && index !== 0) {
        // 静音门：跳过整块都没声音的块；第一块不检查，尽快出字幕
        const silent = await isSilentWav(audio, ffmpegBin);
        if (silent === true) {
          log(`chunk ${index} silent, skipped`);
          onProgress(Math.min(1, chunkCount * 0.05));
          continue;
        }
      }
      try {
        const lines = await transcribeChunk(audio, chunkMs, apiKey, asrAcquire);
        onLines(lines.map((line) => ({
          ...line,
          startMs: line.startMs + chunkStartMs,
          endMs: line.endMs + chunkStartMs
        })));
        onProgress(Math.min(1, chunkCount * 0.05));
        log(`chunk ${index} done (${lines.length} lines)`);
      } catch (error) {
        log(`chunk ${index} failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
        failures.push({ index, audio, chunkStartMs });
      }
    }
  }

  await Promise.all([collector(), ...Array.from({ length: workerCount }, () => worker())]);
  const failed = diagnostics.filter((entry) => entry.code !== 0);
  if (failed.length) {
    throw new Error(`stream pipeline failed (${failed.map((entry) => `${entry.command} exit ${entry.code}`).join(", ")})`);
  }
  if (chunkCount === 0) throw new Error("stream pipeline produced no audio");
  for (const failure of failures) {
    try {
      const lines = await transcribeChunk(failure.audio, Math.max(1_000, Math.round((failure.audio.length - 44) / 32)), apiKey, asrAcquire);
      onLines(lines.map((line) => ({
        ...line,
        startMs: line.startMs + failure.chunkStartMs,
        endMs: line.endMs + failure.chunkStartMs
      })));
      log(`chunk ${failure.index} recovered`);
    } catch (error) {
      throw new Error(`stream chunk ${failure.index} failed after retry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { chunks: chunkCount };
}

function spawnFfmpeg(ffmpegBin, args) {
  const children = [];
  const diagnostics = [];
  const ff = spawn(ffmpegBin, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    ...args,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(ff);
  const closePromise = Promise.all(children.map((child) => new Promise((resolve) => {
    child.on("close", (code) => {
      diagnostics.push({ command: String(child.spawnargs?.[0] || "child").split("/").pop(), code });
      resolve();
    });
  })));
  return { stream: ff.stdout, closePromise, diagnostics };
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

async function isSilentWav(audio, ffmpegBin) {
  if (audio.length < 44) return true;
  const tempPath = `/tmp/koe-silence-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.wav`;
  try {
    await writeFile(tempPath, audio);
    const ranges = await detectSpeechRanges({ inputPath: tempPath, ffmpegBin });
    return !ranges.length;
  } catch {
    return false;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function wrapWav(pcm, header) {
  const data = Buffer.alloc(44 + pcm.length);
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(36 + pcm.length, 4);
  data.write("WAVE", 8, "ascii");
  data.write("fmt ", 12, "ascii");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(header.sampleRate, 24);
  data.writeUInt32LE(header.sampleRate * header.blockAlign, 28);
  data.writeUInt16LE(header.blockAlign, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii");
  data.writeUInt32LE(pcm.length, 40);
  pcm.copy(data, 44);
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
