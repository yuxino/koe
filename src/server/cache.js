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

  async function save(sourceUrl, { lines = [], durationMs = null, translated = false, full = false } = {}) {
    if (!root || !sourceUrl) return;
    try {
      await ensureRoot();
      const existing = await lookup(sourceUrl);
      const merged = mergeLines(existing?.lines || [], lines.map((line) => {
        const translatedText = String(line.translated || "").trim();
        return {
          startMs: Number(line.startMs) || 0,
          endMs: Number(line.endMs) || 0,
          text: String(line.text || ""),
          ...(translatedText ? { translated: translatedText } : {})
        };
      }));
      const entry = {
        version: CACHE_VERSION,
        sourceUrl,
        createdAt: existing?.createdAt || Date.now(),
        durationMs: Number(durationMs) || existing?.durationMs || null,
        translated: Boolean(existing?.translated || translated),
        full: Boolean(existing?.full || full),
        lines: merged
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

function mergeLines(existing, incoming) {
  const byKey = new Map();
  for (const line of [...existing, ...incoming]) {
    const key = `${Math.round(Number(line.startMs) || 0)}:${String(line.text || "")}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...line });
      continue;
    }
    if (!current.translated && line.translated) current.translated = line.translated;
    if (Number(line.endMs || 0) > Number(current.endMs || 0)) current.endMs = line.endMs;
  }
  return [...byKey.values()].sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0));
}
