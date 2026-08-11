import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { acquireSource, extractAudioLocally, normalizeToWav, validateSourceRequest } from "./media.js";
import { transcribeCompleteWav } from "./asr.js";
import { relayAudioToKoe } from "./relay.js";
import { toWebVtt } from "./transcript.js";

export function createJobManager(options = {}) {
  const jobs = new Map();
  const provider = options.provider || "mock";
  const processJob = options.processJob || ((job, context) => processDefaultJob(job, context));

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
      provider,
      directory,
      sourcePath: null,
      vtt: "",
      lines: [],
      progress: 0,
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
    job.startedAt = Date.now();
    try {
      const result = await processJob(job, {
        provider,
        apiKey: options.apiKey || process.env.DASHSCOPE_API_KEY || "",
        ffmpegBin: options.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg",
        ytdlpBin: options.ytdlpBin || process.env.YTDLP_BIN || "yt-dlp",
        remoteUrl: options.remoteUrl || process.env.KOE_REMOTE_URL || "",
        remoteToken: options.remoteToken || process.env.KOE_REMOTE_TOKEN || "",
        updateProgress: (status, progress) => {
          job.status = status;
          job.progress = Math.max(0, Math.min(1, progress));
        }
      });
      job.lines = result.lines || [];
      job.vtt = result.vtt || toWebVtt(job.lines);
      job.status = "ready";
      job.progress = 1;
      job.completedAt = Date.now();
    } catch (error) {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = Date.now();
    } finally {
      job.running = false;
      if (job.directory) await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function getJobOrThrow(id) {
    const job = jobs.get(String(id));
    if (!job) throw new Error("job_not_found");
    return job;
  }

  return { createJob, attachSource, attachSourceStream, get, getVtt, jobs };
}

async function processDefaultJob(job, { provider, apiKey, ffmpegBin, ytdlpBin, remoteUrl, remoteToken, updateProgress }) {
  if (provider === "mock") {
    updateProgress("analyzing", 0.75);
    const lines = [{ startMs: 0, endMs: 3_000, text: `演示字幕 · ${job.filename}`, provider: "mock" }];
    return { lines, vtt: toWebVtt(lines) };
  }

  if (provider === "relay") {
    updateProgress("downloading", 0.08);
    const audioPath = await extractAudioLocally({
      pageUrl: job.pageUrl,
      sourceUrl: job.sourceUrl,
      outputDir: job.directory,
      ffmpegBin,
      ytdlpBin,
      onProgress: (value) => updateProgress("downloading", 0.08 + Number(value || 0) * 0.22)
    });
    updateProgress("uploading_audio", 0.32);
    const result = await relayAudioToKoe({
      audioPath,
      remoteUrl,
      remoteToken,
      onProgress: (value) => updateProgress("analyzing", 0.32 + Number(value || 0) * 0.64)
    });
    return { lines: [], vtt: result.vtt };
  }

  updateProgress("downloading", 0.1);
  const sourcePath = job.sourcePath || await acquireSource({
    pageUrl: job.pageUrl,
    sourceUrl: job.sourceUrl,
    outputDir: job.directory,
    ytdlpBin
  });
  updateProgress("analyzing", 0.35);
  const wavPath = join(job.directory, "audio.wav");
  await normalizeToWav({
    inputPath: sourcePath,
    outputPath: wavPath,
    ffmpegBin
  });
  const audio = await readFile(wavPath);
  const lines = await transcribeCompleteWav({
    audio,
    apiKey,
    baseUrl: process.env.DASHSCOPE_BASE_URL,
    model: process.env.ASR_MODEL,
    segmentMs: Number(process.env.ASR_SEGMENT_SECONDS || 60) * 1_000,
    onProgress: (value) => updateProgress("analyzing", 0.35 + value * 0.6)
  });
  return { lines, vtt: toWebVtt(lines) };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    pageUrl: job.pageUrl,
    filename: job.filename,
    provider: job.provider,
    progress: job.progress,
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
