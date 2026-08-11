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

function nativeBaseUrl(compatibleBaseUrl) {
  const cleaned = String(compatibleBaseUrl || "").replace(/\/+$/, "");
  if (cleaned.includes("/compatible-mode/v1")) {
    return cleaned.replace(/\/compatible-mode\/v1$/, "/api/v1");
  }
  return "https://dashscope.aliyuncs.com/api/v1";
}
