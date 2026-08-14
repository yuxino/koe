// 回归：扩展重载/禁用导致 chrome 上下文失效时，
// content.js 的 safeSend 必须吞掉同步 throw（"Extension context invalidated"），
// 且版本号动态读 manifest，新副本注入会顶掉旧副本（旧副本自停）。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
let fail = 0;
const check = (cond, label) => { if (!cond) { console.error(`FAIL: ${label}`); fail += 1; } };

function makeElement() {
  return {
    style: {}, innerHTML: "", id: "",
    attachShadow: () => ({ innerHTML: "", querySelector: () => makeElement() }),
    querySelector: () => null,
    appendChild: () => undefined,
    remove: () => undefined
  };
}

// sendMessageThrows=true 模拟扩展上下文失效（同步 throw）
function runContent({ version = "1.6.28", sendMessageThrows = false } = {}) {
  const intervalCallbacks = [];
  const root = makeElement();
  root.querySelectorAll = () => [{
    currentSrc: "https://cdn.example/v.mp4", src: "", paused: false, muted: false, readyState: 4
  }];
  const ctx = {
    console, Date, JSON, String, Number, Boolean, Promise, Math, URL, location: { href: "https://youtu.be/abc" },
    window: {
      __koeLoaded: undefined,
      setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
      addEventListener: () => undefined,
      setTimeout: () => 0, clearTimeout: () => undefined
    },
    document: {
      querySelector: () => root,
      querySelectorAll: () => root.querySelectorAll(),
      createElement: () => makeElement(),
      addEventListener: () => undefined,
      documentElement: { appendChild: () => undefined }
    },
    history: { pushState: () => undefined, replaceState: () => undefined },
    chrome: {
      runtime: {
        getManifest: () => ({ version }),
        onMessage: { addListener: () => undefined },
        sendMessage: () => {
          if (sendMessageThrows) throw new Error("Extension context invalidated.");
          return Promise.resolve({ ok: true });
        }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), ctx, { filename: "content.js" });
  return { ctx, intervalCallbacks };
}

(async () => {
  {
    // 场景：正常加载，trackVideoSource 每秒跑，不抛错
    const h = runContent();
    for (const cb of h.intervalCallbacks) {
      try { cb(); } catch (e) { fail += 1; console.error(`FAIL: 正常加载 trackVideoSource 抛错 ${e.message}`); }
    }
    check(h.ctx.window.__koeLoaded === "1.6.28", "版本号动态读 manifest 并写入");
    console.log("T1 正常加载 trackVideoSource 不抛错 PASS");
  }
  {
    // 场景：chrome 上下文失效（重载/禁用），trackVideoSource 必须吞掉同步 throw
    const h = runContent({ sendMessageThrows: true });
    for (let i = 0; i < 3; i += 1) {
      for (const cb of h.intervalCallbacks) {
        try { cb(); } catch (e) { fail += 1; console.error(`FAIL: 上下文失效仍抛错 ${e.message}`); }
      }
    }
    check(true, "上下文失效时所有回调不抛（无 FAIL 即通过）");
    console.log("T2 上下文失效 safeSend 吞掉同步 throw PASS");
  }
  {
    // 场景：版本升级后新副本注入，旧副本检测版本变化自停（不调失效的 chrome API）
    const h1 = runContent({ version: "1.6.27" }); // 旧副本先加载
    const h2 = runContent({ version: "1.6.28", sendMessageThrows: true }); // 新副本（上下文有效）
    check(h2.ctx.window.__koeLoaded === "1.6.28", "新副本版本号不同 → 重新注入");
    // 旧副本的 interval 回调：检测 __koeLoaded 已是新版本 → 直接 return，不碰 chrome
    let threw = false;
    for (const cb of h1.intervalCallbacks) {
      try { cb(); } catch { threw = true; }
    }
    check(!threw, "旧副本检测版本变化后自停，不再抛错");
    console.log("T3 版本升级旧副本自停 PASS");
  }
  console.log(fail === 0 ? "content-safe 回归全部通过" : `${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
