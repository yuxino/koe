// 回归：识别修正撤回 —— 服务端把已上屏的句子整体换词时，
// 按范围撤回当前句子的字幕块（CAPTURE_REVOKE fromSeq..toSeq），修正文本重新累积。
// 用日志里的真实序列：draft "Okayur assets..." 上屏后修正为 "Identify your assets..."。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const flush = () => new Promise((r) => setImmediate(r));

function makeCtx() {
  const sent = [];
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, Uint8Array, DataView, Float32Array,
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    setTimeout: (fn, d) => { setTimeout(fn, Math.min(Number(d) || 0, 20)); return 0; },
    clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.input.messages.find((m) => m.role === "user")?.content || "";
      return { ok: true, json: async () => ({ output: { choices: [{ message: { content: `译:${text}` } }] } }) };
    },
    WebSocket: function () {
      const self = this;
      this.readyState = 1; this.binaryType = "";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.send = (payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.header && parsed.header.action === "run-task") {
          setTimeout(() => {
            if (self.onmessage) self.onmessage({ data: JSON.stringify({ header: { event: "task-started", task_id: parsed.header.task_id }, payload: {} }) });
          }, 0);
        }
      };
      this.close = () => { this.readyState = 3; };
      setTimeout(() => { if (self.onopen) self.onopen(); }, 0);
    },
    navigator: {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
    },
    Audio: function () { this.srcObject = null; this.play = () => Promise.resolve(); this.pause = () => undefined; },
    AudioContext: function () {
      this.state = "running"; this.sampleRate = 16000; this.destination = {};
      this.resume = async () => undefined; this.close = async () => undefined;
      this.createMediaStreamSource = () => ({ connect() {}, channelCount: 1, channelCountMode: "", channelInterpretation: "" });
      this.createScriptProcessor = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
      this.createGain = () => ({ gain: { value: 0 }, connect() {} });
    },
    chrome: {
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return Promise.resolve({ ok: true }); },
        getURL: (p) => `chrome-extension://koe/${p}`
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8"), ctx, { filename: "offscreen.js" });
  return { ctx, sent };
}

async function commitOnce(run) {
  // 模拟一次定时器触发：切块 + 上屏
  await run(`(() => { const c = commitPendingDraft({ forceLongIncomplete: true }); if (c) emitCommittedUnit(c); return c; })()`);
}

(async () => {
  {
    // 场景：草稿积累 → 上屏错块 → 服务端整体修正 → 按范围撤回全部已上屏块
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    run(`handleServerDraft("Okayur assets and make good on the payments")`);
    await commitOnce(run); // 强切（英文阈值下可能是一整块）
    await commitOnce(run); // 若还有剩余，再切
    await flush();
    const emitted = h.sent.filter((m) => m.type === "CAPTURE_LINES");
    check(emitted.length >= 1, `错块上屏（实际 ${emitted.length} 块）`);
    // 服务端修正：新草稿与已提交内容无公共前缀
    run(`handleServerDraft("Identify your assets and make good on the payments that are late")`);
    await flush();
    const revoke = h.sent.find((m) => m.type === "CAPTURE_REVOKE");
    check(Boolean(revoke), "修正触发 CAPTURE_REVOKE");
    check(revoke && revoke.fromSeq === emitted[0].seq, `撤回范围从第一块开始（from=${revoke?.fromSeq}, 期望 ${emitted[0].seq}）`);
    const lastSeq = emitted[emitted.length - 1].seq;
    check(revoke && revoke.toSeq === lastSeq, `撤回范围覆盖最后一块（to=${revoke?.toSeq}, 期望 ${lastSeq}）`);
    // 修正后的文本继续正常累积上屏
    run(`handleServerDraft("Identify your assets and make good on the payments that are late")`);
    await commitOnce(run);
    await flush();
    const after = h.sent.filter((m) => m.type === "CAPTURE_LINES");
    check(after.some((m) => m.lines[0].text.includes("Identify")), "修正文本重新上屏: Identify your assets");
    console.log("T1 识别修正按范围撤回 PASS");
  }
  {
    // 场景：正常延伸不触发撤回（draft 是 committedText 的前缀延伸）
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    run(`handleServerDraft("Look, it is not my fault")`);
    await commitOnce(run);
    await flush();
    run(`handleServerDraft("Look, it is not my fault that my husband")`);
    await flush();
    check(!h.sent.some((m) => m.type === "CAPTURE_REVOKE"), "正常延伸不撤回");
    console.log("T2 正常延伸不误撤回 PASS");
  }
  {
    // 场景：翻译只译首句（译文不再比字幕多，修复日志里"离婚代价高昂"错位）
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: true, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    run(`handleServerDraft("my husband decided to have an affair with our real estate agent. Divorces are expensive")`);
    await flush();
    // 翻译请求已发出：查 CAPTURE_TRANSLATED 的原文，应只含首句
    const translated = h.sent.find((m) => m.type === "CAPTURE_TRANSLATED");
    check(Boolean(translated), "草稿翻译已发出");
    check(
      translated && translated.lines[0].text === "my husband decided to have an affair with our real estate agent.",
      `草稿翻译只译首句（实际 ${JSON.stringify(translated?.lines[0]?.text)}）`
    );
    console.log("T3 翻译对齐首句 PASS");
  }
  {
    // 场景：英文长句强切整体出块（不再切成 "Look, it is not" 这种半句）
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    run(`handleServerDraft("Look, it is not my fault that my husband decided to have an affair")`);
    await commitOnce(run); // 2s 强切
    await flush();
    const chunks = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(chunks.length >= 1, `英文长句强切出块（实际 ${chunks.length} 块）`);
    check(
      chunks.some((c) => c.includes("Look, it is not my fault")),
      `英文长句按 20 字符阈值切出完整开头（实际 ${JSON.stringify(chunks)}）`
    );
    console.log("T4 英文碎块减少 PASS");
  }
  console.log(fail === 0 ? "revoke 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
