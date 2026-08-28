// 回归：侧边栏草稿体验 ——
// 翻译模式：原文草稿弱化显示做即时反馈（raw），译文到达替换（translated），
// 译文展示 5 秒内原文不打扰；识别修正时草稿加 correcting 过渡类。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };
const sidepanelHtml = fs.readFileSync(path.join(__dirname, "..", "sidepanel.html"), "utf8");

function makeElement(tag) {
  const el = {
    tag, textContent: "", className: "", dataset: {}, hidden: false,
    isConnected: true, parentElement: null, offsetWidth: 0, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    listeners: {}, children: [],
    classList: {
      classes: new Set(),
      add: (c) => el.classList.classes.add(c),
      remove: (c) => el.classList.classes.delete(c),
      toggle: (c, v) => { if (v === undefined) v = !el.classList.classes.has(c); v ? el.classList.classes.add(c) : el.classList.classes.delete(c); },
      contains: (c) => el.classList.classes.has(c)
    },
    addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
    appendChild: (child) => { child.parentElement = el; el.children.push(child); return child; },
    remove: () => {
      el.isConnected = false;
      if (el.parentElement) {
        const index = el.parentElement.children.indexOf(el);
        if (index >= 0) el.parentElement.children.splice(index, 1);
        el.parentElement = null;
      }
    },
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
        id: "test-extension-id",
        getManifest: () => ({ version: "1.6.11" }),
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        sendMessage: async () => ({ ok: true })
      },
      storage: { local: { get: async () => ({}), set: async () => undefined } },
      tabs: { onActivated: { addListener: () => undefined }, query: async () => [] },
      windows: { getLastFocused: async () => [] },
      declarativeNetRequest: { updateSessionRules: async () => undefined }
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

function captionRows(feed, seq, mediaEpoch) {
  return feed.children.filter((row) => String(row.dataset.seq || "") === String(seq)
    && (mediaEpoch === undefined || String(row.dataset.mediaEpoch || "") === String(mediaEpoch)));
}

function captionText(row) {
  return row?.children.find((child) => child.className === "text")?.textContent || "";
}

// raw 草稿防抖 300ms + correcting 过渡 320ms，等足再断言
const WAIT = 380;

(async () => {
  {
    check(sidepanelHtml.includes('class="toggle-row setting-toggle"')
      && sidepanelHtml.includes('id="skip-same-language-toggle"'),
    "相同语言策略位于折叠设置区");
    check(sidepanelHtml.includes("字幕语言与我的语言相同时只显示原文"),
      "相同语言策略文案正确");
    check(sidepanelHtml.includes("有译文时隐藏原文"),
      "隐藏原文文案说明只在有译文时生效");
    console.log("T0 侧栏翻译策略文案与结构 PASS");
  }
  {
    const h = makeCtx();
    h.ctx.chrome.storage.local.get = async () => ({
      koeTranslate: true,
      koeSkipSameLanguage: false,
      koeCaptureSource: "tab",
      koeAsrEngine: "local"
    });
    await vm.runInContext("initPrefs()", h.ctx);
    check(h.els["#skip-same-language-toggle"].checked === false,
      "初始化回填相同语言策略偏好");

    const writes = [];
    const sent = [];
    h.ctx.chrome.storage.local.set = async (values) => { writes.push(values); };
    h.ctx.chrome.runtime.sendMessage = async (message) => { sent.push(message); return { ok: true }; };
    vm.runInContext('currentState = { status: "live", captureActive: true, tabId: 9 };', h.ctx);
    h.els["#skip-same-language-toggle"].checked = true;
    const change = h.els["#skip-same-language-toggle"].listeners.change;
    check(typeof change === "function", "相同语言策略绑定 change 处理器");
    if (change) await change();
    check(writes.some((values) => values.koeSkipSameLanguage === true),
      "相同语言策略保存到浏览器偏好");
    check(sent.some((message) => message.type === "SET_SKIP_SAME_LANGUAGE"
        && message.tabId === 9 && message.skipSameLanguage === true),
      "相同语言策略同步给活动会话");
    check(h.els["#hint"].textContent.includes("只显示原文"),
      "开启相同语言策略后提示直接显示原文");
    console.log("T0.1 相同语言策略读取、保存与会话同步 PASS");
  }
  {
    const h = makeCtx();
    h.els["#skip-same-language-toggle"].checked = true;
    vm.runInContext("translatePreference = false; applyTranslationPrivacy();", h.ctx);
    check(h.els["#skip-same-language-toggle"].disabled === true,
      "总翻译关闭时禁用相同语言从属项");
    check(h.els["#skip-same-language-toggle"].checked === true,
      "禁用从属项时保留相同语言偏好值");

    vm.runInContext('translatePreference = true; currentState = { nativeTranslation: false }; applyTranslationPrivacy();', h.ctx);
    check(h.els["#skip-same-language-toggle"].disabled === true,
      "本地翻译不可用时禁用相同语言从属项");
    check(h.els["#skip-same-language-toggle"].checked === true,
      "本地翻译不可用时仍保留相同语言偏好值");
    console.log("T0.2 相同语言策略从属状态 PASS");
  }
  {
    // 隐藏原文只允许真译文接管；等待、失败、同文 passthrough、离线和历史都必须回退原文。
    const h = makeCtx();
    h.els["#translate-toggle"].checked = true;
    h.els["#hide-original-toggle"].checked = true;
    vm.runInContext("hideOriginalPreference = true", h.ctx);

    sendMessage(h, {
      type: "LIVE_SUBTITLES", jobId: "truthful-translation", mediaEpoch: 1,
      seq: 1, unit: true, lines: [{ text: "Waiting original." }]
    });
    check(captionRows(h.feed, 1, 1).length === 1
        && captionText(captionRows(h.feed, 1, 1)[0]) === "Waiting original.",
      "等待译文时立即显示一份原文");

    sendMessage(h, {
      type: "LIVE_TRANSLATED", jobId: "truthful-translation", mediaEpoch: 1,
      seq: 1, unit: true, lines: [{ text: "Waiting original.", translated: "" }]
    });
    check(captionRows(h.feed, 1, 1).length === 1
        && captionText(captionRows(h.feed, 1, 1)[0]) === "Waiting original.",
      "翻译失败时保留一份原文");

    sendMessage(h, {
      type: "LIVE_SUBTITLES", jobId: "truthful-translation", mediaEpoch: 1,
      seq: 2, unit: true, lines: [{ text: "Passthrough original." }]
    });
    sendMessage(h, {
      type: "LIVE_TRANSLATED", jobId: "truthful-translation", mediaEpoch: 1,
      seq: 2, unit: true,
      lines: [{ text: "Passthrough original.", translated: "  Passthrough   original. " }]
    });
    check(captionRows(h.feed, 2, 1).length === 1
        && captionText(captionRows(h.feed, 2, 1)[0]) === "Passthrough original.",
      "passthrough 译文与原文相同时仍显示一份原文");

    sendMessage(h, {
      type: "LIVE_SUBTITLES", jobId: "truthful-translation", mediaEpoch: 1,
      seq: 3, unit: true, lines: [{ text: "Real translation." }]
    });
    sendMessage(h, {
      type: "LIVE_TRANSLATED", jobId: "truthful-translation", mediaEpoch: 1,
      seq: 3, unit: true, lines: [{ text: "Real translation.", translated: "真正的译文。" }]
    });
    check(captionRows(h.feed, 3, 1).length === 1
        && captionText(captionRows(h.feed, 3, 1)[0]) === "真正的译文。",
      "仅非空且不同于原文的真译文替换原文");

    sendMessage(h, {
      type: "OFFLINE_VISIBLE", jobId: "truthful-translation", mediaEpoch: 1,
      seq: 4, lines: [{ text: "Offline original.", translated: "" }]
    });
    check(captionRows(h.feed, 4, 1).length === 1
        && captionText(captionRows(h.feed, 4, 1)[0]) === "Offline original.",
      "离线字幕无真译文时显示原文");
    check(vm.runInContext('displayValue({ text: "History original.", translated: "History original." })', h.ctx)
        === "History original.",
      "历史字幕 passthrough 时显示原文");
    console.log("T0.3 真译文判定与原文回退 PASS");
  }
  {
    // 同一 job 的所有字幕类型共用 epoch 门控；新 epoch 必须清掉旧草稿/门控并接受 seq=1。
    const h = makeCtx();
    h.els["#translate-toggle"].checked = true;
    sendMessage(h, {
      type: "LIVE_PARTIAL", jobId: "epoch-job", mediaEpoch: 3,
      seq: 6, lines: [{ text: "epoch three draft" }]
    });
    await new Promise((r) => setTimeout(r, WAIT));
    sendMessage(h, {
      type: "LIVE_SUBTITLES", jobId: "epoch-job", mediaEpoch: 3,
      seq: 7, unit: true, lines: [{ text: "epoch three stable" }]
    });
    check(vm.runInContext("activeMediaEpoch", h.ctx) === 3, "首个字幕消息接管 epoch 3");

    sendMessage(h, {
      type: "LIVE_SUBTITLES", jobId: "epoch-job", mediaEpoch: 4,
      seq: 1, unit: true, lines: [{ text: "epoch four seq one" }]
    });
    const epochState = vm.runInContext(`({
      activeMediaEpoch,
      stateEpoch: currentState.mediaEpoch,
      lastUnitSeq,
      lastDraftSeq,
      pending: pendingOriginalUnits.size,
      hasDraft: Boolean(draftEl)
    })`, h.ctx);
    check(epochState.activeMediaEpoch === 4 && epochState.stateEpoch === 4,
      "新 epoch 同步更新活动 epoch 与 currentState");
    check(epochState.lastUnitSeq === 1 && epochState.lastDraftSeq === 0
        && epochState.pending === 1 && epochState.hasDraft === false,
      "新 epoch 重置旧 seq、草稿和 pending 后接收 seq=1");
    check(captionRows(h.feed, 1, 4).length === 1
        && captionText(captionRows(h.feed, 1, 4)[0]) === "epoch four seq one",
      "同 job 新 epoch 的 seq=1 可见");

    sendMessage(h, {
      type: "LIVE_TRANSLATED", jobId: "epoch-job", mediaEpoch: 3,
      seq: 7, unit: true, lines: [{ text: "epoch three stable", translated: "旧 epoch 译文" }]
    });
    sendMessage(h, {
      type: "OFFLINE_VISIBLE", jobId: "epoch-job", mediaEpoch: 3,
      seq: 8, lines: [{ text: "stale offline" }]
    });
    sendMessage(h, {
      type: "LIVE_PARTIAL", jobId: "epoch-job", mediaEpoch: 3,
      seq: 9, lines: [{ text: "stale draft" }]
    });
    await new Promise((r) => setTimeout(r, WAIT));
    const visibleTexts = h.feed.children.map(captionText).join("\n");
    check(!visibleTexts.includes("旧 epoch 译文")
        && !visibleTexts.includes("stale offline")
        && !visibleTexts.includes("stale draft"),
      "LIVE/OFFLINE 的旧 epoch 字幕统一丢弃");
    console.log("T0.4 LIVE/OFFLINE 统一 epoch 门控 PASS");
  }
  {
    // 离线同 seq 的迟到译文是修订，不是重复字幕；即使后续 seq 已出现也应原位 upsert。
    const h = makeCtx();
    h.els["#translate-toggle"].checked = true;
    sendMessage(h, {
      type: "OFFLINE_VISIBLE", jobId: "offline-revision", mediaEpoch: 2,
      seq: 5, lines: [{ text: "Offline five.", translated: "" }]
    });
    sendMessage(h, {
      type: "OFFLINE_VISIBLE", jobId: "offline-revision", mediaEpoch: 2,
      seq: 6, lines: [{ text: "Offline six.", translated: "" }]
    });
    sendMessage(h, {
      type: "OFFLINE_VISIBLE", jobId: "offline-revision", mediaEpoch: 2,
      seq: 5, lines: [{ text: "Offline five.", translated: "离线第五句。" }]
    });
    check(captionRows(h.feed, 5, 2).length === 1
        && captionText(captionRows(h.feed, 5, 2)[0]) === "离线第五句。",
      "离线迟到译文按 epoch+seq 替换原文且不重复");
    check(captionRows(h.feed, 6, 2).length === 1
        && captionText(captionRows(h.feed, 6, 2)[0]) === "Offline six.",
      "离线旧 seq 修订不影响后续字幕");
    console.log("T0.5 离线同 seq 译文修订 upsert PASS");
  }
  {
    const h = makeCtx();
    h.ctx.chrome.storage.local.get = async () => ({ koeApiKey: "" });
    h.els["#api-key"].focus = () => undefined;
    h.els["#capture-mode"].value = "tab-dashscope";
    vm.runInContext(`activeTab = { id: 9, url: "https://example.com/video" };`, h.ctx);
    await vm.runInContext(`startForTab()`, h.ctx);
    check(h.els["#hint"].textContent.includes("本地精准")
        && !h.els["#hint"].textContent.includes("Chrome 内置"),
      `DashScope 缺 Key 时只推荐仍存在的本地精准模式（实际 ${JSON.stringify(h.els["#hint"].textContent)}）`);
    console.log("T0.6 DashScope 缺 Key 的恢复指引 PASS");
  }
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
  {
    // 场景：本地 Helper 下载模型/准备音频期间，status 还不是 live，
    // 但 captureActive=true 代表会话已经启动，按钮必须保持可停止状态。
    const h = makeCtx();
    vm.runInContext(`currentState = { status: "preparing-model", captureActive: true, engine: "local", tabId: 9 }; renderState();`, h.ctx);
    check(h.els["#start-button"].textContent === "停止本地字幕",
      `本地准备中按钮显示停止（实际 ${JSON.stringify(h.els["#start-button"].textContent)}）`);
    check(h.els["#start-button"].classList.contains("active"), "本地准备中按钮保持 active 状态");
    console.log("T7 本地 Helper 准备中按钮状态 PASS");
  }
  {
    // 场景：状态条与空记录使用同一份具体状态，准备/操作/错误不能退化成泛化占位。
    const h = makeCtx();
    vm.runInContext(`
      currentState = {
        status: "preparing-model", captureActive: true, engine: "local",
        stageDetail: "正在准备本地识别模型（62%）"
      };
      const preparingView = renderState();
      syncFeedPlaceholder(preparingView);
    `, h.ctx);
    check(h.els["#media-status-title"].textContent === "正在准备字幕",
      `准备状态条标题具体（实际 ${JSON.stringify(h.els["#media-status-title"].textContent)}）`);
    check(h.els["#media-status-detail"].textContent === "正在准备本地识别模型（62%）",
      "准备状态条保留后台细节");
    check(draftText(h.feed).includes("正在准备本地识别模型（62%）"),
      "空字幕记录同步准备细节");

    vm.runInContext(`
      currentState = {
        status: "waiting-media", captureActive: true, captureNeedsGesture: true,
        issueKind: "action", issueCode: "needs_tab_audio",
        stageDetail: "当前播放器需要一次标签页声音授权。"
      };
      const actionView = renderState();
      syncFeedPlaceholder(actionView);
    `, h.ctx);
    check(h.els["#media-status-title"].textContent === "点一下 Koe 继续", "操作状态条给出明确动作");
    check(draftText(h.feed).includes("当前播放器需要一次标签页声音授权。"),
      "空字幕记录同步操作原因");

    vm.runInContext(`
      currentState = {
        status: "error", issueKind: "error", issueCode: "unsupported_audio",
        stageDetail: "这个播放器没有可读取的音频格式。"
      };
      const errorView = renderState();
      syncFeedPlaceholder(errorView);
    `, h.ctx);
    check(h.els["#media-status-title"].textContent === "暂不支持此音轨", "错误状态条明确不支持的对象");
    check(h.els["#media-status-detail"].textContent === "这个播放器没有可读取的音频格式。",
      "错误状态条保留具体原因");
    check(draftText(h.feed).includes("这个播放器没有可读取的音频格式。"),
      "空字幕记录同步错误原因");
    console.log("T8 状态条与空记录同步具体状态 PASS");
  }
  {
    // 场景：保存配置不等于打开字幕；只有主开关可以发 START_CAPTURE。
    const h = makeCtx();
    const sent = [];
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      sent.push(message);
      return { ok: true };
    };
    h.els["#api-key"].value = "sk-test";
    await vm.runInContext(`saveApiKey()`, h.ctx);
    check(!sent.some((message) => message.type === "START_CAPTURE"),
      "保存 API Key 不会隐式开启字幕");
    check(h.els["#hint"].textContent.includes("仍保持关闭"),
      `保存后明确提示保持关闭（实际 ${JSON.stringify(h.els["#hint"].textContent)}）`);
    console.log("T9 保存设置不改变字幕开关 PASS");
  }
  {
    // 清空按钮不仅清当前面板，也必须清掉后台 session 历史；否则重开面板
    // restoreTranscript 会把用户刚清掉的字幕全部恢复回来。
    const h = makeCtx();
    const sent = [];
    h.ctx.chrome.runtime.sendMessage = async (message) => {
      sent.push(message);
      return { ok: true };
    };
    const clear = h.els["#clear-feed"].listeners.click;
    check(typeof clear === "function", "清空字幕记录绑定 click 处理器");
    if (clear) clear();
    await new Promise((resolve) => setImmediate(resolve));
    check(sent.some((message) => message.type === "CLEAR_TRANSCRIPT"),
      `清空字幕记录同步清除后台历史（实际 ${JSON.stringify(sent)}）`);
    console.log("T9.1 清空字幕记录持久生效 PASS");
  }
  console.log(fail === 0 ? "sidepanel-draft 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
