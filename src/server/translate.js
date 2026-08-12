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

  const translated = new Array(lines.length).fill(null);
  const pending = [];
  for (const entry of entries) {
    if (target === "zh" && isAlreadyChinese(entry.text)) {
      translated[entry.index] = entry.text;
    } else {
      pending.push(entry);
    }
  }

  const texts = pending.map((entry) => entry.text);

  const chunks = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    chunks.push(texts.slice(offset, offset + batchSize));
  }
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const chunkIndex = cursor;
      cursor += 1;
      const chunk = chunks[chunkIndex];
      const offset = chunkIndex * batchSize;
      const result = await translateChunk({ texts: chunk, apiKey, model, target, timeoutMs, fetchImpl });
      for (let index = 0; index < chunk.length; index += 1) {
        if (result[index]) translated[pending[offset + index].index] = result[index];
      }
    }
  }

  if (chunks.length) {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), chunks.length) }, () => worker()));
  }
  return lines.map((line, index) => {
    const text = String(line.text || "").trim();
    const translatedText = translated[index];
    // 翻译结果和原文相同（如“哦”“好”这类感叹词）也算“已翻译”，
    // 否则只显示中文模式下这些句子会被过滤掉，造成字幕空缺
    if (!text || !translatedText) return line;
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
  const messages = [
    {
      role: "system",
      content: "你是一名专业字幕翻译。把字幕翻译成自然、口语化的目标语言，保留人名、地名、品牌名，不添加解释或括号；如果原文已经是目标语言，就原样保留。"
    },
    {
      role: "user",
      content: `请把下面每一行字幕翻译成${language}。自动识别源语言，保持编号顺序，一行对应一行，只输出翻译结果：\n${numbered}`
    }
  ];
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "X-DashScope-SSE": "disable"
    },
    body: JSON.stringify({
      model,
      input: { messages },
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

function isAlreadyChinese(value) {
  const text = String(value || "");
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cjk > 0 && cjk >= latin;
}
