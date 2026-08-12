import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const MEDIA_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const SUPPORTED_PAGE_HOSTS = ["pornhub.com", "xvideos.com"];

export function isSupportedPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SUPPORTED_PAGE_HOSTS.some((host) => hostMatches(url.hostname, host));
  } catch {
    return false;
  }
}

export function validateSourceRequest({ pageUrl = "", sourceUrl = "" } = {}, { allowAnyPage = false } = {}) {
  if (!pageUrl && !sourceUrl) throw new Error("video_source_required");
  if (sourceUrl) {
    if (allowAnyPage) assertHttpUrl(sourceUrl, "source_url");
    else assertPublicHttpUrl(sourceUrl, "source_url");
  }
  // 页面地址只作为媒体下载的 Referer；只要视频源是公开直链，允许本地/内网页面地址
  if (pageUrl) {
    if (sourceUrl) assertHttpUrlAllowLocal(pageUrl, "page_url");
    else assertHttpUrl(pageUrl, "page_url");
  }
  if (!sourceUrl && !allowAnyPage && !isSupportedPageUrl(pageUrl)) {
    throw new Error("unsupported_page_source");
  }
  return { pageUrl: String(pageUrl || ""), sourceUrl: String(sourceUrl || "") };
}

export async function extractAudioLocally({
  pageUrl,
  sourceUrl,
  outputDir,
  ffmpegBin = "ffmpeg",
  onProgress = () => undefined,
  run = runCommand,
  fetchImpl = fetch,
  durationMs = null
}) {
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, "audio.m4a");
  if (!/^https?:/i.test(sourceUrl || "")) {
    throw new Error("页面没有可直接获取的视频地址，无法提取声音。");
  }
  const inputUrl = await resolveHlsAudioVariant(sourceUrl, { pageUrl, fetchImpl });
  try {
    await normalizeToAac({
      input: inputUrl,
      outputPath,
      pageUrl,
      ffmpegBin,
      run,
      durationMs,
      onProgress
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not contain any stream|no stream/i.test(message)) {
      throw new Error("这个视频源里没有可提取的音轨（无声音视频，或直链已失效）。");
    }
    if (/403|forbidden|denied|unavailable/i.test(message)) {
      throw new Error("视频直链被网站拦截或已过期，请刷新页面后重新选择视频再试。");
    }
    throw new Error(`提取声音失败：${message}`);
  }
  return outputPath;
}

export async function resolveHlsAudioVariant(sourceUrl, { pageUrl = "", fetchImpl = fetch } = {}) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return sourceUrl;
  }
  if (!/\.m3u8(\?|$)/i.test(url.pathname)) return sourceUrl;

  let text = "";
  try {
    const response = await fetchImpl(url.toString(), {
      redirect: "follow",
      headers: {
        ...(pageUrl ? { referer: pageUrl } : {}),
        "user-agent": MEDIA_USER_AGENT
      }
    });
    if (response.ok) text = await response.text();
  } catch {
    return sourceUrl;
  }
  const variant = pickAudioVariantUri(text);
  if (!variant) return sourceUrl;
  return new URL(variant, url).toString();
}

function pickAudioVariantUri(playlist) {
  const mediaLines = String(playlist || "").match(/#EXT-X-MEDIA:[^\r\n]+/g) || [];
  const audio = mediaLines.filter((line) => /TYPE\s*=\s*"?AUDIO"?/i.test(line));
  if (!audio.length) return null;
  const chosen = audio.find((line) => /\bDEFAULT\s*=\s*YES/i.test(line)) || audio[0];
  const match = chosen.match(/URI\s*=\s*"([^"]+)"/) || chosen.match(/URI\s*=\s*([^,\s]+)/);
  return match ? match[1] : null;
}

export async function normalizeToWav({ inputPath, outputPath, ffmpegBin = "ffmpeg", run = runCommand }) {
  await run(ffmpegBin, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath
  ]);
  return outputPath;
}

