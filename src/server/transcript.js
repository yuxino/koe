export function groupWordsToSubtitles(words, options = {}) {
  const {
    maxLineMs = 8_000,
    minGapMs = 1_500,
    minLineMs = 1_200
  } = options;
  const lines = [];
  let buffer = [];
  let startMs = null;
  let endMs = null;
  let lastWasTerminal = false;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer
      .map((word) => String(word.text || ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      lines.push({
        startMs: startMs ?? 0,
        endMs: endMs ?? startMs ?? 0,
        text
      });
    }
    buffer = [];
    startMs = null;
    endMs = null;
    lastWasTerminal = false;
  };

  for (const word of words) {
    const begin = Number(word.begin_time) || 0;
    const end = Number(word.end_time) || begin;
    const punctuation = String(word.punctuation || "");
    const isTerminal = /[.!?。！？…]/.test(punctuation);

    if (buffer.length) {
      const gap = begin - (endMs ?? begin);
      const lineMs = end - (startMs ?? begin);
      if (
        (lastWasTerminal && lineMs >= minLineMs) ||
        gap > minGapMs ||
        lineMs > maxLineMs
      ) {
        flush();
      }
    }

    buffer.push(word);
    if (startMs === null) startMs = begin;
    endMs = end;
    lastWasTerminal = isTerminal;
  }

  flush();
  return lines;
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
