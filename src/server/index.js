import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createJobManager } from "./jobs.js";

loadDotEnv();

const DEFAULT_PORT = 8_787;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export function createServer(options = {}) {
  const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? "";
  const remoteUrl = options.remoteUrl ?? process.env.KOE_REMOTE_URL ?? "";
  const remoteToken = options.remoteToken ?? process.env.KOE_REMOTE_TOKEN ?? "";
  const requestedProvider = options.provider || process.env.ASR_PROVIDER || (apiKey ? "dashscope" : "mock");
  const localDashscope = Boolean(options.localAsr || process.env.KOE_LOCAL_ASR === "1") && Boolean(apiKey);
  const localRelay = !localDashscope && Boolean(remoteUrl);
  const config = {
    port: Number(options.port ?? process.env.PORT ?? DEFAULT_PORT),
    provider: localDashscope ? "dashscope" : localRelay ? "relay" : requestedProvider === "dashscope" && !apiKey ? "mock" : requestedProvider,
    apiKey,
    apiToken: options.apiToken ?? process.env.KOE_API_TOKEN ?? "",
    ffmpegBin: options.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg",
    ytdlpBin: options.ytdlpBin ?? (process.env.YTDLP_BIN !== undefined ? process.env.YTDLP_BIN : "yt-dlp"),
    remoteUrl,
    remoteToken,
    mode: localDashscope ? "local" : localRelay ? "local-relay" : "batch"
  };
  const jobs = createJobManager({
    provider: config.provider,
    apiKey: config.apiKey,
    processJob: options.processJob,
    tempRoot: options.tempRoot,
    cacheRoot: options.cacheRoot,
    ffmpegBin: config.ffmpegBin,
    ytdlpBin: config.ytdlpBin,
    remoteUrl: config.remoteUrl,
    remoteToken: config.remoteToken,
    allowAnyPage: localRelay
  });

  const server = createHttpServer(async (request, response) => {
    addCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "koe",
          provider: config.provider,
          mode: config.mode,
          localProcessing: localDashscope || localRelay,
          authRequired: Boolean(config.apiToken),
          activeJobs: jobs.activeCount,
          tools: { ffmpeg: config.ffmpegBin }
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/jobs") {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        const job = await jobs.createJob(await readJson(request));
        sendJson(response, 202, job);
        return;
      }

      const sourceMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/source$/);
      if (request.method === "POST" && sourceMatch) {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        const job = await jobs.attachSourceStream(sourceMatch[1], request, request.headers["x-filename"] || "video", MAX_VIDEO_BYTES);
        sendJson(response, 202, job);
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (request.method === "GET" && statusMatch) {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        const job = jobs.get(statusMatch[1]);
        if (!job) return sendJson(response, 404, { error: "job_not_found" });
        sendJson(response, 200, job);
        return;
      }

      const partialMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/partial$/);
      if (request.method === "GET" && partialMatch) {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        try {
          sendJson(response, 200, jobs.getPartial(partialMatch[1]));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(response, message === "job_not_found" ? 404 : 409, { error: message });
        }
        return;
      }

      const prioritizeMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/prioritize$/);
      if (request.method === "POST" && prioritizeMatch) {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        const body = await readJson(request);
        const found = jobs.prioritize(prioritizeMatch[1], Number(body.timeMs || 0));
        if (!found) return sendJson(response, 404, { error: "job_not_found" });
        sendJson(response, 202, { ok: true });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        if (!jobs.cancel(cancelMatch[1])) return sendJson(response, 404, { error: "job_not_found" });
        sendJson(response, 202, { ok: true });
        return;
      }

      const positionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/position$/);
      if (request.method === "POST" && positionMatch) {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        const body = await readJson(request);
        if (!jobs.setPosition(positionMatch[1], Number(body.timeMs || 0), body.playing)) return sendJson(response, 404, { error: "job_not_found" });
        sendJson(response, 202, { ok: true });
        return;
      }

      const vttMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/vtt$/);
      if (request.method === "GET" && vttMatch) {
        if (!isAuthorized(request, config.apiToken)) return unauthorized(response);
        try {
          const vtt = jobs.getVtt(vttMatch[1]);
          response.writeHead(200, { "content-type": "text/vtt; charset=utf-8", "cache-control": "no-store" });
          response.end(vtt);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(response, message === "job_not_found" ? 404 : 409, { error: message });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        sendJson(response, 200, { service: "koe", mode: "batch", health: "/health", jobs: "/api/jobs" });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: message });
    }
  });

  return { server, config, jobs };
}

function addCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type,x-filename");
}

function unauthorized(response) {
  sendJson(response, 401, { error: "unauthorized" });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return readBody(request, MAX_JSON_BYTES).then((body) => {
    if (!body.length) return {};
    return JSON.parse(body.toString("utf8"));
  });
}

function readBody(request, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function isAuthorized(request, apiToken) {
  if (!apiToken) return true;
  return String(request.headers.authorization || "") === `Bearer ${apiToken}`;
}

function loadDotEnv() {
  const path = join(process.cwd(), ".env");
  let contents = "";
  try { contents = readFileSync(path, "utf8"); } catch { return; }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, config, jobs } = createServer();
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[koe] listening on http://127.0.0.1:${config.port} (${config.provider}, ${config.mode})`);
  });
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    const active = jobs.abortAll();
    console.log(`[koe] ${signal} received, cancelling ${active} active job(s) and saving partial subtitles`);
    await jobs.savePartialCaches();
    await new Promise((resolve) => setTimeout(resolve, 400));
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
