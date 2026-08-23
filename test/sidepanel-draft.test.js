// 回归：侧边栏草稿体验 ——
// 翻译模式：原文草稿弱化显示做即时反馈（raw），译文到达替换（translated），
// 译文展示 5 秒内原文不打扰；识别修正时草稿加 correcting 过渡类。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };

function makeElement(tag) {
  const el = {
    tag, textContent: "", className: "", dataset: {}, hidden: false,
    isConnected: true, offsetWidth: 0, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    listeners: {}, children: [],
    classList: {
      classes: new Set(),
      add: (c) => el.classList.classes.add(c),
      remove: (c) => el.classList.classes.delete(c),
      toggle: (c, v) => { if (v === undefined) v = !el.classList.classes.has(c); v ? el.classList.classes.add(c) : el.classList.classes.delete(c); },
      contains: (c) => el.classList.classes.has(c)
    },
    addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
    appendChild: (child) => { el.children.push(child); return child; },
    remove: () => { el.isConnected = false; },
    querySelector: (sel) => {
      const name = sel.replace(/^\./, "");
      let found = el.children.find((c) => c.className === name || c.tag === sel);
      if (!found) {
        found = makeElement(name);
        found.className = name;
        el.appendChild(found);
      }
      return found;
    },
    querySelectorAll: () => []
  };
  return el;
}

function makeCtx() {
  const els = {};
  const feed = makeElement("feed");
  feed.children = [];
  feed.querySelectorAll = () => [];
  const messageListeners = [];
  const domReadyListeners = [];

  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, Set, Intl, setTimeout, clearTimeout,
    window: {
      addEventListener: (ev, fn) => { if (ev === "error" || ev === "unhandledrejection") return; },
      setTimeout: (fn, delay) => { setTimeout(fn, Number(delay) || 0); return 0; },
      clearTimeout: () => undefined
    },
    document: {
      querySelector: (sel) => {
        if (sel === "#feed") return feed;
        if (!els[sel]) els[sel] = makeElement(sel);
        return els[sel];
      },
      createElement: (tag) => makeElement(tag),
      addEventListener: (ev, fn) => { if (ev === "DOMContentLoaded") domReadyListeners.push(fn); }
    },
    navigator: { clipboard: { writeText: async () => undefined } },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.6.11" }),
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        sendMessage: async () => ({ ok: true })
      },
      storage: { local: { get: async () => ({}), set: async () => undefined } },
      tabs: { onActivated: { addListener: () => undefined }, query: async () => [] },
      windows: { getLastFocused: async () => [] }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8"), ctx, { filename: "sidepanel.js" });
  return { ctx, els, feed, messageListeners, domReadyListeners };
}

function sendMessage(h, message) {
  for (const fn of h.messageListeners) fn(message);
}

// 取草稿行的可见文本（.text 子元素）
function draftText(feed) {
  const draft = feed.children[0];
  if (!draft) return "";
  const textEl = draft.children.find((c) => c.className === "text");
  return textEl ? textEl.textContent : "";
}

// raw 草稿防抖 300ms + correcting 过渡 320ms，等足再断言
const WAIT = 380;

