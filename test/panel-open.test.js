// 回归：点图标时若字幕在跑 → 打开侧边栏并关弹窗；弹窗里“打开字幕侧边栏”按钮 → 只开面板不开字幕。
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
    classes: { toggle: (c, v) => { el.className = v ? c : ""; } },
    addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
    classList: { toggle: (c, v) => el.classes.toggle(c, v) },
    click() { if (el.listeners.click) el.listeners.click(); }
  };
  return el;
}

function runScenario({ state, startOk = true, clickOpenPanel = false, expectStart = false }) {
  return new Promise((resolve, reject) => {
    const els = {};
    const calls = { getMediaStreamId: 0, sidePanelOpen: 0, closed: 0, started: 0 };
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
          getManifest: () => ({ version: "1.6.2" }),
          sendMessage: async (msg) => {
            if (msg.type === "GET_STATE") return { state };
            if (msg.type === "START_CAPTURE") {
              calls.started++;
              return startOk
                ? { ok: true, state: { status: "live", captureActive: true } }
                : { ok: false, error: "boom" };
            }
            return null;
          }
        },
        windows: { getLastFocused: async () => [] },
        tabs: { query: async () => [{ id: 1, windowId: 2, url: "https://youtu.be/x" }] },
        tabCapture: {
          getMediaStreamId: async () => { calls.getMediaStreamId++; return "stream-1"; }
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
      if (calls.sidePanelOpen > 0 || Date.now() > deadline) {
        try {
          if (clickOpenPanel || state.captureActive || state.status === "live") {
            if (calls.sidePanelOpen !== 1) throw new Error(`期望开 1 次侧边栏，实际 ${calls.sidePanelOpen}`);
            if (calls.closed !== 1) throw new Error(`期望关 1 次弹窗，实际 ${calls.closed}`);
          }
          if (expectStart && calls.getMediaStreamId !== 1) throw new Error("期望发起 tabCapture 授权");
          if (!expectStart && !clickOpenPanel && calls.getMediaStreamId !== 0 && !(state.captureActive)) {
            throw new Error("不应发起 tabCapture 授权");
          }
          resolve({ ok: true, calls });
        } catch (err) { reject(err); }
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

(async () => {
  // A：字幕在跑，点图标 → 开面板 + 关弹窗，不重复开字幕
  await runScenario({ state: { status: "live", captureActive: true }, expectStart: false });
  console.log("A 字幕运行中点图标 → 打开侧边栏 + 关闭弹窗 ✓");
  // B：空闲但需要手势 → 维持自动开启流程
  await runScenario({ state: { status: "idle", captureNeedsGesture: true }, expectStart: true });
  console.log("B 空闲需手势 → 自动开启流程不受影响 ✓");
  // C：空闲，点“打开字幕侧边栏” → 只开面板，不碰 tabCapture
  await runScenario({ state: { status: "idle" }, clickOpenPanel: true, expectStart: false });
  console.log("C 打开侧边栏按钮 → 只开面板，不发起开启 ✓");
  console.log("panel-open 回归测试全部通过");
})().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
