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
