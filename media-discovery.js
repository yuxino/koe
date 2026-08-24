(() => {
  if (globalThis.KoeMediaDiscovery?.version === 1) return;

  const MAX_INLINE_SCRIPT_BYTES = 4 * 1_024 * 1_024;
  const MAX_SINGLE_SCRIPT_BYTES = 1 * 1_024 * 1_024;
  const DEFAULT_LIMIT = 24;

  function normalizeInlineSource(value) {
    return String(value || "")
      .replace(/\\u002f/gi, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
  }

  function inferredQuality(value) {
    try {
      const path = new URL(String(value || "")).pathname.toLowerCase();
      const match = path.match(/(?:^|[\/_-])(2160|1440|1080|720|480|360|240|180|144)(?:[\/_.-]|$)/);
      return Math.max(0, Number(match?.[1]) || 0);
    } catch {
      return 0;
    }
  }

  function extractHlsDefinitions(value, { limit = DEFAULT_LIMIT } = {}) {
    const maximum = Math.max(1, Math.min(DEFAULT_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const source = normalizeInlineSource(value);
    const matches = source.match(/https?:\/\/[^\s"'<>`\\]+?\.m3u8(?:\?[^\s"'<>`\\)]*)?/gi) || [];
    const output = [];
    const seen = new Set();
    for (const match of matches) {
      let url;
      try {
        const parsed = new URL(match.replace(/[;,]+$/, ""));
        if (!/^https?:$/i.test(parsed.protocol) || !/\.m3u8$/i.test(parsed.pathname)) continue;
        url = parsed.href;
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      output.push({ url, quality: inferredQuality(url) });
      if (output.length >= maximum) break;
    }
    return output;
  }

  function collectInlineHlsDefinitions(root = globalThis.document, { limit = DEFAULT_LIMIT } = {}) {
    if (!root?.querySelectorAll) return [];
    const maximum = Math.max(1, Math.min(DEFAULT_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const output = [];
    const seen = new Set();
    let scannedBytes = 0;
    for (const script of root.querySelectorAll("script")) {
      const text = String(script?.textContent || "");
      if (!text || scannedBytes >= MAX_INLINE_SCRIPT_BYTES) continue;
      const remaining = MAX_INLINE_SCRIPT_BYTES - scannedBytes;
      const sample = text.slice(0, Math.min(MAX_SINGLE_SCRIPT_BYTES, remaining));
      scannedBytes += sample.length;
      for (const definition of extractHlsDefinitions(sample, { limit: maximum })) {
        if (seen.has(definition.url)) continue;
        seen.add(definition.url);
        output.push(definition);
        if (output.length >= maximum) return output;
      }
    }
    return output;
  }

  globalThis.KoeMediaDiscovery = Object.freeze({
    version: 1,
    extractHlsDefinitions,
    collectInlineHlsDefinitions
  });
})();