(async () => {
  {
    // 场景：翻译模式 —— 原文草稿先显示（防抖后），译文到达立即替换，译文展示期原文不打扰
    const h = makeCtx();
    h.els["#translate-toggle"].checked = true;
    // 第一条带 jobId 的消息触发接管
    sendMessage(h, { type: "LIVE_STATE", jobId: "live-1", status: "live", translate: true });
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-1", seq: 1, lines: [{ text: "Okayur assets and make" }] });
    // raw 草稿防抖 300ms 后才显示
    await new Promise((r) => setTimeout(r, WAIT));
    check(h.feed.children.length === 1, "翻译模式原文草稿行出现");
    const draft = h.feed.children[0];
    check(draft.dataset.kind === "raw", `原文草稿 kind=raw（实际 ${draft.dataset.kind}）`);
    check(draftText(h.feed).includes("Okayur assets"), "原文草稿内容正确");
    // 译文到达：立即替换为 translated
    sendMessage(h, { type: "LIVE_TRANSLATED", jobId: "live-1", seq: 1, lines: [{ text: "Okayur assets and make", translated: "奥凯尤尔资产并让" }] });
    check(draft.dataset.kind === "translated", `译文替换后 kind=translated（实际 ${draft.dataset.kind}）`);
    check(draftText(h.feed).includes("奥凯尤尔资产并让"), "译文草稿内容正确");
    // 译文展示期：原文草稿不打扰（5 秒内不覆盖译文）
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-1", seq: 2, lines: [{ text: "Identify your assets and make good" }] });
    await new Promise((r) => setTimeout(r, WAIT));
    check(draftText(h.feed).includes("奥凯尤尔资产并让"), "译文展示期原文不覆盖（保持译文）");
    console.log("T1 翻译模式: 原文草稿 → 译文替换 → 不打扰 PASS");
  }
  {
    // 场景：翻译关闭 —— 原文草稿正常显示（防抖后）
    const h = makeCtx();
    h.els["#translate-toggle"].checked = false;
    sendMessage(h, { type: "LIVE_STATE", jobId: "live-2", status: "live", translate: false });
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-2", seq: 1, lines: [{ text: "Hey there" }] });
    await new Promise((r) => setTimeout(r, WAIT));
    check(h.feed.children.length === 1, "原文模式草稿行出现");
    check(draftText(h.feed).includes("Hey there"), "原文草稿内容正确");
    console.log("T2 原文模式草稿正常 PASS");
  }
  {
    // 场景：识别修正 —— 草稿文本互不包含时加 correcting 过渡类
    const h = makeCtx();
    h.els["#translate-toggle"].checked = false;
    sendMessage(h, { type: "LIVE_STATE", jobId: "live-3", status: "live", translate: false });
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-3", seq: 1, lines: [{ text: "Okayur assets and make" }] });
    await new Promise((r) => setTimeout(r, WAIT));
    // 服务端整体换词：互不包含 → correcting（8ms 后自动移除）
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-3", seq: 2, lines: [{ text: "Identify your assets and make good" }] });
    await new Promise((r) => setTimeout(r, WAIT));
    const draft = h.feed.children[0];
    check(draft.classList.contains("correcting"), "修正时草稿加 correcting 过渡类");
    // 等过渡类自动移除后再发正常延伸 → 不加 correcting
    await new Promise((r) => setTimeout(r, WAIT));
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-3", seq: 3, lines: [{ text: "Identify your assets and make good on" }] });
    await new Promise((r) => setTimeout(r, WAIT));
    check(!draft.classList.contains("correcting"), "正常延伸不加 correcting（过渡类已移除）");
    console.log("T3 草稿修正过渡 PASS");
  }
  {
    // 场景：会话 translate=false 但开关偏好开 → 自动补发 SET_TRANSLATE(true) 对齐，
    // 开关不被会话值改掉（"每次切过去重置翻译"的修复）
    const h = makeCtx();
    const sent = [];
    h.els["#translate-toggle"].checked = true; // 用户偏好：开
    h.ctx.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === "GET_STATE") return { ok: true, state: { status: "live", translate: false, tabId: 9, captureActive: true } };
      sent.push(msg);
      return { ok: true };
    };
    await vm.runInContext(`refreshState()`, h.ctx);
    check(h.els["#translate-toggle"].checked === true, `开关保持用户偏好（不被会话值改掉）`);
    const sync = sent.find((m) => m.type === "SET_TRANSLATE");
    check(Boolean(sync) && sync.translate === true && sync.tabId === 9,
      `自动补发 SET_TRANSLATE(true) 给会话 tab 9（实际 ${JSON.stringify(sync)}）`);
    console.log("T4 偏好开→会话自动对齐, 开关不被重置 PASS");
  }
  {
    // 场景：稳定句翻译失败（空译文）时，不能把这一句整个吞掉。
    const h = makeCtx();
    h.els["#translate-toggle"].checked = true;
    sendMessage(h, { type: "LIVE_SUBTITLES", jobId: "live-5", seq: 7, unit: true, lines: [{ text: "Translation failed, keep me." }] });
    sendMessage(h, { type: "LIVE_TRANSLATED", jobId: "live-5", seq: 7, unit: true, lines: [{ text: "Translation failed, keep me.", translated: "" }] });
    const rowText = h.feed.children
      .flatMap((row) => row.children)
      .find((child) => child.className === "text")?.textContent || "";
    check(rowText.includes("Translation failed"), "空译文稳定回退原文，不丢句");
    console.log("T5 翻译失败稳定回退原文 PASS");
  }
  {
    // 场景：同一稳定句的流式中文可原地增长，完整响应到达后才转成稳定行。
    const h = makeCtx();
    h.els["#translate-toggle"].checked = true;
    sendMessage(h, { type: "LIVE_SUBTITLES", jobId: "live-6", seq: 2, unit: true, lines: [{ text: "Hello there." }] });
    sendMessage(h, { type: "LIVE_TRANSLATED", jobId: "live-6", seq: 2, unit: true, streaming: true, lines: [{ translated: "你" }] });
    sendMessage(h, { type: "LIVE_TRANSLATED", jobId: "live-6", seq: 2, unit: true, streaming: true, lines: [{ translated: "你好" }] });
    check(draftText(h.feed) === "你好", `同 seq 流式译文原地增长（实际 ${JSON.stringify(draftText(h.feed))}）`);
    sendMessage(h, { type: "LIVE_TRANSLATED", jobId: "live-6", seq: 2, unit: true, streaming: false, lines: [{ translated: "你好啊" }] });
    const row = h.feed.children[0];
    const text = row?.children.find((child) => child.className === "text")?.textContent || "";
    check(row?.className === "row" && text === "你好啊", "完整译文到达后冻结为稳定行");
    console.log("T6 流式译文同 seq 更新并冻结 PASS");
  }
  console.log(fail === 0 ? "sidepanel-draft 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
