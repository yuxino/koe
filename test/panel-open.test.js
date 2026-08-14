// 回归：点图标弹窗必须"无条件开侧边栏 + 全自动开启"。
// init 阶段（手势窗口内）先开面板；然后自动问后台 RECOMMEND_TAB 选目标：
// 本页在播 → 本页；本页没播 → 跟随正在发声的标签页；都没有 → 尝试当前页并给出明确失败提示。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const popupSrc = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

function makeElement() {
  const el = {
    listeners: {},
    textContent: "",
    disabled: false,
    className: "",
    addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
    classList: { toggle: () => {} },
    click() { if (el.listeners.click) el.listeners.click(); }
  };
  return el;
}

function runScenario({ state, startOk = true, recommendTabId = 1, clickOpenPanel = false }) {
  return new Promise((resolve, reject) => {
    const els = {};
    const calls = { getMediaStreamId: 0, getTarget: null, sidePanelOpen: 0, closed: 0, startedTab: null };
    let domReady;

    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      window: { close: () => { calls.closed++; } },
      document: {
        querySelector: (sel) => {
          if (!els[sel]) els[sel] = makeElement();
          return els[sel];
        },
        addEventListener: (ev, fn) => { if (ev === "DOMContentLoaded") domReady = fn; }
      },
      chrome: {
        runtime: {
          getManifest: () => ({ version: "1.6.5" }),
          sendMessage: async (msg) => {
            if (msg.type === "GET_STATE") return { state };
            if (msg.type === "RECOMMEND_TAB") return { tabId: recommendTabId };
            if (msg.type === "START_CAPTURE") {
              calls.startedTab = msg.tabId;
              return startOk
                ? { ok: true, state: { status: "live", captureActive: true } }
                : { ok: false, error: "当前页面没有正在播放、未静音的视频。" };
            }
            return null;
          }
        },
        windows: { getLastFocused: async () => [] },
        tabs: {
          query: async () => [{ id: 1, windowId: 2, url: "https://youtu.be/x" }],
          get: async (id) => ({ id, windowId: 9, url: "https://music.example/play" })
        },
        tabCapture: {
          getMediaStreamId: async ({ targetTabId }) => {
            calls.getMediaStreamId++;
            calls.getTarget = targetTabId;
            return "stream-1";
          }
        },
        sidePanel: {
          open: async (opts) => {
            calls.sidePanelOpen++;
            if (!opts?.windowId) throw new Error("no windowId");
          }
        }
      }
    };

    try {
      vm.runInNewContext(popupSrc, sandbox, { filename: "popup.js" });
    } catch (err) { return reject(err); }

    if (clickOpenPanel) {
      els["#open-panel"].click();
    } else {
      domReady();
    }

    const deadline = Date.now() + 2000;
    const poll = () => {
      if (calls.sidePanelOpen >= 1 && (calls.closed >= 1 || Date.now() > deadline - 1500)) {
        try {
          if (calls.sidePanelOpen < 1) throw new Error(`期望至少开 1 次侧边栏，实际 ${calls.sidePanelOpen}`);
          if (clickOpenPanel) {
            if (calls.getMediaStreamId !== 0) throw new Error("次按钮不应发起 tabCapture");
            if (calls.closed !== 1) throw new Error(`次按钮应关弹窗，实际 close ${calls.closed}`);
          }
          resolve({ ok: true, calls });
        } catch (err) { reject(err); }
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`超时：sidePanelOpen=${calls.sidePanelOpen} closed=${calls.closed} startedTab=${calls.startedTab}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

(async () => {
  // A：字幕在跑，点图标 → 无条件开面板 + 关弹窗，不重复开字幕
  const a = await runScenario({ state: { status: "live", captureActive: true } });
  if (a.calls.getMediaStreamId !== 0) throw new Error("A 不应重复开启");
  console.log(`A 字幕运行中点图标 → 开面板 ${a.calls.sidePanelOpen} 次 + 关弹窗，不重复开 ✓`);
  // B：空闲需手势 → 无条件开面板 + 自动开启（RECOMMEND_TAB 指回本页）
  const b = await runScenario({ state: { status: "idle", captureNeedsGesture: true }, recommendTabId: 1 });
  if (b.calls.getMediaStreamId !== 1) throw new Error(`B 期望自动开启 1 次，实际 ${b.calls.getMediaStreamId}`);
  if (b.calls.startedTab !== 1) throw new Error(`B 应捕获本页 tab 1，实际 ${b.calls.startedTab}`);
  console.log(`B 空闲需手势 → 开面板 ${b.calls.sidePanelOpen} 次 + 自动开启 ✓`);
  // C：空闲，点“打开字幕侧边栏” → 只开面板，不碰 tabCapture
  const c = await runScenario({ state: { status: "idle" }, clickOpenPanel: true });
  console.log(`C 打开侧边栏按钮 → 开面板 ${c.calls.sidePanelOpen} 次，不发起开启 ✓`);
  // D：空闲且无手势需求 → 面板开出，自动尝试失败时弹窗保留显示提示（closed=0）
  const d = await runScenario({ state: { status: "idle" }, startOk: false, recommendTabId: 1 });
  if (d.calls.closed !== 0) throw new Error(`D 开启失败时弹窗应保留，实际 close ${d.calls.closed}`);
  if (d.calls.sidePanelOpen < 1) throw new Error("D 空闲时也应无条件开面板");
  console.log(`D 无可用来源 → 面板开 ${d.calls.sidePanelOpen} 次，弹窗保留失败提示 ✓`);
  // E：本页没在播，后台推荐发声标签页 9 → 跟随它捕获
  const e = await runScenario({ state: { status: "idle" }, recommendTabId: 9 });
  if (e.calls.getTarget !== 9) throw new Error(`E 应跟随发声标签页 9，实际 ${e.calls.getTarget}`);
  if (e.calls.startedTab !== 9) throw new Error(`E 应捕获 tab 9，实际 ${e.calls.startedTab}`);
  console.log(`E 本页无声音 → 自动跟随发声标签页 9 ✓`);
  console.log("panel-open 回归测试全部通过");
})().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
