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
      setTimeout: (fn) => { setTimeout(fn, 8); return 0; },
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

(async () => {
  {
    // 场景：翻译模式 —— 原文草稿先显示，译文到达替换，译文展示期原文不打扰
    const h = makeCtx();
    h.els["#translate-toggle"].checked = true;
    // 第一条带 jobId 的消息触发接管
    sendMessage(h, { type: "LIVE_STATE", jobId: "live-1", status: "live", translate: true });
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-1", seq: 1, lines: [{ text: "Okayur assets and make" }] });
    check(h.feed.children.length === 1, "翻译模式原文草稿行出现");
    const draft = h.feed.children[0];
    check(draft.dataset.kind === "raw", `原文草稿 kind=raw（实际 ${draft.dataset.kind}）`);
    check(draftText(h.feed).includes("Okayur assets"), "原文草稿内容正确");
    // 译文到达：替换为 translated
    sendMessage(h, { type: "LIVE_TRANSLATED", jobId: "live-1", seq: 1, lines: [{ text: "Okayur assets and make", translated: "奥凯尤尔资产并让" }] });
    check(draft.dataset.kind === "translated", `译文替换后 kind=translated（实际 ${draft.dataset.kind}）`);
    check(draftText(h.feed).includes("奥凯尤尔资产并让"), "译文草稿内容正确");
    // 译文展示期：原文草稿不打扰（5 秒内不覆盖译文）
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-1", seq: 2, lines: [{ text: "Identify your assets and make good" }] });
    check(draftText(h.feed).includes("奥凯尤尔资产并让"), "译文展示期原文不覆盖（保持译文）");
    console.log("T1 翻译模式: 原文草稿 → 译文替换 → 不打扰 PASS");
  }
  {
    // 场景：翻译关闭 —— 原文草稿正常显示
    const h = makeCtx();
    h.els["#translate-toggle"].checked = false;
    sendMessage(h, { type: "LIVE_STATE", jobId: "live-2", status: "live", translate: false });
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-2", seq: 1, lines: [{ text: "Hey there" }] });
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
    // 服务端整体换词：互不包含 → correcting（8ms 后自动移除）
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-3", seq: 2, lines: [{ text: "Identify your assets and make good" }] });
    const draft = h.feed.children[0];
    check(draft.classList.contains("correcting"), "修正时草稿加 correcting 过渡类");
    // 等过渡类自动移除后再发正常延伸 → 不加 correcting
    await new Promise((r) => setTimeout(r, 20));
    sendMessage(h, { type: "LIVE_PARTIAL", jobId: "live-3", seq: 3, lines: [{ text: "Identify your assets and make good on" }] });
    check(!draft.classList.contains("correcting"), "正常延伸不加 correcting（过渡类已移除）");
    console.log("T3 草稿修正过渡 PASS");
  }
  console.log(fail === 0 ? "sidepanel-draft 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
