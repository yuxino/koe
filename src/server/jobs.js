import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { detectSpeechRanges, extractAudioLocally, normalizeToAac, normalizeToWav, validateSourceRequest } from "./media.js";
import { transcribeCompleteWav } from "./asr.js";
import { relayAudioToKoe } from "./relay.js";
import { toWebVtt } from "./transcript.js";
import { translateLines } from "./translate.js";
import { createSemaphore } from "./semaphore.js";

export function createJobManager(options = {}) {
  const jobs = new Map();
  const provider = options.provider || "mock";
  const processJob = options.processJob || ((job, context) => processDefaultJob(job, context));
  const asrSemaphore = createSemaphore(options.asrMaxConcurrent ?? process.env.ASR_MAX_CONCURRENT ?? 16);
  const extractSemaphore = createSemaphore(options.localExtractConcurrency ?? process.env.LOCAL_EXTRACT_CONCURRENCY ?? 4);
  let activeCount = 0;

  async function createJob(input = {}) {
    const source = input.upload
      ? { pageUrl: String(input.pageUrl || ""), sourceUrl: "" }
      : validateSourceRequest(input, { allowAnyPage: Boolean(options.allowAnyPage) });
    const id = randomUUID();
    const directory = await mkdtemp(join(options.tempRoot || tmpdir(), "koe-job-"));
    const job = {
      id,
      status: "queued",
      pageUrl: source.pageUrl,
      sourceUrl: source.sourceUrl,
      filename: String(input.filename || "video"),
      durationMs: Number(input.durationMs) || null,
      hasDuration: Boolean(Number(input.durationMs)),
      translate: input.translate !== undefined ? Boolean(input.translate) : process.env.KOE_TRANSLATE !== "0",
      provider,
      directory,
      sourcePath: null,
      vtt: "",
      lines: [],
      progress: 0,
      stageDetail: "",
      error: "",
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      running: false
    };
    jobs.set(id, job);
    if (source.sourceUrl || source.pageUrl) void run(job);
    return publicJob(job);
  }

  async function attachSource(id, body, filename = "video") {
    const job = getJobOrThrow(id);
    if (job.running || job.status !== "queued") throw new Error("job_already_started");
    if (!body?.length) throw new Error("video_file_empty");
    job.filename = String(filename || job.filename);
    job.sourcePath = join(job.directory, safeFilename(job.filename));
    await writeFile(job.sourcePath, body, { flag: "wx" });
    void run(job);
    return publicJob(job);
  }

  async function attachSourceStream(id, stream, filename = "video", maxBytes = 512 * 1024 * 1024) {
    const job = getJobOrThrow(id);
    if (job.running || job.status !== "queued") throw new Error("job_already_started");
    job.filename = String(filename || job.filename);
    job.sourcePath = join(job.directory, safeFilename(job.filename));
    let total = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        total += chunk.length;
        if (total > maxBytes) callback(new Error(`request body exceeds ${maxBytes} bytes`));
        else callback(null, chunk);
      }
    });
    try {
      await pipeline(stream, limiter, createWriteStream(job.sourcePath, { flags: "wx" }));
    } catch (error) {
      await rm(job.sourcePath, { force: true }).catch(() => undefined);
      throw error;
    }
    if (!total) throw new Error("video_file_empty");
    void run(job);
    return publicJob(job);
  }

  function get(id) {
    return jobs.has(id) ? publicJob(jobs.get(id)) : null;
  }

  function getVtt(id) {
    const job = getJobOrThrow(id);
    if (job.status !== "ready") throw new Error("job_not_ready");
    return job.vtt;
  }

  async function run(job) {
    if (job.running) return;
    job.running = true;
    activeCount += 1;
    job.startedAt = Date.now();
    let lastStatus = "";
    console.log(`[koe] job ${job.id.slice(0, 8)} started (${job.filename}, ${provider})`);
    try {
      const result = await processJob(job, {
        provider,
        apiKey: options.apiKey || process.env.DASHSCOPE_API_KEY || "",
        ffmpegBin: options.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg",
        ytdlpBin: options.ytdlpBin ?? (process.env.YTDLP_BIN !== undefined ? process.env.YTDLP_BIN : "yt-dlp"),
        remoteUrl: options.remoteUrl || process.env.KOE_REMOTE_URL || "",
        remoteToken: options.remoteToken || process.env.KOE_REMOTE_TOKEN || "",
        asrAcquire: () => asrSemaphore.acquire(),
        extractAcquire: () => extractSemaphore.acquire(),
        updateProgress: (status, progress, detail = "") => {
          if (status !== lastStatus) {
            console.log(`[koe] job ${job.id.slice(0, 8)} -> ${status} at +${((Date.now() - job.startedAt) / 1_000).toFixed(1)}s`);
            lastStatus = status;
          }
          job.status = status;
          job.progress = Math.max(0, Math.min(1, progress));
          job.stageDetail = String(detail || "");
        }
      });
      job.lines = result.lines || [];
      job.vtt = result.vtt || toWebVtt(job.lines);
      job.status = "ready";
      job.progress = 1;
      job.completedAt = Date.now();
      console.log(`[koe] job ${job.id.slice(0, 8)} ready in ${((job.completedAt - job.startedAt) / 1_000).toFixed(1)}s (${job.lines.length} lines)`);
    } catch (error) {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = Date.now();
      console.log(`[koe] job ${job.id.slice(0, 8)} error in ${((job.completedAt - job.startedAt) / 1_000).toFixed(1)}s: ${job.error}`);
    } finally {
      job.running = false;
      activeCount = Math.max(0, activeCount - 1);
      if (job.directory) await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function getJobOrThrow(id) {
    const job = jobs.get(String(id));
    if (!job) throw new Error("job_not_found");
    return job;
  }

  return { createJob, attachSource, attachSourceStream, get, getVtt, jobs, get activeCount() { return activeCount; } };
}

async function processDefaultJob(job, { provider, apiKey, ffmpegBin, ytdlpBin, remoteUrl, remoteToken, asrAcquire, extractAcquire, updateProgress }) {
  if (provider === "mock") {
    updateProgress("analyzing", 0.75, "模拟识别");
    const lines = [{ startMs: 0, endMs: 3_000, text: `演示字幕 · ${job.filename}`, provider: "mock" }];
    return { lines, vtt: toWebVtt(lines) };
  }

  if (provider === "relay") {
    updateProgress("downloading", 0.08, "准备下载/提取声音");
    let audioPath;
    if (job.sourcePath) {
      audioPath = join(job.directory, "audio.m4a");
      await normalizeToAac({ input: job.sourcePath, outputPath: audioPath, ffmpegBin });
      updateProgress("downloading", 0.3, "处理上传的音频");
    } else {
      audioPath = await withSemaphore(extractAcquire, () => extractAudioLocally({
        pageUrl: job.pageUrl,
        sourceUrl: job.sourceUrl,
        outputDir: job.directory,
        ffmpegBin,
        ytdlpBin,
        durationMs: job.durationMs,
        onProgress: (value) => updateProgress("downloading", 0.08 + Number(value || 0) * 0.22, "正在下载/提取声音")
      }));
    }
    updateProgress("uploading_audio", 0.32, "正在上传音频到识别服务");
    const result = await relayAudioToKoe({
      audioPath,
      remoteUrl,
      remoteToken,
      translate: job.translate,
      onProgress: (value, detail) => updateProgress("analyzing", 0.32 + Number(value || 0) * 0.64, detail || "整段识别中")
    });
    return { lines: [], vtt: result.vtt };
  }

  updateProgress("downloading", 0.08, "正在下载/提取声音");
  let audioPath;
  if (job.sourcePath) {
    audioPath = join(job.directory, "audio.m4a");
    await normalizeToAac({ input: job.sourcePath, outputPath: audioPath, ffmpegBin });
    updateProgress("downloading", 0.3, "处理上传的音频");
  } else {
    audioPath = await withSemaphore(extractAcquire, () => extractAudioLocally({
      pageUrl: job.pageUrl,
      sourceUrl: job.sourceUrl,
      outputDir: job.directory,
      ffmpegBin,
      ytdlpBin,
      durationMs: job.durationMs,
      onProgress: (value) => updateProgress("downloading", 0.08 + Number(value || 0) * 0.22, "正在下载/提取声音")
    }));
  }
  updateProgress("analyzing", 0.35, "正在转换音频");
  const wavPath = join(job.directory, "audio.wav");
  await withSemaphore(extractAcquire, () => normalizeToWav({
    inputPath: audioPath,
    outputPath: wavPath,
    ffmpegBin
  }));
  const audio = await readFile(wavPath);
  let speechRangesMs = null;
  if (process.env.ASR_VAD !== "0") {
    const rangesSec = await withSemaphore(extractAcquire, () => detectSpeechRanges({ inputPath: wavPath, ffmpegBin }));
    speechRangesMs = rangesSec.map(([startSec, endSec]) => [Math.round(startSec * 1_000), Math.round(endSec * 1_000)]);
  }
  let lines = await transcribeCompleteWav({
    audio,
    apiKey,
    baseUrl: process.env.DASHSCOPE_BASE_URL,
    model: process.env.ASR_MODEL,
    segmentMs: Number(process.env.ASR_SEGMENT_SECONDS || 60) * 1_000,
    concurrency: Number(process.env.ASR_CONCURRENCY || 16),
    speechRangesMs,
    acquire: asrAcquire,
    onProgress: (value, detail) => updateProgress("analyzing", 0.35 + value * 0.6, detail || "整段识别中")
  });
  if (job.translate) {
    updateProgress("analyzing", 0.98, "正在翻译字幕");
    try {
      lines = await translateLines({
        lines,
        apiKey,
        model: process.env.KOE_TRANSLATE_MODEL,
        target: process.env.KOE_TRANSLATE_TARGET || "zh",
        concurrency: Number(process.env.KOE_TRANSLATE_CONCURRENCY || 4)
      });
    } catch (error) {
      console.log(`[koe] job ${job.id.slice(0, 8)} translation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { lines, vtt: toWebVtt(lines) };
}

async function withSemaphore(acquire, task) {
  if (!acquire) return task();
  const release = await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    pageUrl: job.pageUrl,
    filename: job.filename,
    durationMs: job.durationMs,
    hasDuration: Boolean(job.hasDuration),
    provider: job.provider,
    progress: job.progress,
    stageDetail: job.stageDetail || "",
    error: job.error || undefined,
    lineCount: job.lines.length,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt
  };
}

function safeFilename(value) {
  const cleaned = String(value || "video").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "video";
}
