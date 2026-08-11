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

function isCommaMarker(punctuation) {
  return /[,，、;；:：]/.test(String(punctuation || ""));
}

export function compactTranscriptText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toWebVtt(lines) {
  const cues = lines
    .filter((line) => String(line.text || "").trim())
    .sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0))
    .map((line, index, sorted) => {
      const startMs = Number(line.startMs || 0);
      const rawEndMs = Math.max(startMs + 200, Number(line.endMs || 0));
      const textLength = String(line.text).trim().length;
      const minDurationMs = Math.max(1_000, Math.min(4_000, textLength * 250));
      const nextStart = sorted[index + 1] ? Number(sorted[index + 1].startMs || 0) : undefined;
      let endMs = Math.max(rawEndMs, startMs + minDurationMs);
      if (nextStart !== undefined) endMs = Math.min(endMs, nextStart - 80);
      endMs = Math.max(endMs, startMs + 200);
      return [
      String(index + 1),
      `${formatVttTime(startMs)} --> ${formatVttTime(endMs)}`,
      [String(line.text).trim(), String(line.translated || "").trim()].filter(Boolean).join("\n")
      ].join("\n");
    });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

function formatVttTime(value) {
  const milliseconds = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const rest = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}
