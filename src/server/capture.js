import { createRealtimeAsr } from "./realtime.js";
import { groupWordsToSubtitles, createLineFilter } from "./transcript.js";
import { translateLines } from "./translate.js";
import { createSemaphore } from "./semaphore.js";

const FRAME_BYTES = Math.max(3_200, 16_000 * 2 * (Number(process.env.KOE_REALTIME_FRAME_MS || 100) / 1_000));
const FRAME_PACE_MS = Math.max(0, Number(process.env.KOE_REALTIME_PACE_MS || (Number(process.env.KOE_REALTIME_FRAME_MS || 100))));
const START_TIMEOUT_MS = 15_000;
const FINISH_TIMEOUT_MS = 10_000;

// 实时字幕：接收扩展送来的 16kHz PCM，逐句识别 + 中文翻译，推回扩展显示。
// 不做视频下载、不做文件转换，只有“声音 → 字幕”。
export function createCaptureManager({
  apiKey = "",
  asrFactory = createRealtimeAsr,
  translateAcquire = null,
  translate = translateLines
} = {}) {
  let emitSeq = 0;
  const sessions = new Set();
  const translateSemaphore = translateAcquire || createSemaphore(Number(process.env.KOE_TRANSLATE_CONCURRENCY || 4));
  const maxSessions = Math.max(1, Number(process.env.KOE_CAPTURE_MAX_SESSIONS || 1));

  function handleConnection(ws) {
    if (sessions.size >= maxSessions) {
      const payload = JSON.stringify({ type: "error", error: "capture_session_busy" });
      ws.send(payload, () => ws.close(1013, "busy"));
      return;
    }
    const session = {
      ws,
      started: false,
      translate: false,
      asr: null,
      frameBuffer: Buffer.alloc(0),
      sendChain: Promise.resolve(),
      nextFrameAt: 0,
      lastSentAt: 0,
      injectedMs: 0,
      keepalive: null,
      sendFailed: false,
      filter: createLineFilter(),
      latestFinalSeq: 0,
      finished: false,
      disposed: false
    };
    sessions.add(session);
    // 标签页音频流偶尔会停顿；服务端长时间收不到音频会判定任务过期断开，
    // 停顿期间每隔几秒补一个静音帧保持连接
    const keepaliveMs = Math.max(1_000, Number(process.env.KOE_REALTIME_KEEPALIVE_MS || 2_000));
    session.keepalive = setInterval(() => {
      if (session.disposed || !session.asr || session.sendFailed) return;
      if (Date.now() - session.lastSentAt >= keepaliveMs) {
        session.injectedMs += FRAME_BYTES / 32;
        queueFrame(session, Buffer.alloc(FRAME_BYTES));
      }
    }, keepaliveMs);
    session.keepalive.unref?.();
    trace("capture-connected");

    const startTimer = setTimeout(() => {
      if (!session.started) fail(session, "capture_start_timeout");
    }, START_TIMEOUT_MS);
    startTimer.unref?.();

    ws.on("message", (data, isBinary) => {
      if (session.disposed) return;
      if (isBinary) {
        if (!session.started) {
          fail(session, "capture_not_started");
          return;
        }
        feedPcm(session, Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      handleText(session, typeof data === "string" ? data : String(data || ""));
    });

    ws.on("close", () => dispose(session));
    ws.on("error", () => dispose(session));
  }

  function handleText(session, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      fail(session, "capture_invalid_message");
      return;
    }
    if (message?.type === "start") {
      if (session.started) return;
      session.started = true;
      session.translate = message.translate !== false;
      void startAsr(session).catch((error) => fail(session, error));
      return;
    }
    if (message?.type === "stop") {
      void stopSession(session);
      return;
    }
    fail(session, "capture_invalid_message");
  }

  async function startAsr(session) {
    if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured.");
    session.asr = asrFactory({ apiKey, model: process.env.KOE_REALTIME_MODEL || undefined });
    await session.asr.connect({
      onSentence: (sentence, final) => handleSentence(session, sentence, final)
    });
    if (session.disposed) return;
    sendJson(session.ws, { type: "ready" });
    trace("capture-asr-ready");
  }

  function handleSentence(session, sentence, final) {
    const rawLines = sentenceToLines(sentence).map((line) => ({
      ...line,
      startMs: Math.max(0, line.startMs - session.injectedMs),
      endMs: Math.max(0, line.endMs - session.injectedMs)
    }));
    if (!rawLines.length || session.disposed) return;
    // 过滤单字母/纯符号等识别噪声（比如把 “T” 当字幕的误识别）
    const lines = session.filter(rawLines);
    if (!lines.length) return;
    const seq = ++emitSeq;
    trace(`capture-send ${final ? "final" : "partial"} n=${lines.length} text=${lines.map((line) => String(line.text || "")).join(" ").slice(0, 60)}`);
    if (!final) {
      sendJson(session.ws, { type: "partial", seq, lines });
      return;
    }
    // 最终句先把原文立刻发出去，保证字幕跟着说话节奏走；翻译再异步补发
    session.latestFinalSeq = seq;
    sendJson(session.ws, { type: "lines", seq, lines });
    if (!session.translate) return;
    void translateAfterFinal(session, seq, lines);
  }

  async function translateAfterFinal(session, seq, lines) {
    // 还没开始翻译就被更新的整句取代，直接跳过，省一次接口调用
    if (session.disposed || seq !== session.latestFinalSeq) return;
    let translated;
    try {
      const release = await translateSemaphore.acquire();
      try {
        if (session.disposed || seq !== session.latestFinalSeq) return;
        translated = await translate({ lines, apiKey });
      } finally {
        release();
      }
    } catch {
      // 翻译失败保留原文，不再补发
      return;
    }
    // 期间如果已经出现更新的“整句”，就不覆盖新字幕；普通中间句不算
    if (session.disposed || !session.translate || seq !== session.latestFinalSeq) return;
    trace(`capture-translated seq=${seq} n=${translated.length}`);
    sendJson(session.ws, { type: "translated", seq, lines: translated });
  }

  function feedPcm(session, chunk) {
    if (!chunk.length) return;
    session.frameBuffer = Buffer.concat([session.frameBuffer, chunk]);
    while (session.frameBuffer.length >= FRAME_BYTES) {
      const frame = session.frameBuffer.subarray(0, FRAME_BYTES);
      session.frameBuffer = session.frameBuffer.subarray(FRAME_BYTES);
      queueFrame(session, frame);
    }
  }

  function queueFrame(session, frame) {
    session.sendChain = session.sendChain
      .then(() => {
        if (session.disposed || !session.asr) return;
        session.lastSentAt = Date.now();
        if (FRAME_PACE_MS > 0) {
          const wait = session.nextFrameAt - Date.now();
          if (wait > 0) return delay(wait).then(() => {
            if (session.disposed || !session.asr) return;
            session.nextFrameAt = Date.now() + FRAME_PACE_MS;
            return session.asr.sendFrame(frame);
          });
          session.nextFrameAt = Date.now() + FRAME_PACE_MS;
        }
        return session.asr.sendFrame(frame);
      })
      .catch((error) => {
        session.sendFailed = true;
        fail(session, error);
      });
  }

  async function stopSession(session) {
    if (session.finished || session.disposed) return;
    session.finished = true;
    const tail = session.frameBuffer;
    session.frameBuffer = Buffer.alloc(0);
    if (tail.length) queueFrame(session, tail);
    try {
      await Promise.race([
        session.sendChain.catch(() => undefined),
        delay(FINISH_TIMEOUT_MS)
      ]);
    } catch {
      // 忽略发送错误
    }
    if (session.asr && !session.sendFailed) {
      try {
        await Promise.race([
          session.asr.finish().catch(() => undefined),
          delay(FINISH_TIMEOUT_MS)
        ]);
        session.asr.close();
      } catch {
        session.asr.terminate();
      }
    }
    if (!session.disposed && session.ws.readyState === 1) {
      try {
        session.ws.send(JSON.stringify({ type: "done" }));
      } catch {
        // 客户端可能已断开
      }
    }
    dispose(session);
  }

  function fail(session, error) {
    if (session.disposed) return;
    const message = error instanceof Error ? error.message : String(error || "capture_failed");
    trace(`capture-failed:${message.slice(0, 120)}`);
    if (session.ws.readyState === 1) {
      try {
        session.ws.send(JSON.stringify({ type: "error", error: message }));
      } catch {
        // 忽略
      }
    }
    dispose(session);
  }

  function dispose(session) {
    if (session.disposed) return;
    session.disposed = true;
    sessions.delete(session);
    if (session.keepalive) clearInterval(session.keepalive);
    session.asr?.terminate();
    session.asr = null;
    try {
      session.ws.close();
    } catch {
      // 连接可能已断开
    }
    trace("capture-disposed");
  }

  return {
    handleConnection,
    get activeCount() { return sessions.size; }
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

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // 连接可能已断开
  }
}

function trace(message) {
  console.log(`[koe] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
