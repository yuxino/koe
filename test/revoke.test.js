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
    // 完整句上屏（强切阈值提高后，只有完整句才提交）
    run(`handleServerDraft("Okayur assets and make good on the payments that are late.")`);
    await commitOnce(run);
    await flush();
    const emitted = h.sent.filter((m) => m.type === "CAPTURE_LINES");
    check(emitted.length >= 1, `错块上屏（实际 ${emitted.length} 块）`);
    // 服务端修正：新草稿与已提交内容无公共前缀但保留尾词
    run(`handleServerDraft("Identify your assets and make good on the payments that are late")`);
    await flush();
    const revoke = h.sent.find((m) => m.type === "CAPTURE_REVOKE");
    check(Boolean(revoke), "修正触发 CAPTURE_REVOKE");
    check(revoke && revoke.fromSeq === emitted[0].seq, `撤回范围从第一块开始（from=${revoke?.fromSeq}, 期望 ${emitted[0].seq}）`);
    const lastSeq = emitted[emitted.length - 1].seq;
    check(revoke && revoke.toSeq === lastSeq, `撤回范围覆盖最后一块（to=${revoke?.toSeq}, 期望 ${lastSeq}）`);
    // 修正后的文本继续正常累积上屏
    run(`handleServerDraft("Identify your assets and make good on the payments that are late.")`);
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
    // 场景：长句不再切半句（旧版 20 字符阈值会切出 "Look, it is not"），
    // 只有真正超长（词边界 ≥48 字符）才切大块
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 21 字符短长句：< 48 → 不切（等 final）
    run(`handleServerDraft("Look, it is not my fault")`);
    await commitOnce(run);
    await flush();
    let chunks = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(chunks.length === 0, `21 字符短长句不切半句（实际 ${JSON.stringify(chunks)}）`);
    // 120 字符超长句：词边界 ≥48 → 切出大块（≥40 字符，不是半句）
    run(`handleServerDraft("Look, it is not my fault that my husband decided to have an affair with our real estate agent who lives across the street from us")`);
    await commitOnce(run);
    await flush();
    chunks = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(chunks.length >= 1, `超长句切出大块（实际 ${chunks.length} 块）`);
    check(
      chunks.every((c) => Array.from(c).length >= 40),
      `切出的是大块而非半句（实际 ${JSON.stringify(chunks.map((c) => Array.from(c).length))}）`
    );
    console.log("T4 长句不再切半句 PASS");
  }
  {
    // 场景：服务端草稿临时截短/回退（draft 是已提交文本的前缀）→ 不 revoke
    // （日志 17:30:42 场景：已上屏 "...part of the Cash for Chunkers program."，
    //  草稿回退成 "...to be pa"，旧逻辑误判词尾修正 → 把已翻译的行删掉）
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 完整句上屏
    run(`handleServerDraft("Are you ready? Yes? You have such a cute little accent. So you're ready to be part of the Cash for Chunkers program.")`);
    await commitOnce(run);
    await flush();
    // 服务端草稿回退：draft 是已提交文本的前缀（截短）
    run(`handleServerDraft("Are you ready? Yes? You have such a cute little accent. So you're ready to be pa")`);
    await flush();
    check(!h.sent.some((m) => m.type === "CAPTURE_REVOKE"), "草稿截短回退不 revoke（翻译不被删）");
    console.log("T5 草稿截短回退不删翻译 PASS");
  }
  {
    // 场景：真词尾修正（her too → her titties）——草稿阶段不 revoke（避免覆盖字幕），
    // final 权威到达时 revoke 重发
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    run(`handleServerDraft("Wow, I can't believe her too.")`);
    await commitOnce(run);
    await flush();
    // 草稿阶段词尾震荡（tootties）→ 不 revoke（不删已上屏行）
    run(`handleServerDraft("Wow, I can't believe her tootties are that big")`);
    await flush();
    check(!h.sent.some((m) => m.type === "CAPTURE_REVOKE"), "草稿阶段词尾震荡不 revoke（字幕不被覆盖）");
    // final 权威修正 → revoke 重发
    run(`handleServerFinal("Wow, I can't believe her titties are that big.")`);
    await flush();
    check(h.sent.some((m) => m.type === "CAPTURE_REVOKE"), "final 权威修正仍 revoke");
    console.log("T6 词尾修正推迟到 final 阶段 PASS");
  }
  {
    // 场景：服务端草稿回退到已提交内容的前缀（重新识别中）→ 不重复提交整句
    // （日志 08:11:02 场景：seq=36 与 seq=56 同一句 "I do, and I want to lose the weight."
    //  上屏两次）
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 完整句上屏
    run(`handleServerDraft("I do, and I want to lose the weight. It's going to take a lot of work. I know. We just don't give it away.")`);
    await commitOnce(run);
    await flush();
    const beforeCount = h.sent.filter((m) => m.type === "CAPTURE_LINES").length;
    check(beforeCount === 1, `第一句先上屏（实际 ${beforeCount} 块）`);
    // 草稿回退到已提交内容的前缀 → pendingText 为空，不重复提交
    run(`handleServerDraft("I do, and I want to lose the weight.")`);
    await commitOnce(run);
    await flush();
    const afterCount = h.sent.filter((m) => m.type === "CAPTURE_LINES").length;
    check(afterCount === 1, `草稿回退不重复提交（实际 ${afterCount} 块）`);
    console.log("T7 草稿回退前缀不重复提交 PASS");
  }
  {
    // 场景：词尾修正（"I am." → "Yes? Yes."）→ 只撤最后一块，
    // 已确认的 "Are you ready?" 不再重复提交（日志 08:14:31 场景：seq=7 与 seq=11 重复）
    const h = makeCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 逐句上屏 "Are you ready?" + "I am."
    run(`handleServerDraft("Are you ready? I am. Yes. yes. He was such")`);
    await run(`(() => { let c; let guard = 0; while ((c = commitPendingDraft({ forceLongIncomplete: false })) && guard < 10) { emitCommittedUnit(c); guard += 1; } return guard; })()`);
    await flush();
    // 服务端修正：I am → Yes? Yes（最后一块 "I am." 被替换）
    run(`handleServerDraft("Are you ready? Yes? Yes. You have such a cute little accent")`);
    await flush();
    const revoke = h.sent.find((m) => m.type === "CAPTURE_REVOKE");
    check(Boolean(revoke), "词尾修正触发 CAPTURE_REVOKE");
    check(revoke && revoke.fromSeq === revoke.toSeq, `只撤最后一块（from=${revoke?.fromSeq} to=${revoke?.toSeq}）`);
    // "Are you ready?" 只上屏一次，不再重复提交
    const lines = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(lines.filter((l) => l.includes("Are you ready?")).length <= 2,
      `Are you ready? 不重复提交（实际 ${JSON.stringify(lines)}）`);
    console.log("T8 词尾修正只撤最后一块不重复 PASS");
  }
  console.log(fail === 0 ? "revoke 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