export async function detectSpeechRanges({
  inputPath,
  ffmpegBin = "ffmpeg",
  run = runCommand,
  noiseDb = -30,
  minSilenceSec = 0.5,
  minSpeechSec = 0.3,
  gapSec = 0.5,
  padSec = 0.2
}) {
  const { stdout, stderr } = await run(ffmpegBin, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "info",
    "-i",
    inputPath,
    "-af",
    `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    "-f",
    "null",
    "-"
  ]);
  const text = `${stderr || ""}\n${stdout || ""}`;
  const duration = parseMediaDuration(text);
  if (duration <= 0) return [];
  const ranges = [];
  let cursor = 0;
  for (const [start, end] of parseSilenceIntervals(text)) {
    if (start > cursor) ranges.push([cursor, Math.min(start, duration)]);
    cursor = Math.max(cursor, Math.min(Number.isFinite(end) ? end : duration, duration));
  }
  if (cursor < duration) ranges.push([cursor, duration]);
  return mergeSpeechRanges(ranges, { duration, minSpeechSec, gapSec, padSec });
}

export async function normalizeToAac({ input, outputPath, pageUrl = "", ffmpegBin, run = runCommand, onProgress = () => undefined, durationMs = null }) {
  const inputOptions = pageUrl
    ? [
        "-headers",
        `Referer: ${pageUrl}\r\nUser-Agent: ${MEDIA_USER_AGENT}\r\n`
      ]
    : [];
  const hlsOptions = /\.m3u8(\?|$)/i.test(String(input || "")) ? ["-http_multiple", "1"] : [];
  await run(ffmpegBin, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputOptions,
    ...hlsOptions,
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    ...(durationMs ? ["-progress", "pipe:1", "-nostats"] : []),
    outputPath
  ], {
    onStdout: durationMs ? createProgressParser(onProgress, Number(durationMs)) : undefined
  });
}

function createProgressParser(onProgress, durationMs) {
  let buffer = "";
  let lastPercent = -1;
  return (chunk) => {
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const match = line.match(/^out_time_ms=(\d+)/);
      if (!match || !durationMs) continue;
      const percent = Math.round((Number(match[1]) / durationMs) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress(Math.max(0, Math.min(1, Number(match[1]) / durationMs)));
      }
    }
  };
}

export function runCommand(command, args, { cwd, onStdout = () => undefined, onStderr = () => undefined } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderr(chunk);
    });
    child.on("error", (error) => reject(new Error(`${command}_unavailable:${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command}_failed:${compactError(stderr || stdout)}`));
      }
    });
  });
}

function assertHttpUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field}_invalid`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field}_scheme_not_allowed`);
  if (isPrivateHostname(url.hostname)) throw new Error(`${field}_private_host_not_allowed`);
}

function assertHttpUrlAllowLocal(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field}_invalid`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${field}_scheme_not_allowed`);
}

function assertPublicHttpUrl(value, field) {
  assertHttpUrl(value, field);
  if (new URL(value).protocol !== "https:") throw new Error(`${field}_https_required`);
}

function isPrivateHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/[\[\]]/g, "");
  if (["localhost", "localhost.localdomain"].includes(normalized) || normalized.endsWith(".local")) return true;
  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (family === 6) return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  return false;
}

function hostMatches(hostname, root) {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function mediaExtension(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const match = pathname.match(/\.(mp4|webm|mov|m4v|mkv|avi|mp3|m4a|wav)(?:$|\?)/);
    return match ? `.${match[1]}` : ".media";
  } catch {
    return ".media";
  }
}

function compactError(value) {
  return String(value || "unknown").trim().replace(/\s+/g, " ").slice(-500);
}

function parseSilenceIntervals(text) {
  const intervals = [];
  let open = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (start) open = Number(start[1]);
    if (end) {
      intervals.push([open ?? 0, Number(end[1])]);
      open = null;
    }
  }
  if (open !== null) intervals.push([open, Number.POSITIVE_INFINITY]);
  return intervals;
}

function parseMediaDuration(text) {
  const match = String(text || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
}

function mergeSpeechRanges(ranges, { duration, minSpeechSec, gapSec, padSec }) {
  if (!ranges.length) return [];
  const merged = [];
  let [start, end] = ranges[0];
  for (const [nextStart, nextEnd] of ranges.slice(1)) {
    if (nextStart - end <= gapSec) end = Math.max(end, nextEnd);
    else {
      merged.push([start, end]);
      [start, end] = [nextStart, nextEnd];
    }
  }
  merged.push([start, end]);
  return merged
    .map(([itemStart, itemEnd]) => [Math.max(0, itemStart - padSec), Math.min(duration, itemEnd + padSec)])
    .filter(([itemStart, itemEnd]) => itemEnd - itemStart >= minSpeechSec);
}
