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

function makeCtx(fetchImpl = async () => jsonResponse("译文"), { detectLanguage } = {}) {
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
      i18n: {
        detectLanguage: (text, callback) => {
          const pending = Promise.resolve(detectLanguage
            ? detectLanguage(text)
            : { isReliable: false, languages: [] });
          pending.then((result) => callback?.(result));
          return pending;
        }
      },
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
    const detections = [];
    const h = makeCtx(async () => jsonResponse("不应请求的译文"), {
      detectLanguage: async (text) => {
        detections.push(text);
        return {
          isReliable: true,
          languages: [{ language: "en", percentage: 96 }]
        };
      }
    });
    h.run(`captureSkipSameLanguage = true; capturePreferredLanguage = "en-US";`);
    h.run(`scheduleUnitTranslation("Same language caption.", 9, { sentenceId: 9 })`);
    await settle();
    const final = h.sent.find((message) => message.type === "CAPTURE_TRANSLATED"
      && message.seq === 9 && message.streaming === false);
    check(detections.length === 1, "同语言策略使用浏览器语言检测");
    check(h.requests.length === 0, "可靠且置信度足够的同语言字幕不发翻译请求");
    check(final?.lines?.[0]?.translated === "Same language caption.",
      "同语言字幕以原文 passthrough 完成稳定译文消息");
    console.log("T2b 同语言自动跳过 PASS");
  }

  {
    const h = makeCtx(async () => jsonResponse("不确定时继续翻译"), {
      detectLanguage: async () => ({
        isReliable: false,
        languages: [{ language: "en", percentage: 99 }]
      })
    });
    h.run(`captureSkipSameLanguage = true; capturePreferredLanguage = "en-US";`);
    const translated = await h.run(`translateText("Uncertain language caption.")`);
    check(h.requests.length === 1, "不可靠的语言检测不会误跳过翻译");
    check(translated === "不确定时继续翻译", "不确定时保持原翻译路径");
    console.log("T2c 不确定语言保守翻译 PASS");
  }

  {
    const h = makeCtx(async () => jsonResponse("检测超时后继续翻译"), {
      detectLanguage: () => new Promise(() => undefined)
    });
    h.run(`captureSkipSameLanguage = true; capturePreferredLanguage = "en-US";`);
    const translated = await h.run(`translateText("Language detection must not stall captions.")`);
    check(h.requests.length === 1 && translated === "检测超时后继续翻译",
      "语言检测无响应时超时回退到正常翻译");
    console.log("T2d 语言检测超时回退 PASS");
  }

  {
    let releaseOldDetection = () => undefined;
    const h = makeCtx(async () => jsonResponse("新代译文"), {
      detectLanguage: (text) => {
        if (text === "Old generation caption.") {
          return new Promise((resolve) => {
            releaseOldDetection = () => resolve({
              isReliable: true,
              languages: [{ language: "en", percentage: 99 }]
            });
          });
        }
        return Promise.resolve({ isReliable: false, languages: [] });
      }
    });
    h.run(`
      captureSkipSameLanguage = true;
      capturePreferredLanguage = "en-US";
      stream = { getTracks: () => [] };
      stopping = false;
      connectRealtime = async () => undefined;
      scheduleUnitTranslation("Old generation caption.", 31, { sentenceId: 31 });
    `);
    await settle();
    check(h.requests.length === 0, "old translation worker is paused inside language detection");

    const reset = h.run(`resetSocket()`);
    h.run(`scheduleUnitTranslation("New generation caption.", 32, { sentenceId: 32 })`);
    releaseOldDetection();
    await reset;
    await settle(16);

    const oldFinal = h.sent.find((message) => message.type === "CAPTURE_TRANSLATED"
      && message.seq === 31 && message.streaming === false);
    const newFinal = h.sent.find((message) => message.type === "CAPTURE_TRANSLATED"
      && message.seq === 32 && message.streaming === false);
    check(!oldFinal, "reset prevents the detected result from the old generation from being emitted");
    check(h.requests.length === 1
        && h.requests[0]?.body?.input?.messages?.[0]?.content === "New generation caption.",
      "old worker completion does not delete the new generation translation queue");
    check(newFinal?.lines?.[0]?.translated === "新代译文",
      "new generation translation resumes immediately after the old detector returns");
    check(h.run(`translationQueue.length === 0 && translatorRunning === false`) === true,
      "translation worker settles cleanly after crossing a reset generation");
    console.log("T2e reset during language detection PASS");
  }

  {
    const h = makeCtx(async () => jsonResponse("完整长句译文"));
    const source = "This deliberately long sentence keeps every important relationship intact so that the translation model can resolve references and meaning accurately.";
    h.run(`handleServerDraft(${JSON.stringify(source)}, { sentenceId: 7, beginTimeMs: 100, endTimeMs: 900 })`);
    await settle();
    const translatedSource = h.requests[0]?.body?.input?.messages?.[0]?.content;
    check(translatedSource === source,
      `long draft translation keeps the complete sentence (actual ${JSON.stringify(translatedSource)})`);
    console.log("T3 长句完整上下文 PASS");
  }

  {
    const h = makeCtx(async () => jsonResponse("完整最终译文"));
    const source = "This authoritative final remains a complete semantic sentence even when its visual representation needs to fit inside a compact subtitle overlay.";
    h.run(`emitFinalSentences(${JSON.stringify(source)}, { sentenceId: 8, beginTimeMs: 1_000, endTimeMs: 7_000 })`);
    await settle();
    check(h.requests.length === 1, `one final sentence starts one translation request (actual ${h.requests.length})`);
    check(h.requests[0]?.body?.input?.messages?.[0]?.content === source,
      "the authoritative final reaches translation without display-boundary truncation");
    console.log("T4 最终句完整上下文 PASS");
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
    check(unitMessages.some((message) => message.streaming === true && message.unit === true),
      "稳定句的首个流式中文保留 unit 归属，页面可以立即显示");
    check(unitMessages.some((message) => message.streaming === false && message.unit === true
      && message.lines[0].translated === "稳定译文"), "完整中文到达后才冻结稳定行");

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    console.log("T5 稳定句抢占草稿 PASS");
  }

  console.log(fail === 0 ? "translation-latency 回归全部通过" : `${fail} 项失败`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
