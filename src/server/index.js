import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { transcribeWav } from "./asr.js";

loadDotEnv();

const DEFAULT_PORT = 8_787;
const DEFAULT_CHUNK_SECONDS = 15;
const MAX_CHUNK_BYTES = 12 * 1024 * 1024;
const sessions = new Map();

export function createServer(options = {}) {
  const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? "";
  const requestedProvider = options.provider || process.env.ASR_PROVIDER || (apiKey ? "dashscope" : "mock");
  const config = {
    port: Number(options.port ?? process.env.PORT ?? DEFAULT_PORT),
    provider: requestedProvider === "dashscope" && !apiKey ? "mock" : requestedProvider,
    apiKey,
    apiToken: options.apiToken ?? process.env.KOE_API_TOKEN ?? "",
    baseUrl: options.baseUrl || process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: options.model || process.env.ASR_MODEL || "fun-asr-flash-2026-06-15",
    chunkSeconds: Number(options.chunkSeconds || process.env.ASR_CHUNK_SECONDS || DEFAULT_CHUNK_SECONDS)
  };

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
          authRequired: Boolean(config.apiToken),
          chunkSeconds: config.chunkSeconds
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/start") {
        if (!isAuthorized(request, config.apiToken)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        const payload = await readJson(request);
        const id = randomUUID();
        sessions.set(id, {
          id,
          createdAt: Date.now(),
          chunkCount: 0,
          tabId: payload.tabId ?? null,
          pageUrl: payload.pageUrl ?? ""
        });
        sendJson(response, 201, { id, provider: config.provider, chunkSeconds: config.chunkSeconds });
        return;
      }

      const chunkMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/chunk$/);
      if (request.method === "POST" && chunkMatch) {
        if (!isAuthorized(request, config.apiToken)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        const session = sessions.get(chunkMatch[1]);
        if (!session) {
          sendJson(response, 404, { error: "session_not_found" });
          return;
        }

        const audio = await readBody(request, MAX_CHUNK_BYTES);
        const startMs = finiteNumber(request.headers["x-start-ms"], session.chunkCount * config.chunkSeconds * 1_000);
        const endMs = Math.max(startMs, finiteNumber(request.headers["x-end-ms"], startMs + config.chunkSeconds * 1_000));
        const lines = config.provider === "dashscope"
          ? await transcribeWav({ audio, startMs, endMs, apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model })
          : createMockSubtitle(session, startMs, endMs, audio.length);

        session.chunkCount += 1;
        session.lastChunkAt = Date.now();
        sendJson(response, 200, { lines, chunkCount: session.chunkCount });
        return;
      }

      const stopMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        if (!isAuthorized(request, config.apiToken)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        const existed = sessions.delete(stopMatch[1]);
        sendJson(response, existed ? 200 : 404, { ok: existed });
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        sendJson(response, 200, { service: "koe", health: "/health" });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  });

  return { server, config, sessions };
}

function createMockSubtitle(session, startMs, endMs, byteLength) {
  const number = session.chunkCount + 1;
  const duration = Math.max(1_000, endMs - startMs);
  return [{
    startMs,
    endMs: Math.min(endMs, startMs + duration),
    text: `演示字幕 ${number} · 已收到当前标签页音频（${Math.max(1, Math.round(byteLength / 1024))} KB）。配置 Fun-ASR 后会替换成真实听写。`,
    provider: "mock"
  }];
}

function addCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,x-start-ms,x-end-ms");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return readBody(request, 1 * 1024 * 1024).then((body) => {
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

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isAuthorized(request, apiToken) {
  if (!apiToken) return true;
  const authorization = String(request.headers.authorization || "");
  return authorization === `Bearer ${apiToken}`;
}

function loadDotEnv() {
  const path = join(process.cwd(), ".env");
  let contents = "";
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }

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
  const { server, config } = createServer();
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[koe] listening on http://127.0.0.1:${config.port} (${config.provider})`);
  });
}
