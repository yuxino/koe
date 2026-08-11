import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_VERSION = 1;

export function createSubtitleCache({ cacheRoot } = {}) {
  const root = String(cacheRoot || "");
  const pendingWrites = new Map();

  async function ensureRoot() {
    await mkdir(root, { recursive: true });
  }

  function fileFor(sourceUrl) {
    const key = createHash("sha256").update(String(sourceUrl || "")).digest("hex");
    return join(root, `${key}.json`);
  }

  async function lookup(sourceUrl) {
    if (!root || !sourceUrl) return null;
    try {
      const entry = JSON.parse(await readFile(fileFor(sourceUrl), "utf8"));
      if (!entry || entry.version !== CACHE_VERSION || !Array.isArray(entry.lines)) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async function save(sourceUrl, { lines = [], durationMs = null, translated = false } = {}) {
    if (!root || !sourceUrl) return;
    try {
      await ensureRoot();
      const entry = {
        version: CACHE_VERSION,
        sourceUrl,
        createdAt: Date.now(),
        durationMs: durationMs ? Number(durationMs) : null,
        translated: Boolean(translated),
        lines: lines.map((line) => {
          const translatedText = String(line.translated || "").trim();
          return {
            startMs: Number(line.startMs) || 0,
            endMs: Number(line.endMs) || 0,
            text: String(line.text || ""),
            ...(translatedText ? { translated: translatedText } : {})
          };
        })
      };
      const target = fileFor(sourceUrl);
      const previous = pendingWrites.get(sourceUrl) || Promise.resolve();
      const current = previous
        .then(async () => {
          const temp = `${target}.tmp`;
          await writeFile(temp, JSON.stringify(entry));
          await rename(temp, target);
        })
        .catch(() => undefined);
      pendingWrites.set(sourceUrl, current);
      await current;
      if (pendingWrites.get(sourceUrl) === current) pendingWrites.delete(sourceUrl);
    } catch {
      // 缓存失败不影响分析结果
    }
  }

  return { lookup, save };
}
