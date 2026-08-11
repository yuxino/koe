import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_VERSION = 1;

export function createSubtitleCache({ cacheRoot } = {}) {
  const root = String(cacheRoot || "");
  const pendingWrites = new Map();
  let saveCount = 0;

  async function ensureRoot() {
    await mkdir(root, { recursive: true });
  }

  function fileFor(sourceUrl) {
    const key = createHash("sha256").update(normalizeSourceUrl(sourceUrl)).digest("hex");
    return join(root, `${key}.json`);
  }

  async function pruneIfNeeded() {
    if (saveCount % 25 !== 0) return;
    try {
      const files = await readdir(root);
      if (files.length <= 600) return;
      const entries = await Promise.all(files.map(async (file) => {
        const path = join(root, file);
        try {
          return { path, mtime: (await stat(path)).mtimeMs };
        } catch {
          return null;
        }
      }));
      const sorted = entries.filter(Boolean).sort((left, right) => right.mtime - left.mtime);
      for (const entry of sorted.slice(600)) {
        await rm(entry.path, { force: true }).catch(() => undefined);
      }
    } catch {
      // 清理失败不影响主流程
    }
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
          saveCount += 1;
          await pruneIfNeeded();
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
  const merged = [...byKey.values()].sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0));
  return squashNearDuplicates(merged);
}

function squashNearDuplicates(lines) {
  const result = [];
  for (const line of lines) {
    const previous = result[result.length - 1];
    const sameText = previous && normalizeText(previous.text) === normalizeText(line.text);
    const near = previous && Math.abs(Number(previous.startMs || 0) - Number(line.startMs || 0)) <= 400;
    if (previous && sameText && near) {
      if (!previous.translated && line.translated) previous.translated = line.translated;
      previous.startMs = Math.min(Number(previous.startMs || 0), Number(line.startMs || 0));
      previous.endMs = Math.max(Number(previous.endMs || 0), Number(line.endMs || 0));
      continue;
    }
    result.push({ ...line });
  }
  return result;
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    const volatile = new Set([
      "secure", "token", "signature", "sig", "expires", "expiration", "expiry", "e",
      "key", "auth", "access_token", "x-id", "x-amz-signature", "x-amz-credential",
      "x-amz-date", "x-amz-expires", "x-amz-signedheaders", "x-amz-security-token",
      "awsaccesskeyid", "policy", "credential"
    ]);
    for (const param of [...url.searchParams.keys()]) {
      if (volatile.has(String(param).toLowerCase())) url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return String(value || "");
  }
}
