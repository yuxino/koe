// Regression: both halves of the live-caption path stay on the critical path.
// - ASR drafts reach the page immediately.
// - Translation uses qwen-mt-flash incremental SSE for draft and durable units.
// - A durable unit aborts an obsolete in-flight draft and starts without a fixed wait.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (rounds = 8) => {
  for (let index = 0; index < rounds; index += 1) await flush();
};

function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    body: null,
    json: async () => ({ output: { choices: [{ message: { content } }] } })
  };
}

function sseResponse(contents) {
  const wireText = contents.map((content) =>
    `data: ${JSON.stringify({ output: { choices: [{ message: { content } }] } })}\n\n`
  ).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(wireText);
  // Deliberately split inside JSON and event separators to exercise transport framing.
  const cuts = [7, 31, 58, 103, bytes.length];
  const encoded = [];
  let start = 0;
  for (const end of cuts) {
    if (end > start) encoded.push(bytes.slice(start, Math.min(end, bytes.length)));
    start = Math.min(end, bytes.length);
  }
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "text/event-stream" : "" },
    body: {
      getReader: () => ({
        read: async () => index < encoded.length
          ? { done: false, value: encoded[index++] }
          : { done: true, value: undefined }
      })
    },
    json: async () => ({ output: { choices: [{ message: { content: contents.join("") } }] } })
  };
}

function makeCtx(fetchImpl = async () => jsonResponse("译文")) {
  const sent = [];
  const requestedDelays = [];
  const requests = [];
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math,
    Uint8Array, DataView, Float32Array, TextDecoder, TextEncoder,
    AbortController, DOMException, performance,
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    setTimeout: (fn, delay) => {
      requestedDelays.push(Number(delay) || 0);
      return setTimeout(fn, Math.min(Number(delay) || 0, 10));
    },
    clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return fetchImpl(url, options, requests.length - 1);
    },
    WebSocket: function () {},
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    Audio: function () {},
    AudioContext: function () {},
    chrome: {
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: (message) => {
          sent.push(JSON.parse(JSON.stringify(message)));
          return Promise.resolve({ ok: true });
        },
        getURL: (file) => `chrome-extension://koe/${file}`
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8"),
    ctx,
    { filename: "offscreen.js" }
  );
  const run = (code) => vm.runInContext(code, ctx);
  run(`captureApiKey = "key"; captureTranslate = true; captureGeneration = 1;`);
  return { ctx, sent, requests, requestedDelays, run };
}

(async () => {
  {
    const h = makeCtx();
    h.run(`captureTranslate = false; handleServerDraft("The original appears now", { sentenceId: 1 });`);
    const partial = h.sent.find((message) => message.type === "CAPTURE_PARTIAL");
    check(Boolean(partial), "ASR 草稿不等稳定计时器，立即发往页面");
    check(partial?.lines?.[0]?.text === "The original appears now", "即时原文内容完整");
    h.run(`resetDraftCommitter()`);
    console.log("T1 原文即时上屏 PASS");
  }

  {
    const h = makeCtx(async () => sseResponse(["你", "好"]));
    const updates = [];
    h.ctx.onTranslationUpdate = (text) => updates.push(text);
    const translated = await h.run(`translateText("Hello", { onUpdate: onTranslationUpdate })`);
    const request = h.requests[0];
    check(request?.body?.model === "qwen-mt-flash", `实时翻译统一使用 flash（实际 ${request?.body?.model}）`);
    check(request?.body?.parameters?.incremental_output === true, "开启 DashScope 增量输出");
    check(request?.options?.headers?.["X-DashScope-SSE"] === "enable", "开启 SSE 响应");
    check(updates[0] === "你", `首个中文块在完成前可见（实际 ${JSON.stringify(updates)}）`);
    check(updates.at(-1) === "你好" && translated === "你好", "流式块正确累积为最终译文");
    console.log("T2 flash 流式首译 PASS");
  }

  {
    let releaseFirst = () => undefined;
    const h = makeCtx((url, options, index) => {
      if (index > 0) return Promise.resolve(jsonResponse("稳定译文"));
      return new Promise((resolve, reject) => {
        let settled = false;
        releaseFirst = () => {
          if (settled) return;
          settled = true;
          resolve(jsonResponse("过期草稿"));
        };
        options.signal?.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });

    h.run(`scheduleDraftTranslation("obsolete draft", 1, { sentenceId: 1 })`);
    await settle();
    check(h.requests.length === 1, "草稿翻译立即启动");

    h.run(`scheduleUnitTranslation("authoritative unit.", 2, { sentenceId: 1 })`);
    await settle();
    const draftRequest = h.requests[0];
    check(draftRequest?.options?.signal?.aborted === true, "稳定句中止正在执行的过期草稿");
    check(h.requests.length >= 2, "稳定句不等待旧草稿完成，立即开始翻译");
    check(h.requests[1]?.body?.model === "qwen-mt-flash", "稳定句也使用 flash 首次准确翻译");
    check(!h.requestedDelays.includes(700), "正常翻译路径没有固定 700ms 等待");

    const unitMessages = h.sent.filter((message) => message.type === "CAPTURE_TRANSLATED" && message.seq === 2);
    check(unitMessages.some((message) => message.streaming === true && message.unit === false),
      "流式中文先作为当前草稿更新，不提前冻结稳定行");
    check(unitMessages.some((message) => message.streaming === false && message.unit === true
      && message.lines[0].translated === "稳定译文"), "完整中文到达后才冻结稳定行");

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    console.log("T3 稳定句抢占草稿 PASS");
  }

  console.log(fail === 0 ? "translation-latency 回归全部通过" : `${fail} 项失败`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
