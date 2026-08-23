// 回归：点图标直接全自动开启页面字幕，不强行挤出侧边栏。
// 只有明确点「打开字幕记录与设置」时才打开面板；自动问后台 RECOMMEND_TAB 选目标：
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
                ? { ok: true, state: { status: "live", captureActive: true, tabId: msg.tabId } }
                : { ok: false, error: "当前页面没有正在播放、未静音的视频。" };
            }
            if (msg.type === "STOP_CAPTURE") {
              calls.stoppedTab = msg.tabId;
              return { ok: true, state: { status: "idle" } };
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
      const initiallyLive = Boolean(state?.captureActive || state?.status === "live");
      const expectedStopText = state?.engine === "local" ? "停止本地字幕" : "停止实时字幕";
      const settled = clickOpenPanel
        ? calls.sidePanelOpen >= 1 && calls.closed >= 1
        : initiallyLive
          ? els["#start-button"].textContent === expectedStopText
          : startOk
            ? calls.startedTab !== null && calls.closed >= 1
            : calls.startedTab !== null && /失败/.test(els["#status-text"].textContent);
      if (settled) {
        try {
          if (clickOpenPanel) {
            if (calls.sidePanelOpen < 1) throw new Error(`期望打开侧边栏，实际 ${calls.sidePanelOpen}`);
            if (calls.getMediaStreamId !== 0) throw new Error("次按钮不应发起 tabCapture");
            if (calls.closed !== 1) throw new Error(`次按钮应关弹窗，实际 close ${calls.closed}`);
          } else if (calls.sidePanelOpen !== 0) {
            throw new Error(`页面字幕启动不应自动打开侧边栏，实际 ${calls.sidePanelOpen}`);
          }
          resolve({ ok: true, calls, els });
        } catch (err) { reject(err); }
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`超时：sidePanelOpen=${calls.sidePanelOpen} closed=${calls.closed} startedTab=${calls.startedTab} status=${els["#status-text"].textContent}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

(async () => {
  // A：字幕在跑，点图标 → 只显示轻量控制，不重复开字幕、不强开面板
  const a = await runScenario({ state: { status: "live", captureActive: true } });
  if (a.calls.getMediaStreamId !== 0) throw new Error("A 不应重复开启");
  console.log("A 字幕运行中点图标 → 不重复开启、不强开面板 ✓");
  // B：空闲需手势 → 自动开启页面字幕（RECOMMEND_TAB 指回本页）
  const b = await runScenario({ state: { status: "idle", captureNeedsGesture: true }, recommendTabId: 1 });
  if (b.calls.getMediaStreamId !== 1) throw new Error(`B 期望自动开启 1 次，实际 ${b.calls.getMediaStreamId}`);
  if (b.calls.startedTab !== 1) throw new Error(`B 应捕获本页 tab 1，实际 ${b.calls.startedTab}`);
  console.log("B 空闲需手势 → 自动开启页面字幕、不强开面板 ✓");
  // C：空闲，明确点“打开字幕记录与设置” → 只开面板，不碰 tabCapture
  const c = await runScenario({ state: { status: "idle" }, clickOpenPanel: true });
  console.log(`C 明确打开记录与设置 → 开面板 ${c.calls.sidePanelOpen} 次，不发起开启 ✓`);
  // D：自动尝试失败时弹窗保留显示提示（closed=0），也不挤出面板
  const d = await runScenario({ state: { status: "idle" }, startOk: false, recommendTabId: 1 });
  if (d.calls.closed !== 0) throw new Error(`D 开启失败时弹窗应保留，实际 close ${d.calls.closed}`);
  if (d.calls.sidePanelOpen !== 0) throw new Error("D 失败时不应自动打开面板");
  console.log("D 无可用来源 → 弹窗保留失败提示、不强开面板 ✓");
  // E：本页没在播，后台推荐发声标签页 9 → 跟随它捕获
  const e = await runScenario({ state: { status: "idle" }, recommendTabId: 9 });
  if (e.calls.getTarget !== 9) throw new Error(`E 应跟随发声标签页 9，实际 ${e.calls.getTarget}`);
  if (e.calls.startedTab !== 9) throw new Error(`E 应捕获 tab 9，实际 ${e.calls.startedTab}`);
  console.log(`E 本页无声音 → 自动跟随发声标签页 9 ✓`);
  // F：捕获在别的标签页（tab 5）跑着，弹窗状态必须跟随捕获会话：
  // 按钮显示“停止实时字幕”，不自动开，停止时停的是捕获会话（tab 5）
  const f = await runScenario({ state: { status: "live", captureActive: true, tabId: 5 } });
  if (f.calls.getMediaStreamId !== 0) throw new Error("F 捕获运行时不应重复开启");
  if (f.els["#start-button"].textContent !== "停止实时字幕") {
    throw new Error(`F 按钮应显示“停止实时字幕”，实际 ${JSON.stringify(f.els["#start-button"].textContent)}`);
  }
  f.els["#start-button"].click();
  await new Promise((r) => setTimeout(r, 50));
  if (f.calls.stoppedTab !== 5) throw new Error(`F 停止应发给捕获会话 tab 5，实际 ${f.calls.stoppedTab}`);
  console.log(`F 捕获在其他标签页 → 按钮跟随会话状态，停止发到 tab ${f.calls.stoppedTab} ✓`);
  // G：本地 Helper 仍在下载模型/准备音频时，status 尚未 live，但会话已经可以停止。
  // 按钮必须依据 captureActive 显示停止，不能误导为再次开启。
  const g = await runScenario({ state: { status: "preparing-model", captureActive: true, engine: "local", tabId: 6 } });
  if (g.calls.getMediaStreamId !== 0) throw new Error("G 本地准备中不应重复开启");
  if (g.els["#start-button"].textContent !== "停止本地字幕") {
    throw new Error(`G 按钮应显示“停止本地字幕”，实际 ${JSON.stringify(g.els["#start-button"].textContent)}`);
  }
  g.els["#start-button"].click();
  await new Promise((r) => setTimeout(r, 50));
  if (g.calls.stoppedTab !== 6) throw new Error(`G 停止应发给本地会话 tab 6，实际 ${g.calls.stoppedTab}`);
  console.log("G 本地 Helper 准备中 → 显示停止并可立即终止 ✓");
  console.log("panel-open 回归测试全部通过");
})().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
