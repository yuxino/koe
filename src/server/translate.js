const DEFAULT_MODEL = "qwen-mt-turbo";
const ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";

export async function translateLines({
  lines,
  apiKey,
  model = DEFAULT_MODEL,
  target = "zh",
  batchSize = 20,
  concurrency = 4,
  timeoutMs = 60_000,
  fetchImpl = fetch
}) {
  if (!lines?.length || !apiKey) return lines;
  const texts = lines.map((line) => String(line.text || "")).filter((text) => text.trim());
  if (!texts.length) return lines;

  const chunks = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    chunks.push(texts.slice(offset, offset + batchSize));
  }
  const translated = new Array(texts.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const chunkIndex = cursor;
      cursor += 1;
      const chunk = chunks[chunkIndex];
      const offset = chunkIndex * batchSize;
      const result = await translateChunk({ texts: chunk, apiKey, model, target, timeoutMs, fetchImpl });
      for (let index = 0; index < chunk.length; index += 1) {
        if (result[index]) translated[offset + index] = result[index];
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), chunks.length) }, () => worker()));
  return lines.map((line, index) => {
    const text = String(line.text || "").trim();
    const translatedText = translated[index];
    if (!text || !translatedText || translatedText === text) return line;
    return { ...line, translated: translatedText };
  });
}

async function translateChunk({ texts, apiKey, model, target, timeoutMs, fetchImpl }) {
  const numbered = texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
  const language = target === "zh" ? "简体中文" : String(target);
  const response = await fetchImpl(ENDPOINT, {
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
          content: `把下面每一行分别翻译成${language}。保留编号，一行对应一行，只输出翻译结果：\n${numbered}`
        }]
      },
      parameters: { result_format: "message" }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `translate_failed:${response.status}`);
  }
  const content = body?.output?.choices?.[0]?.message?.content || body?.output?.text || "";
  return parseNumbered(content, texts.length);
}

function parseNumbered(content, count) {
  const results = new Array(count).fill(null);
  let matchedAny = false;
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)[.、．:：]\s*(.*)$/);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < count) {
      results[index] = match[2].trim();
      matchedAny = true;
    }
  }
  if (!matchedAny) {
    let index = 0;
    for (const rawLine of String(content || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line && index < count) results[index] = line;
      index += 1;
    }
  }
  return results;
}
