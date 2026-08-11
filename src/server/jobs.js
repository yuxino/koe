import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createSubtitleCache } from "./cache.js";
import { extractAudioLocally, normalizeToAac, normalizeToWav, validateSourceRequest } from "./media.js";
import { transcribeCompleteWav } from "./asr.js";
import { relayAudioToKoe } from "./relay.js";
import { createLineFilter, toWebVtt } from "./transcript.js";
import { translateLines } from "./translate.js";
import { createSemaphore } from "./semaphore.js";
import { streamExtractAndTranscribe } from "./stream.js";

export function createJobManager(options = {}) {
  const jobs = new Map();
  const provider = options.provider || "mock";
  const processJob = options.processJob || ((job, context) => processDefaultJob(job, context));
  const cache = createSubtitleCache({
    cacheRoot: options.cacheRoot ?? process.env.KOE_CACHE_DIR ?? join(homedir(), ".koe", "cache")
  });
  const asrSemaphore = createSemaphore(options.asrMaxConcurrent ?? process.env.ASR_MAX_CONCURRENT ?? 8);
  const extractSemaphore = createSemaphore(options.localExtractConcurrency ?? process.env.LOCAL_EXTRACT_CONCURRENCY ?? 4);
  const translateSemaphore = createSemaphore(Number(options.translateConcurrency ?? (process.env.KOE_TRANSLATE_CONCURRENCY || 4)));
  let activeCount = 0;
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - (Number(process.env.KOE_JOB_TTL_MS || 30 * 60_000));
    for (const [id, job] of jobs) {
      if (["ready", "error", "cancelled"].includes(job.status) && job.completedAt && job.completedAt < cutoff) {
        jobs.delete(id);
      }
    }
  }, 5 * 60_000);
  cleanupTimer.unref?.();

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
      startMs: Number(input.startMs) || 0,
      streamStartMs: Number(input.startMs) || 0,
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
      running: false,
      controller: new AbortController()
    };
    jobs.set(id, job);
    if (source.sourceUrl) {
      const cached = await cache.lookup(source.sourceUrl);
      if (cached && Array.isArray(cached.lines)) {
        if (cached.full && (job.translate ? cached.translated : true)) {
          const cachedLines = job.translate ? cached.lines : stripTranslated(cached.lines);
          const lines = job.startMs > 0
            ? cachedLines
                .filter((line) => Number(line.endMs || 0) > job.startMs)
                .map((line) => ({
                  ...line,
                  startMs: Math.max(0, Number(line.startMs || 0) - job.startMs),
                  endMs: Math.max(0, Number(line.endMs || 0) - job.startMs)
                }))
            : cachedLines;
          if (lines.length || cached.lines.length === 0) {
            job.lines = lines;
            job.vtt = toWebVtt(lines);
            job.status = "ready";
            job.progress = 1;
            job.completedAt = Date.now();
            job.fromCache = true;
            console.log(`[koe] job ${id.slice(0, 8)} cache hit (${lines.length} lines)`);
            return publicJob(job);
          }
        } else if (cached.lines.length) {
          const sorted = [...cached.lines].sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0));
          const gapMs = Number(process.env.KOE_CACHE_GAP_MS || 90_000);
          let cursor = job.startMs;
          for (const line of sorted) {
            const start = Number(line.startMs || 0);
            const end = Number(line.endMs || 0);
            if (start < cursor - gapMs) {
              cursor = Math.max(cursor, end);
              continue;
            }
            if (start - cursor > gapMs) break;
            cursor = Math.max(cursor, end);
          }
          const reachesEnd = Number(job.durationMs) > 0 && cursor >= Number(job.durationMs) - 2_000;
          if ((!job.translate || cached.translated) && job.startMs === 0 && reachesEnd) {
              job.lines = job.translate ? cached.lines : stripTranslated(cached.lines);
              job.vtt = toWebVtt(job.lines);
              job.status = "ready";
              job.progress = 1;
              job.completedAt = Date.now();
              job.fromCache = true;
              console.log(`[koe] job ${id.slice(0, 8)} cache covers full video (${job.lines.length} lines)`);
              return publicJob(job);
            }
          const relevant = sorted.filter((line) => Number(line.endMs || 0) > job.startMs);
          if (relevant.length) {
            const seeded = job.translate ? relevant : stripTranslated(relevant);
            job.lines = seeded;
            job.streamStartMs = Math.max(job.startMs, cursor);
            job.seededFromCache = true;
            job.fromCache = true;
            if (Number(job.durationMs) > 0) {
              job.progress = Math.min(0.85, job.streamStartMs / Number(job.durationMs));
            }
            console.log(`[koe] job ${id.slice(0, 8)} seeded ${seeded.length} cached lines, continuing from ${job.streamStartMs}ms`);
            if (job.translate && seeded.some((line) => !line.translated)) {
              void translateSegment(seeded.filter((line) => !line.translated), {
                apiKey: options.apiKey || process.env.DASHSCOPE_API_KEY || "",
                translateAcquire: () => translateSemaphore.acquire()
              }).catch(() => undefined);
            }
          }
        }
      }
    }
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

  function getPartial(id) {
    const job = getJobOrThrow(id);
    const partialLines = Array.isArray(job.partialSentences) ? job.partialSentences : [];
    return {
      status: job.status,
      progress: job.progress,
      lineCount: job.lines.length,
      vtt: toWebVtt([...job.lines, ...partialLines])
    };
  }

  async function run(job) {
    if (job.running) return;
    job.running = true;
    activeCount += 1;
    job.startedAt = Date.now();
    let lastStatus = "";
    const signal = job.controller.signal;
    const timeoutMs = Number(process.env.KOE_JOB_TIMEOUT_MS || 30 * 60_000);
    const timeoutTimer = setTimeout(() => job.controller.abort(), timeoutMs);
    timeoutTimer.unref?.();
    if (signal.aborted) {
      job.status = "cancelled";
      job.completedAt = Date.now();
      job.running = false;
      activeCount = Math.max(0, activeCount - 1);
      await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    console.log(`[koe] job ${job.id.slice(0, 8)} started (${job.filename}, ${provider})`);
    try {
      const result = await processJob(job, {
        provider,
        apiKey: options.apiKey || process.env.DASHSCOPE_API_KEY || "",
        ffmpegBin: options.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg",
        ytdlpBin: options.ytdlpBin ?? (process.env.YTDLP_BIN !== undefined ? process.env.YTDLP_BIN : "yt-dlp"),
        remoteUrl: options.remoteUrl || process.env.KOE_REMOTE_URL || "",
        remoteToken: options.remoteToken || process.env.KOE_REMOTE_TOKEN || "",
        signal,
        asrAcquire: () => asrSemaphore.acquire(),
        extractAcquire: () => extractSemaphore.acquire(),
        translateAcquire: () => translateSemaphore.acquire(),
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
      if (signal.aborted) {
        job.status = "cancelled";
        job.completedAt = Date.now();
        console.log(`[koe] job ${job.id.slice(0, 8)} cancelled`);
        return;
      }
      job.lines = mergeJobLines(job.lines, result.lines || []);
      job.vtt = result.vtt || toWebVtt(job.lines);
      if (job.translate) {
        const missing = job.lines.filter((line) => !line.translated);
        if (missing.length) {
          await translateSegment(missing, {
            apiKey: options.apiKey || process.env.DASHSCOPE_API_KEY || "",
            translateAcquire: () => translateSemaphore.acquire()
          }).catch(() => undefined);
        }
        job.vtt = toWebVtt(job.lines);
      }
      if (job.sourceUrl) {
        try {
          await cache.save(job.sourceUrl, {
            lines: job.lines,
            durationMs: job.durationMs,
            translated: Boolean(job.translate),
            full: coversWholeVideo(job.lines, job.durationMs)
              || (!job.seededFromCache && job.streamStartMs === 0)
              || (job.seededFromCache && job.streamStartMs > 0 && maxLineEnd(job.lines) <= job.streamStartMs + 2_000)
          });
        } catch {
          // 缓存失败不影响任务结果
        }
      }
      job.status = "ready";
      job.progress = 1;
      job.completedAt = Date.now();
      console.log(`[koe] job ${job.id.slice(0, 8)} ready in ${((job.completedAt - job.startedAt) / 1_000).toFixed(1)}s (${job.lines.length} lines)`);
    } catch (error) {
      const aborted = error?.name === "AbortError" || signal.aborted;
      if (job.sourceUrl && job.lines.length) {
        try {
          await cache.save(job.sourceUrl, {
            lines: job.lines,
            durationMs: job.durationMs,
            translated: Boolean(job.translate),
            full: false
          });
        } catch {
          // 缓存失败不影响任务结果
        }
      }
      job.status = aborted ? "cancelled" : "error";
      job.error = aborted ? "" : error instanceof Error ? error.message : String(error);
      job.completedAt = Date.now();
      console.log(`[koe] job ${job.id.slice(0, 8)} ${aborted ? "cancelled" : "error"} in ${((job.completedAt - job.startedAt) / 1_000).toFixed(1)}s: ${job.error}`);
    } finally {
      clearTimeout(timeoutTimer);
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

  return {
    createJob,
    attachSource,
    attachSourceStream,
    get,
    getVtt,
    getPartial,
    cancel: (id) => {
      const job = jobs.get(String(id));
      if (!job) return false;
      job.controller?.abort();
      return true;
    },
    abortAll: () => {
      for (const job of jobs.values()) job.controller?.abort();
      return activeCount;
    },
    savePartialCaches: async () => {
      const pending = [];
      for (const job of jobs.values()) {
        if (job.sourceUrl && job.lines.length && job.status !== "ready") {
          pending.push(cache.save(job.sourceUrl, {
            lines: job.lines,
            durationMs: job.durationMs,
            translated: Boolean(job.translate),
            full: false
          }));
        }
      }
      await Promise.allSettled(pending);
    },
    prioritize: (id, timeMs) => {
      const job = jobs.get(String(id));
      if (job?.prioritize) job.prioritize(Number(timeMs));
      return Boolean(job);
    },
    jobs,
    get activeCount() { return activeCount; }
  };
}

async function processDefaultJob(job, { provider, apiKey, ffmpegBin, ytdlpBin, remoteUrl, remoteToken, signal, asrAcquire, extractAcquire, translateAcquire, updateProgress }) {
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

  const translationTasks = [];
  const lineFilter = createLineFilter();
  if (!job.sourcePath && process.env.KOE_STREAM_EXTRACT !== "0") {
    try {
      let streamChunks = 0;
      updateProgress("downloading", 0.08, "正在下载 / 提取声音");
      await withSemaphore(extractAcquire, () => streamExtractAndTranscribe({
        pageUrl: job.pageUrl,
        sourceUrl: job.sourceUrl,
        ffmpegBin,
        apiKey,
        signal,
        durationMs: job.durationMs,
        asrAcquire,
        startMs: job.streamStartMs ?? job.startMs,
        onLines: (segmentLines) => {
          job.lines.push(...lineFilter(segmentLines));
          job.lines.sort((left, right) => left.startMs - right.startMs);
          if (job.translate && segmentLines.length) {
            const task = translateSegment(segmentLines, { apiKey, translateAcquire }).catch(() => undefined);
            translationTasks.push(task);
          }
        },
        onPartial: (partialLines) => {
          job.partialSentences = partialLines || [];
        },
        onProgress: (value, detail) => {
          streamChunks += 1;
          updateProgress("analyzing", 0.1 + Number(value || 0) * 0.8, detail || `边下载边识别 · 已处理 ${streamChunks} 段`);
        }
      }));
      updateProgress("analyzing", 0.95, "收尾中");
      await Promise.allSettled(translationTasks);
      return { lines: job.lines, vtt: toWebVtt(job.lines) };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.log(`[koe] job ${job.id.slice(0, 8)} stream failed, falling back: ${error instanceof Error ? error.message : String(error)}`);
      job.lines = [];
    }
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
  const control = {};
  job.prioritize = (timeMs) => control.setPriority?.(Number(timeMs));
  const lines = await transcribeCompleteWav({
    audio,
    apiKey,
    signal,
    baseUrl: process.env.DASHSCOPE_BASE_URL,
    model: process.env.ASR_MODEL,
    segmentMs: Number(process.env.ASR_SEGMENT_SECONDS || 60) * 1_000,
    concurrency: Number(process.env.ASR_CONCURRENCY || 8),
    acquire: asrAcquire,
    control,
    onProgress: (value, detail) => updateProgress("analyzing", 0.35 + value * 0.6, detail || "整段识别中"),
    onLines: (segmentLines, segment) => {
      job.lines.push(...lineFilter(segmentLines));
      job.lines.sort((left, right) => left.startMs - right.startMs);
      if (job.translate && segmentLines.length) {
        const task = translateSegment(segmentLines, { apiKey, translateAcquire }).catch(() => undefined);
        translationTasks.push(task);
      }
    }
  });
  await Promise.allSettled(translationTasks);
  return { lines: job.lines, vtt: toWebVtt(job.lines) };
}

async function translateSegment(segmentLines, { apiKey, translateAcquire }) {
  const release = await translateAcquire();
  try {
    const translated = await translateLines({
      lines: segmentLines,
      apiKey,
      model: process.env.KOE_TRANSLATE_MODEL,
      target: process.env.KOE_TRANSLATE_TARGET || "zh",
      concurrency: 1
    });
    for (let index = 0; index < segmentLines.length; index += 1) {
      if (translated[index]?.translated) segmentLines[index].translated = translated[index].translated;
    }
  } catch {
    // 翻译失败时保留原文
  } finally {
    release();
  }
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
    fromCache: Boolean(job.fromCache),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt
  };
}

function safeFilename(value) {
  const cleaned = String(value || "video").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "video";
}

function stripTranslated(lines) {
  return lines.map((line) => {
    const { translated, ...rest } = line;
    return rest;
  });
}

function mergeJobLines(existing, incoming) {
  const byKey = new Map();
  for (const line of [...(existing || []), ...(incoming || [])]) {
    if (!line || !String(line.text || "").trim()) continue;
    const key = `${Number(line.startMs) || 0}:${String(line.text).trim()}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...line });
      continue;
    }
    if (!current.translated && line.translated) current.translated = line.translated;
    if (Number(line.endMs || 0) > Number(current.endMs || 0)) current.endMs = line.endMs;
  }
  const merged = [...byKey.values()].sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0));
  const result = [];
  for (const line of merged) {
    const previous = result[result.length - 1];
    const sameText = previous && String(previous.text || "").trim().replace(/\s+/g, " ") === String(line.text || "").trim().replace(/\s+/g, " ");
    const near = previous && Math.abs(Number(previous.startMs || 0) - Number(line.startMs || 0)) <= 400;
    if (previous && sameText && near) {
      if (!previous.translated && line.translated) previous.translated = line.translated;
      previous.startMs = Math.min(Number(previous.startMs || 0), Number(line.startMs || 0));
      previous.endMs = Math.max(Number(previous.endMs || 0), Number(line.endMs || 0));
      continue;
    }
    result.push({ ...line });
  }
  return result;
}

export function coversWholeVideo(lines, durationMs) {
  const duration = Number(durationMs);
  if (!(duration > 0) || !Array.isArray(lines) || !lines.length) return false;
  const sorted = [...lines].sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0));
  const gapMs = Number(process.env.KOE_CACHE_GAP_MS || 90_000);
  let cursor = 0;
  for (const line of sorted) {
    const start = Number(line.startMs || 0);
    const end = Number(line.endMs || 0);
    if (start < cursor - gapMs) {
      cursor = Math.max(cursor, end);
      continue;
    }
    if (start - cursor > gapMs) return false;
    cursor = Math.max(cursor, end);
  }
  return cursor >= duration - 15_000;
}

function maxLineEnd(lines) {
  return Math.max(0, ...(lines || []).map((line) => Number(line.endMs || 0)));
}
