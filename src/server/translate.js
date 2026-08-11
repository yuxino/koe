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
  const entries = lines
    .map((line, index) => ({ index, text: String(line.text || "").trim() }))
    .filter((entry) => entry.text);
  if (!entries.length) return lines;
  const texts = entries.map((entry) => entry.text);

  const chunks = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    chunks.push(texts.slice(offset, offset + batchSize));
  }
  const translated = new Array(lines.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const chunkIndex = cursor;
      cursor += 1;
      const chunk = chunks[chunkIndex];
      const offset = chunkIndex * batchSize;
      const result = await translateChunk({ texts: chunk, apiKey, model, target, timeoutMs, fetchImpl });
      for (let index = 0; index < chunk.length; index += 1) {
        if (result[index]) translated[entries[offset + index].index] = result[index];
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
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await delay(1_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400));
    try {
      const result = await requestChunk({ texts, apiKey, model, target, timeoutMs, fetchImpl });
      const missing = [];
      result.forEach((text, index) => { if (!text) missing.push(index); });
      if (missing.length && missing.length < texts.length) {
        const fill = await requestChunk({
          texts: missing.map((index) => texts[index]),
          apiKey,
          model,
          target,
          timeoutMs,
          fetchImpl
        });
        missing.forEach((originalIndex, fillIndex) => {
          if (fill[fillIndex]) result[originalIndex] = fill[fillIndex];
        });
      }
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("translate_failed");
}

async function requestChunk({ texts, apiKey, model, target, timeoutMs, fetchImpl }) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
