import { groupWordsToSubtitles, compactTranscriptText } from "./transcript.js";

const DEFAULT_MODEL = "fun-asr-flash-2026-06-15";

export async function transcribeWav({
  audio,
  startMs,
  endMs,
  apiKey,
  baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model = DEFAULT_MODEL,
  timeoutMs = 120_000,
  fetchImpl = fetch
}) {
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured.");

  const response = await fetchImpl(
    `${nativeBaseUrl(baseUrl)}/services/aigc/multimodal-generation/generation`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-DashScope-SSE": "disable"
      },
      body: JSON.stringify({
        model,
        input: {
          messages: [{
            role: "user",
            content: [{
              type: "input_audio",
              input_audio: {
                data: `data:audio/wav;base64,${audio.toString("base64")}`
              }
            }]
          }]
        },
        parameters: { format: "wav", sample_rate: 16_000 }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.output?.message || body?.message || body?.code || `ASR request failed: ${response.status}`;
    if (/ASR_RESPONSE_HAVE_NO_WORDS/.test(String(message))) return [];
    throw new Error(String(message));
  }

  const sentence = body?.output?.output?.sentence || body?.output?.sentence;
  const words = Array.isArray(sentence?.words) ? sentence.words : [];
  if (!words.length) {
    const text = compactTranscriptText(sentence?.text);
    return text ? [{ startMs, endMs: Math.max(startMs, endMs), text, provider: "dashscope" }] : [];
  }

  return groupWordsToSubtitles(words).map((line) => ({
    ...line,
    startMs: startMs + line.startMs,
    endMs: Math.min(endMs, startMs + line.endMs),
    provider: "dashscope"
  }));
}

export async function transcribeCompleteWav({
  audio,
  apiKey,
  baseUrl,
  model,
  segmentMs = 60_000,
  concurrency = 5,
  speechRangesMs = null,
  fetchImpl = fetch,
  onProgress = () => undefined
}) {
  const wav = parsePcmWav(audio);
  const bytesPerMs = wav.sampleRate * wav.channels * wav.bitsPerSample / 8 / 1_000;
  const segments = speechRangesMs
    ? buildSpeechSegments(speechRangesMs, segmentMs, wav, bytesPerMs)
    : buildFixedSegments(wav, segmentMs, bytesPerMs);
  const results = new Array(segments.length);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < segments.length) {
      const index = cursor;
      cursor += 1;
      const segment = segments[index];
      const lines = await transcribeWav({
        audio: segment.audio,
        startMs: segment.startMs,
        endMs: segment.endMs,
        apiKey,
        baseUrl,
        model,
        fetchImpl
      });
      results[index] = lines;
      completed += 1;
      onProgress(Math.min(1, completed / Math.max(1, segments.length)));
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), segments.length) }, () => worker()));
  return results.flat().sort((left, right) => left.startMs - right.startMs);
}

function buildFixedSegments(wav, segmentMs, bytesPerMs) {
  const segmentBytes = Math.max(wav.channels, Math.floor(segmentMs * bytesPerMs / wav.blockAlign) * wav.blockAlign);
  const segments = [];
  for (let offset = 0; offset < wav.data.length; offset += segmentBytes) {
    const data = wav.data.subarray(offset, Math.min(wav.data.length, offset + segmentBytes));
    segments.push({
      audio: encodePcmWav(data, wav),
      startMs: Math.round(offset / bytesPerMs),
      endMs: Math.round((offset + data.length) / bytesPerMs)
    });
  }
  return segments;
}

function buildSpeechSegments(rangesMs, segmentMs, wav, bytesPerMs) {
  const durationMs = wav.data.length / bytesPerMs;
  const segments = [];
  for (const [rangeStart, rangeEnd] of rangesMs) {
    const start = Math.max(0, Math.min(rangeStart, rangeEnd));
    const end = Math.min(Math.max(start, rangeEnd), durationMs);
    const pieces = [];
    for (let cursor = start; cursor < end; cursor += segmentMs) {
      const pieceEnd = Math.min(end, cursor + segmentMs);
      if (pieces.length && pieceEnd - cursor < 1_000) {
        pieces[pieces.length - 1][1] = pieceEnd;
        continue;
      }
      pieces.push([cursor, pieceEnd]);
    }
    for (const [pieceStart, pieceEnd] of pieces) {
      const offset = Math.max(0, Math.round(pieceStart * bytesPerMs / wav.blockAlign) * wav.blockAlign);
      const length = Math.max(wav.blockAlign, Math.round((pieceEnd - pieceStart) * bytesPerMs / wav.blockAlign) * wav.blockAlign);
      const data = wav.data.subarray(offset, Math.min(wav.data.length, offset + length));
      segments.push({
        audio: encodePcmWav(data, wav),
        startMs: Math.round(offset / bytesPerMs),
        endMs: Math.min(Math.round((offset + data.length) / bytesPerMs), Math.round(end))
      });
    }
  }
  return segments;
}

function parsePcmWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("invalid_pcm_wav");
  }
  let offset = 12;
  let fmt;
  let data;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === "fmt ") fmt = audio.subarray(bodyStart, bodyStart + size);
    if (id === "data") data = audio.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + size + (size % 2);
  }
  if (!fmt || !data || fmt.length < 16) throw new Error("invalid_pcm_wav");
  const format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const blockAlign = fmt.readUInt16LE(12);
  const bitsPerSample = fmt.readUInt16LE(14);
  if (format !== 1 || !channels || !sampleRate || !blockAlign || bitsPerSample !== 16) throw new Error("unsupported_pcm_wav");
  return { channels, sampleRate, blockAlign, bitsPerSample, data };
}

function encodePcmWav(data, format) {
  const buffer = Buffer.alloc(44 + data.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + data.length, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(format.channels, 22);
  buffer.writeUInt32LE(format.sampleRate, 24);
  buffer.writeUInt32LE(format.sampleRate * format.blockAlign, 28);
  buffer.writeUInt16LE(format.blockAlign, 32);
  buffer.writeUInt16LE(format.bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(data.length, 40);
  data.copy(buffer, 44);
  return buffer;
}

function nativeBaseUrl(compatibleBaseUrl) {
  const cleaned = String(compatibleBaseUrl || "").replace(/\/+$/, "");
  if (cleaned.includes("/compatible-mode/v1")) {
    return cleaned.replace(/\/compatible-mode\/v1$/, "/api/v1");
  }
  return "https://dashscope.aliyuncs.com/api/v1";
}
