import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { WebSocketServer } from "ws";
import { createCaptureManager } from "./capture.js";

loadDotEnv();

const DEFAULT_PORT = 8_787;
const MAX_JSON_BYTES = 1 * 1024 * 1024;

export function createServer(options = {}) {
  const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? "";
  const config = {
    port: Number(options.port ?? process.env.PORT ?? DEFAULT_PORT),
    apiKey,
    provider: apiKey ? "dashscope" : "mock",
    mode: apiKey ? "local" : "setup"
  };
  const capture = createCaptureManager({ apiKey: config.apiKey });

  const server = createHttpServer(async (request, response) => {
    addCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (!isAllowedOrigin(request)) return sendJson(response, 403, { error: "origin_forbidden" });
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "koe",
          provider: config.provider,
          mode: config.mode,
          localProcessing: Boolean(apiKey),
          authRequired: false,
          apiConfigured: Boolean(apiKey),
          activeCaptures: capture.activeCount
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/trace") {
        const body = await readJson(request);
        console.log(`[koe] trace tab=${body?.tabId} event=${body?.event} ${body?.extra || ""}`);
        sendJson(response, 202, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        sendJson(response, 200, { service: "koe", mode: "realtime", health: "/health", capture: "/api/capture/ws" });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: message });
    }
  });

  const captureWss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/api/capture/ws") {
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    captureWss.handleUpgrade(request, socket, head, (ws) => capture.handleConnection(ws));
  });

  return { server, config, capture };
}

function addCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type");
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

function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "chrome-extension:" || ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
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
  const { server, config } = createServer();
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[koe] listening on http://127.0.0.1:${config.port} (${config.provider}, ${config.mode})`);
  });
}
