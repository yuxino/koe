export function groupWordsToSubtitles(words, options = {}) {
  const {
    maxLineMs = 8_000,
    minGapMs = 1_200
  } = options;
  const lines = [];
  const buffer = [];
  let startMs = null;
  let endMs = null;

  const flushUntil = (count) => {
    if (count <= 0) return;
    const slice = buffer.splice(0, count);
    const text = slice.map((word) => word.text).join("").replace(/\s+/g, " ").trim();
    if (text) {
      lines.push({
        startMs: startMs ?? 0,
        endMs: slice[slice.length - 1].endMs ?? startMs ?? 0,
        text
      });
    }
    startMs = buffer.length ? buffer[0].beginMs : null;
    endMs = buffer.length ? buffer[buffer.length - 1].endMs : null;
  };

  for (const word of words) {
    const begin = Number(word.begin_time) || 0;
    const end = Number(word.end_time) || begin;
    const punctuation = String(word.punctuation || "");
    const isTerminal = /[.!?。！？…]/.test(punctuation);

    if (buffer.length) {
      const gap = begin - (endMs ?? begin);
      const lineMs = end - (startMs ?? begin);
      if (isTerminal) {
        buffer.push({ text: String(word.text || ""), beginMs: begin, endMs: end, punctuation });
        flushUntil(buffer.length);
        continue;
      }
      if (gap > minGapMs) {
        flushUntil(buffer.length);
      } else if (lineMs > maxLineMs) {
        const lastComma = buffer.map((item) => isCommaMarker(item.punctuation)).lastIndexOf(true);
        if (lastComma >= 0) flushUntil(lastComma + 1);
        else flushUntil(buffer.length);
      }
    }

    buffer.push({ text: String(word.text || ""), beginMs: begin, endMs: end, punctuation });
    if (startMs === null) startMs = begin;
    endMs = end;
  }

  flushUntil(buffer.length);
  return lines;
}

export function createLineFilter() {
  const stats = { han: 0, latin: 0 };
  return function filterLines(lines) {
    const batch = Array.isArray(lines) ? lines : [];
    const total = stats.han + stats.latin;
    const dominantHan = total > 20 && stats.han > stats.latin * 2;
    const dominantLatin = total > 20 && stats.latin > stats.han * 2;
    const accepted = [];
    for (const line of batch) {
      const text = String(line.text || "").trim();
      // 单个拉丁字母/数字（如识别出的 “T”）和纯符号行是噪声
      if (/^[A-Za-z0-9]$/.test(text)) continue;
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      if (text.length >= 8 && dominantLatin && han > 0 && latin === 0) continue;
      if (text.length >= 8 && dominantHan && latin > 0 && han === 0) continue;
      accepted.push(line);
    }
    for (const line of accepted) {
      const text = String(line.text || "").trim();
      const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      if (han && !latin) stats.han += text.length;
      if (latin && !han) stats.latin += text.length;
    }
    return accepted;
  };
}

function isCommaMarker(punctuation) {
  return /[,，、;；:：]/.test(String(punctuation || ""));
}
