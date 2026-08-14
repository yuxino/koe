// 回归：
// T1 final appended 不重复上屏 —— 已上屏 "Oh shit, she's coming." 后，
// final 整段到达，只补发新增后缀（日志里 seq=29 → seq=31 整段重复的实锤场景）。
// T2 并发 appendLog 不丢日志 —— 多条 KOE_LOG 同时到达时串行写入，一条不丢。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const flush = () => new Promise((r) => setImmediate(r));

function makeOffCtx() {
  const sent = [];
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, Uint8Array, DataView, Float32Array,
    window: { addEventListener: () => undefined, removeEventListener: () => undefined },
    setTimeout: (fn, d) => { setTimeout(fn, Math.min(Number(d) || 0, 20)); return 0; },
    clearTimeout, setInterval: () => 0, clearInterval: () => undefined,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    fetch: async () => ({ ok: true, json: async () => ({ output: { choices: [{ message: { content: "" } }] } }) }),
    WebSocket: function () {
      const self = this;
      this.readyState = 1; this.binaryType = "";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.send = () => undefined;
      this.close = () => { this.readyState = 3; };
      setTimeout(() => { if (self.onopen) self.onopen(); }, 0);
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
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

(async () => {
  {
    // T1：先上屏客户端块，final 整段到达 → 只补发新增后缀
    const h = makeOffCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 客户端强切上屏 "Oh shit, she's coming."
    run(`handleServerDraft("Oh shit, she's coming. Yeah. Yeah. No, you wait, see you later.")`);
    await run(`(() => { const c = commitPendingDraft({ forceLongIncomplete: true }); if (c) emitCommittedUnit(c); return c; })()`);
    await flush();
    const before = h.sent.filter((m) => m.type === "CAPTURE_LINES").length;
    check(before === 1, `客户端块先上屏（实际 ${before} 块）`);
    // 服务端 final 整段到达（含已上屏部分 + 更多）→ 按句切块，已上屏的跳过
    run(`handleServerFinal("Oh shit, she's coming. Yeah. Yeah. No, you wait, see you later. Okay. Okay. Bye.")`);
    await flush();
    const units = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    // 已上屏的 "Oh shit, she's coming." 不重复；其余按句切块逐条上屏
    check(units.filter((u) => u.includes("Oh shit, she's coming")).length === 1,
      `已上屏部分不重复（实际 ${JSON.stringify(units)}）`);
    check(units.some((u) => u === "Yeah."), "新增部分按句切块（Yeah.）");
    check(units.some((u) => u.includes("see you later")), "新增部分包含后续句");
    check(units.some((u) => u === "Bye."), "结尾句单独成块（Bye.）");
    console.log("T1 final 按句切块 + 不重复 PASS");
  }
  {
    // T2：并发 appendLog 不丢日志
    const store = { koeLogs: [] };
    const ctx = {
      console, Date, JSON, String, Number, Boolean, Promise, Math, URL,
      setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
      chrome: {
        storage: {
          local: {
            get: async (k) => { const out = {}; for (const key of [].concat(k)) out[key] = store[key]; return out; },
            set: async (obj) => { Object.assign(store, obj); }
          },
          session: { get: async () => ({}), set: async () => undefined }
        },
        tabs: {
          query: async () => [], get: async () => ({}),
          onRemoved: { addListener: () => undefined }, onUpdated: { addListener: () => undefined }, onActivated: { addListener: () => undefined }
        },
        runtime: {
          onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
          onInstalled: { addListener: () => undefined }, sendMessage: async () => undefined
        },
        contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
        commands: { onCommand: { addListener: () => undefined } },
        sidePanel: { open: async () => undefined, setOptions: async () => undefined, setPanelBehavior: async () => undefined },
        action: { setPopup: async () => undefined, setBadgeText: async () => undefined },
        tabCapture: { getMediaStreamId: async () => "s" },
        alarms: { onAlarm: { addListener: () => undefined } },
        scripting: { executeScript: async () => [] },
        webNavigation: undefined
      },
      fetch: async () => ({ ok: true })
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx, { filename: "background.js" });
    // 不等待、同时触发 20 条日志
    for (let i = 1; i <= 20; i += 1) {
      vm.runInContext(`appendLog({ event: "evt-${i}", detail: "d-${i}", ts: ${i} })`, ctx);
    }
    await flush();
    await flush();
    const got = await vm.runInContext(`getLogs()`, ctx);
    check(got.logs.length === 20, `并发 20 条日志全保留（实际 ${got.logs.length}）`);
    check(got.logs[0].event === "evt-1" && got.logs[19].event === "evt-20", "并发日志顺序完整");
    console.log("T2 并发 appendLog 不丢日志 PASS");
  }
  {
    // T3：final 前缀修正（"her too" → "her titties"）→ 撤回整句 + 重发权威版
    const h = makeOffCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 客户端完整句上屏 "Wow, I can't believe her too."（错误前缀）
    run(`handleServerDraft("Wow, I can't believe her too.")`);
    await run(`(() => { const c = commitPendingDraft({ forceLongIncomplete: true }); if (c) emitCommittedUnit(c); return c; })()`);
    await flush();
    // 草稿阶段词尾震荡（tootties）→ 不 revoke（v1.6.23：草稿阶段不再因词尾微调删行）
    run(`handleServerDraft("Wow, I can't believe her tootties are that big")`);
    await flush();
    check(!h.sent.some((m) => m.type === "CAPTURE_REVOKE"), "草稿阶段词尾震荡不 revoke");
    // 服务端 final 权威版到达 → final-fix revoke + 切块上屏
    run(`handleServerFinal("Wow, I can't believe her titties are that big.")`);
    await flush();
    const revoke = h.sent.find((m) => m.type === "CAPTURE_REVOKE");
    check(Boolean(revoke), "final 权威修正触发 CAPTURE_REVOKE");
    const lines = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(lines.some((l) => l === "Wow, I can't believe her titties are that big."),
      `权威修正版重新上屏（实际 ${JSON.stringify(lines)}）`);
    // 模拟侧边栏应用 revoke：删除 [fromSeq, toSeq] 范围的行后，错误前缀不再残留
    const badSeq = h.sent.find((m) => m.type === "CAPTURE_LINES" && m.lines[0].text.includes("her too") && !m.lines[0].text.includes("titties"))?.seq;
    check(Boolean(badSeq) && revoke.fromSeq <= badSeq && revoke.toSeq >= badSeq,
      `revoke 范围覆盖错误行（badSeq=${badSeq}, revoke=${revoke.fromSeq}..${revoke.toSeq}）`);
    console.log("T3 词尾修正 revoke + 重发 PASS");
  }
  {
    // T4：pendingText 清理前导标点（draft 尾巴不以 "." 开头）
    const h = makeOffCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 已提交 "Oh shit, she's coming"（无句号），新草稿从 "." 开始
    run(`handleServerDraft("Oh shit, she's coming")`);
    await run(`(() => { const c = commitPendingDraft({ forceLongIncomplete: true }); if (c) emitCommittedUnit(c); return c; })()`);
    await flush();
    run(`handleServerDraft("Oh shit, she's coming. Yeah.. No")`);
    await flush();
    const partials = h.sent.filter((m) => m.type === "CAPTURE_PARTIAL").map((m) => m.lines[0].text);
    check(partials.every((t) => !t.startsWith(".") && !t.startsWith("。")),
      `草稿尾巴不以标点开头（实际 ${JSON.stringify(partials)}）`);
    console.log("T4 前导标点清理 PASS");
  }
  {
    // T5：final 是 committedText 的正常延伸（多一句）→ 不 revoke，只补发新增
    // （日志 17:07:55 场景：final 多出 "You want that stimulus check?"，
    //  旧逻辑误判修正把已上屏 7 块全撤重发 → 大闪）
    const h = makeOffCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 客户端上屏完整句
    run(`handleServerDraft("Are you ready? Yes? You have such a cute little accent. So you're ready to be part of the Cash for Chunkers program?")`);
    await run(`(() => { const c = commitPendingDraft({ forceLongIncomplete: false }); if (c) emitCommittedUnit(c); return c; })()`);
    await flush();
    const beforeCount = h.sent.filter((m) => m.type === "CAPTURE_LINES").length;
    check(beforeCount >= 1, `客户端完整句先上屏（实际 ${beforeCount} 块）`);
    // final 只是延伸（多一句）→ 不 revoke，只补发新增
    run(`handleServerFinal("Are you ready? Yes? You have such a cute little accent. So you're ready to be part of the Cash for Chunkers program? You want that stimulus check?")`);
    await flush();
    const revoke = h.sent.find((m) => m.type === "CAPTURE_REVOKE");
    check(!revoke, "final 正常延伸不触发 revoke");
    const afterLines = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(afterLines.some((l) => l.includes("You want that stimulus check")),
      `只补发新增句（实际 ${JSON.stringify(afterLines)}）`);
    console.log("T5 final 正常延伸只补发新增 PASS");
  }
  {
    // T6：多句已上屏后，final 只差一个标点（program. → program?）→ 不 revoke、不重发
    // （日志 17:12:59 场景：revoke from=19 to=33 把 11 句全撤原样重发 = "字幕刷两遍"）
    const h = makeOffCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 客户端逐句上屏（多句）
    run(`handleServerDraft("Well, here we are. Are you ready? I am. Yes? Yes. You have such a cute little accent. Thank you. So you're ready to be part of the cash for chunkers program. Yep.")`);
    await run(`(() => { let c; let guard = 0; while ((c = commitPendingDraft({ forceLongIncomplete: false })) && guard < 20) { emitCommittedUnit(c); guard += 1; } return guard; })()`);
    await flush();
    const before = h.sent.filter((m) => m.type === "CAPTURE_LINES").length;
    check(before >= 3, `多句先上屏（实际 ${before} 块）`);
    // final：同样内容，但 program. → program?（仅标点差异）
    run(`handleServerFinal("Well, here we are. Are you ready? I am. Yes? Yes. You have such a cute little accent. Thank you. So you're ready to be part of the cash for chunkers program? Yep. Yes? Yes. You want that stimulus check?")`);
    await flush();
    const revoke = h.sent.find((m) => m.type === "CAPTURE_REVOKE");
    check(!revoke, "仅标点差异不触发 revoke");
    const lines = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(lines.filter((l) => l === "Well, here we are.").length === 1,
      `已上屏句子不重发（实际 ${JSON.stringify(lines)}）`);
    check(lines.some((l) => l.includes("You want that stimulus check")),
      `只补发差异部分（实际 ${JSON.stringify(lines.slice(-3))}）`);
    console.log("T6 仅标点差异不重发 PASS");
  }
  {
    // T7：多句已上屏后，final 是整体前缀延伸（多出几句）→ 只补发新增尾巴
    // （日志 17:26:56 场景：客户端上屏 15 块后 final 整段到达，
    //  suffixOverlap 算出 0 → 整段重发 = 字幕刷两遍）
    const h = makeOffCtx();
    const run = (code) => vm.runInContext(code, h.ctx);
    await run(`startCapture({ streamId: "s1", translate: false, apiKey: "k", source: "tab", engine: "dashscope" }).catch(e => ({ok:false}))`);
    await flush();
    // 客户端逐句上屏（15 块）
    run(`handleServerDraft("All right. Bring it down to your chest and up. One quick motion. Perfect. And up. Very good. Let's do six of those. Come on. Two. Excellent. Three.")`);
    await run(`(() => { let c; let guard = 0; while ((c = commitPendingDraft({ forceLongIncomplete: false })) && guard < 20) { emitCommittedUnit(c); guard += 1; } return guard; })()`);
    await flush();
    const before = h.sent.filter((m) => m.type === "CAPTURE_LINES").length;
    check(before >= 5, `多块先上屏（实际 ${before} 块）`);
    // final 整体延伸：多出 "Very nice. Four."
    run(`handleServerFinal("All right. Bring it down to your chest and up. One quick motion. Perfect. And up. Very good. Let's do six of those. Come on. Two. Excellent. Three. Very nice. Four.")`);
    await flush();
    const revoke = h.sent.find((m) => m.type === "CAPTURE_REVOKE");
    check(!revoke, "整体前缀延伸不触发 revoke");
    const lines = h.sent.filter((m) => m.type === "CAPTURE_LINES").map((m) => m.lines[0].text);
    check(lines.filter((l) => l === "All right.").length === 1,
      `已上屏句子不重发（实际 ${JSON.stringify(lines)}）`);
    check(lines.filter((l) => l === "Two.").length === 1, "数字句不重发");
    check(lines.some((l) => l === "Very nice.") && lines.some((l) => l === "Four."),
      `只补发新增尾巴（实际 ${JSON.stringify(lines.slice(-4))}）`);
    console.log("T7 整体前缀延伸只补发尾巴 PASS");
  }
  console.log(fail === 0 ? "final-append/log-race 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
