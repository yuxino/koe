import { spawn } from "node:child_process";
import { join } from "node:path";
import { transcribeWav } from "./asr.js";
import { createRealtimeAsr } from "./realtime.js";
import { groupWordsToSubtitles } from "./transcript.js";
import { createSemaphore } from "./semaphore.js";

const FIRST_CHUNK_MS = 5_000;
const CHUNK_MS = Math.max(10_000, Number(process.env.KOE_STREAM_CHUNK_SECONDS || 30) * 1_000);
const REALTIME_FRAME_BYTES = Math.max(3_200, 16_000 * 2 * (Number(process.env.KOE_REALTIME_FRAME_MS || 250) / 1_000));
const realtimeSessionSlots = createSemaphore(Math.max(1, Number(process.env.KOE_REALTIME_MAX_SESSIONS || 4)));

export async function streamExtractAndTranscribe({
  pageUrl,
  sourceUrl,
  ffmpegBin,
  apiKey,
  asrAcquire,
  onLines,
  onPartial,
  onProgress,
  startMs = 0,
  durationMs = null,
  getPositionMs = null,
  isPlaying = () => false,
  signal = null
}) {
  if (!/^https?:/i.test(sourceUrl || "")) {
    throw new Error("页面没有可直接获取的视频地址，无法分析。");
  }
  if (process.env.KOE_REALTIME_ASR !== "0") {
    let emittedLines = 0;
    try {
      return await streamRealtimeTranscribe({
        pageUrl,
        sourceUrl,
        ffmpegBin,
        apiKey,
        onLines: (lines) => {
          emittedLines += lines.length;
          onLines(lines);
        },
        onPartial,
        onProgress,
        startMs,
        durationMs,
        getPositionMs,
        isPlaying,
        signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.log(`[koe] realtime failed${emittedLines ? ` after ${emittedLines} lines` : ""}, falling back to chunked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return streamChunkedTranscribe({
    pageUrl,
    sourceUrl,
    ffmpegBin,
    apiKey,
    asrAcquire,
    onLines,
    onProgress,
    startMs,
    durationMs,
    signal
  });
}

export async function streamRealtimeTranscribe({
  pageUrl,
  sourceUrl,
  ffmpegBin,
  apiKey,
  onLines,
  onPartial,
  onProgress,
  startMs = 0,
  durationMs = null,
  getPositionMs = null,
  isPlaying = () => false,
  signal = null
}) {
  const startedAt = Date.now();
  const log = (message) => console.log(`[koe] realtime +${((Date.now() - startedAt) / 1_000).toFixed(1)}s ${message}`);
  const aheadMs = Number(process.env.KOE_DOWNLOAD_AHEAD_MS || 30_000);
  const segmentCount = Math.max(1, Number(process.env.KOE_REALTIME_SEGMENTS || 2));
  const baseMs = Number(startMs) || 0;
  const totalMs = Number(durationMs) || 0;
  const options = {
    pageUrl,
    sourceUrl,
    ffmpegBin,
    apiKey,
    onLines,
    onPartial,
    onProgress,
    durationMs,
    getPositionMs,
    isPlaying,
    signal,
    aheadMs,
    startedAt,
    log
  };

  if (segmentCount <= 1 || !(totalMs > 0) || baseMs >= totalMs) {
    const single = await runRealtimeWithRetries({ ...options, segmentStartMs: baseMs, segmentEndMs: null });
    return { chunks: single.lines, realtime: true, partial: Boolean(single.partial) };
  }

  const segmentMs = Math.max(30_000, (totalMs - baseMs) / segmentCount);
  const segments = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const segmentStart = Math.round(baseMs + index * segmentMs);
    const segmentEnd = Math.min(totalMs, Math.round(baseMs + (index + 1) * segmentMs));
    if (segmentEnd - segmentStart < 5_000) continue;
    segments.push({ start: segmentStart, end: segmentEnd });
  }
  if (!segments.length) {
    const single = await runRealtimeWithRetries({ ...options, segmentStartMs: baseMs, segmentEndMs: null });
    return { chunks: single.lines, realtime: true, partial: Boolean(single.partial) };
  }
  log(`parallel realtime: ${segments.length} segments`);
  const results = await Promise.allSettled(segments.map((segment) => runRealtimeWithRetries({
    ...options,
    segmentStartMs: segment.start,
    segmentEndMs: segment.end
  })));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  const totalLines = results.reduce((sum, result) => sum + (result.value?.lines || 0), 0);
  const anyPartial = results.some((result) => result.value?.partial);
  return { chunks: totalLines, realtime: true, partial: Boolean(anyPartial) };
}

async function runRealtimeWithRetries({
  pageUrl,
  sourceUrl,
  ffmpegBin,
  apiKey,
  onLines,
  onPartial,
  onProgress,
  durationMs,
  getPositionMs,
  isPlaying,
  signal,
  aheadMs,
  startedAt,
  log,
  segmentStartMs,
  segmentEndMs
}) {
  const maxAttempts = Math.max(1, Number(process.env.KOE_REALTIME_RETRIES || 3));
  const shared = { totalAudioMs: segmentStartMs, sentenceCount: 0 };
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const outcome = await runRealtimeAttempt({
      pageUrl,
      sourceUrl,
      ffmpegBin,
      apiKey,
      onLines,
      onPartial,
      onProgress,
      durationMs,
      getPositionMs,
      isPlaying,
      signal,
      aheadMs,
      startedAt,
      log,
      segmentStartMs: shared.totalAudioMs,
      segmentEndMs,
      shared
    });
    if (outcome.ok) return { lines: shared.sentenceCount, partial: Boolean(outcome.partial) };
    lastError = outcome.error;
    if (lastError?.name === "AbortError") throw lastError;
    log(`segment ${formatPosition(segmentStartMs)} attempt ${attempt + 1}/${maxAttempts} failed after ${shared.sentenceCount} lines: ${lastError?.message || String(lastError)}`);
    if (attempt + 1 >= maxAttempts) break;
    await delay(1_000);
  }
  throw lastError || new Error("realtime_unreachable");
}

async function runRealtimeAttempt({
  pageUrl,
  sourceUrl,
  ffmpegBin,
  apiKey,
  onLines,
  onPartial,
  onProgress,
  durationMs,
  getPositionMs,
  isPlaying,
  signal,
  aheadMs,
  startedAt,
  log,
  segmentEndMs,
  shared
}) {
  const videoOffsetMs = shared.totalAudioMs;
  const headers = pageUrl
    ? ["-headers", `Referer: ${pageUrl}\r\nUser-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36\r\n`]
    : [];
  const seekArgs = videoOffsetMs > 0 ? ["-ss", String(videoOffsetMs / 1_000)] : [];
  const durationArgs = segmentEndMs ? ["-t", String(Math.max(0.1, (Number(segmentEndMs) - videoOffsetMs) / 1_000))] : [];
  const hlsArgs = /\.m3u8(\?|$)/i.test(String(sourceUrl || "")) ? ["-http_multiple", "1"] : [];
  const spawned = spawnFfmpeg(ffmpegBin, [...headers, ...seekArgs, ...hlsArgs, "-i", sourceUrl, ...durationArgs]);
  const asr = createRealtimeAsr({
    apiKey,
    model: process.env.KOE_REALTIME_MODEL || undefined,
    wsUrl: process.env.KOE_REALTIME_WS_URL || undefined,
    parameters: {
      semantic_punctuation_enabled: false,
      max_sentence_silence: Math.max(200, Number(process.env.KOE_REALTIME_SILENCE_MS || 800)),
      multi_threshold_mode_enabled: true,
      heartbeat: true
    }
  });
  let attemptAudioMs = 0;
  let firstAudioAt = 0;
  const connectTicker = setInterval(() => {
    if (firstAudioAt || !onProgress) return;
    const waited = Math.floor((Date.now() - startedAt) / 1_000);
    onProgress(0.08, `正在连接视频源 · ${waited}s`);
  }, 1_000);
  let paced = false;
  let stallWatchdog = null;
  const onAbort = () => {
    asr.terminate();
    spawned.kill();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const slotTimeoutMs = Math.max(5_000, Number(process.env.KOE_REALTIME_SLOT_TIMEOUT_MS || 60_000));
  let slotTimedOut = false;
  const acquired = realtimeSessionSlots.acquire().then((release) => {
    if (slotTimedOut) {
      release();
      return () => undefined;
    }
    return release;
  });
  const releaseSlot = await Promise.race([
    acquired,
    delay(slotTimeoutMs).then(() => {
      slotTimedOut = true;
      throw new Error("realtime_session_slot_timeout");
    })
  ]);

  try {
    await asr.connect({
      onSentence: (sentence, final) => {
        if (final) {
          const lines = sentenceToLines(sentence);
          if (lines.length) {
            shared.sentenceCount += lines.length;
            onLines(lines.map((line) => ({
              ...line,
              startMs: line.startMs + videoOffsetMs,
              endMs: line.endMs + videoOffsetMs
            })));
            const position = Number(durationMs) > 0 ? Math.min(0.8, shared.totalAudioMs / Number(durationMs)) : Math.min(0.8, shared.sentenceCount * 0.012);
            const positionText = Number(durationMs) > 0 ? ` · 已到 ${formatPosition(shared.totalAudioMs)}` : "";
            onProgress(Math.min(0.95, 0.06 + position), `实时识别中 · 已出 ${shared.sentenceCount} 句${positionText}`);
          }
          return;
        }
        const text = String(sentence.text || "").trim();
        if (!onPartial || !text) return;
        const begin = Number(sentence.begin_time) || 0;
        const estimatedEnd = begin + Math.max(2_000, Math.min(12_000, text.length * 400));
        const end = Math.max(estimatedEnd, Number(sentence.end_time) || estimatedEnd);
        onPartial([{ startMs: begin + videoOffsetMs, endMs: end + videoOffsetMs, text }]);
      }
    });

    log(`task started, pumping audio`);
    let frame = Buffer.alloc(0);
    let sentFirst = false;
    let lastAudioAt = Date.now();
    const stallMs = Number(process.env.KOE_REALTIME_STALL_MS || 60_000);
    stallWatchdog = setInterval(() => {
      if (!paced && Date.now() - lastAudioAt > stallMs) {
        asr.terminate();
        spawned.kill();
      }
    }, 10_000);
    stallWatchdog.unref?.();
    for await (const chunk of spawned.stream) {
      if (signal?.aborted) throw abortError();
      if (!chunk.length) continue;
      firstAudioAt ||= Date.now();
      lastAudioAt = Date.now();
      attemptAudioMs += Math.round(chunk.length / 32);
      shared.totalAudioMs = videoOffsetMs + attemptAudioMs;
      if (!sentFirst) {
        await asr.sendFrame(chunk);
        sentFirst = true;
        continue;
      }
      frame = Buffer.concat([frame, chunk]);
      while (frame.length >= REALTIME_FRAME_BYTES) {
        await asr.sendFrame(frame.subarray(0, REALTIME_FRAME_BYTES));
        frame = frame.subarray(REALTIME_FRAME_BYTES);
      }
      if (getPositionMs && isPlaying?.()
        && (!segmentEndMs || getPositionMs() < segmentEndMs)
        && shared.totalAudioMs - getPositionMs() > aheadMs) {
        paced = true;
        spawned.pause();
        const silence = Buffer.alloc(REALTIME_FRAME_BYTES);
        while (getPositionMs && isPlaying?.() && shared.totalAudioMs - getPositionMs() > aheadMs) {
          if (signal?.aborted) throw abortError();
          await asr.sendFrame(silence).catch(() => undefined);
          await delay(500);
        }
        spawned.resume();
        paced = false;
      }
    }
    clearInterval(stallWatchdog);
    clearInterval(connectTicker);
    if (frame.length) await asr.sendFrame(frame);
    if (signal?.aborted) throw abortError();
    const failed = spawned.diagnostics.filter((entry) => entry.code !== 0);
    if (failed.length) {
      const stderrTail = spawned.stderrText ? `; stderr: ${spawned.stderrText.slice(-400)}` : "";
      throw new Error(`realtime pipeline failed (${failed.map((entry) => `${entry.command} exit ${entry.code}`).join(", ")})${stderrTail}`);
    }
    log(`audio pumped, finishing`);
    const finishTimeoutMs = Math.min(
      Number(process.env.KOE_REALTIME_FINISH_TIMEOUT_MS || 600_000),
      Math.max(90_000, Math.round(shared.totalAudioMs * 0.3) + 30_000)
    );
    const finished = await Promise.race([
      asr.finish().then(() => true).catch(() => false),
      delay(finishTimeoutMs).then(() => false)
    ]);
    if (signal?.aborted) throw abortError();
    if (!finished) {
      if (asr.closed) throw new Error("realtime_socket_closed_during_finish");
      log(`finish timeout after ${(finishTimeoutMs / 1_000).toFixed(0)}s, keeping ${shared.sentenceCount} lines`);
      asr.terminate();
      return { ok: true, partial: true };
    }
    asr.close();
    log(`finished with ${shared.sentenceCount} lines`);
    return { ok: true };
  } catch (error) {
    asr.terminate();
    spawned.kill();
    log(`attempt dropped at ${formatPosition(shared.totalAudioMs)}: ${error?.message || String(error)}`);
    return { ok: false, error };
  } finally {
    releaseSlot();
    signal?.removeEventListener("abort", onAbort);
    clearInterval(connectTicker);
    if (stallWatchdog) clearInterval(stallWatchdog);
  }
}

async function streamChunkedTranscribe({
  pageUrl,
  sourceUrl,
  ffmpegBin,
  apiKey,
  asrAcquire,
  onLines,
  onProgress,
  startMs = 0,
  durationMs = null,
  signal = null
}) {
  if (!/^https?:/i.test(sourceUrl || "")) {
    throw new Error("页面没有可直接获取的视频地址，无法分析。");
  }
  const headers = pageUrl
    ? ["-headers", `Referer: ${pageUrl}\r\nUser-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36\r\n`]
    : [];
  const seekArgs = Number(startMs) > 0 ? ["-ss", String(Number(startMs) / 1_000)] : [];
  const hlsArgs = /\.m3u8(\?|$)/i.test(String(sourceUrl || "")) ? ["-http_multiple", "1"] : [];
  return runPipeline(() => spawnFfmpeg(ffmpegBin, [...headers, ...seekArgs, ...hlsArgs, "-i", sourceUrl]), {
    ffmpegBin,
    apiKey,
    asrAcquire,
    onLines,
    onProgress,
    startMs,
    durationMs,
    signal
  });
}

async function runPipeline(factory, { ffmpegBin, apiKey, asrAcquire, onLines, onProgress, startMs = 0, durationMs = null, signal = null }) {
  const startedAt = Date.now();
  const log = (message) => console.log(`[koe] stream +${((Date.now() - startedAt) / 1_000).toFixed(1)}s ${message}`);
  const spawned = factory();
  const { stream, closePromise, diagnostics } = spawned;
  signal?.addEventListener("abort", () => spawned.kill(), { once: true });
  let gotAudio = false;
  let lastAudioAt = Date.now();
  const streamStallMs = Number(process.env.KOE_STREAM_STALL_MS || 90_000);
  const stallTimer = setInterval(() => {
    if (Date.now() - lastAudioAt > streamStallMs) spawned.kill();
  }, 10_000);
  stallTimer.unref?.();
  const connectTicker = setInterval(() => {
    if (gotAudio || !onProgress) return;
    const waited = Math.floor((Date.now() - startedAt) / 1_000);
    onProgress(0.08, `正在连接视频源 · ${waited}s`);
  }, 1_000);
  connectTicker.unref?.();
  const queue = [];
  const failures = [];
  const processed = new Set();
  const workerCount = Math.max(1, Number(process.env.KOE_STREAM_WORKERS || 16));
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
      gotAudio = true;
      lastAudioAt = Date.now();
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
      if (signal?.aborted) throw abortError();
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
      try {
        const lines = await transcribeChunk(audio, chunkMs, apiKey, asrAcquire);
        onLines(lines.map((line) => ({
          ...line,
          startMs: line.startMs + chunkStartMs,
          endMs: line.endMs + chunkStartMs
        })));
        const progress = Number(durationMs) > 0
          ? Math.min(1, (chunkStartMs + chunkMs) / Number(durationMs))
          : Math.min(1, chunkCount * 0.05);
        onProgress(progress);
        log(`chunk ${index} done (${lines.length} lines)`);
      } catch (error) {
        log(`chunk ${index} failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
        failures.push({ index, audio, chunkStartMs });
      }
    }
  }

  await Promise.all([collector(), ...Array.from({ length: workerCount }, () => worker())]);
  clearInterval(stallTimer);
  clearInterval(connectTicker);
  if (signal?.aborted) throw abortError();
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
  let stderrText = "";
  const ff = spawn(ffmpegBin, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    ...args,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(ff);
  ff.stderr.on("data", (chunk) => {
    stderrText += String(chunk || "");
    if (stderrText.length > 8_000) stderrText = stderrText.slice(-8_000);
  });
  const kill = () => {
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  };
  const pause = () => {
    for (const child of children) {
      try { child.kill("SIGSTOP"); } catch { /* ignore */ }
    }
  };
  const resume = () => {
    for (const child of children) {
      try { child.kill("SIGCONT"); } catch { /* ignore */ }
    }
  };
  const closePromise = Promise.all(children.map((child) => new Promise((resolve) => {
    child.on("close", (code) => {
      diagnostics.push({ command: String(child.spawnargs?.[0] || "child").split("/").pop(), code });
      resolve();
    });
  })));
  return {
    stream: ff.stdout,
    closePromise,
    diagnostics,
    kill,
    pause,
    resume,
    get stderrText() { return stderrText; }
  };
}

function sentenceToLines(sentence) {
  const words = Array.isArray(sentence.words) && sentence.words.length
    ? sentence.words.map((word) => ({
        text: String(word.text || ""),
        begin_time: Number(word.begin_time) || 0,
        end_time: Number(word.end_time) || 0,
        punctuation: String(word.punctuation || "")
      }))
    : null;
  if (words?.length) {
    const lines = groupWordsToSubtitles(words);
    if (lines.length) return lines;
  }
  const text = String(sentence.text || "").trim();
  if (!text) return [];
  const begin = Number(sentence.begin_time) || 0;
  const end = Math.max(begin + 500, Number(sentence.end_time) || begin + 500);
  return [{ startMs: begin, endMs: end, text }];
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
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function abortError() {
  const error = new Error("job_cancelled");
  error.name = "AbortError";
  return error;
}

function formatPosition(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
