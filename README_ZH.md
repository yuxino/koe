<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>给 Chrome 标签页（或麦克风）正在播放的声音加上实时字幕和中文翻译。</p>
  <p><a href="README.md">English</a></p>
</div>

Koe（こえ / 声）捕获标签页声音或麦克风，实时识别成字幕，并可按句翻译成简体中文。字幕持续滚动在 Chrome 侧边栏里，历史可回看。

不下载视频，不跑 ffmpeg，也不需要 Node.js 或 `127.0.0.1` 本地助手。

## 功能

- **侧边栏滚动字幕流** — 已确认的短句逐行累积、草稿实时刷新；长字幕自动切段显示。
- **中文翻译** — 用 DashScope qwen-mt 按句翻译（目标语言显式指定为简体中文）。
- **多种字幕模式** — 标签页声音或麦克风 × DashScope / 本地离线（Vosk 中英文模型，全离线免 Key）/ Chrome 内置识别（免 Key）。
- **本地离线识别** — `models/` 内置 Vosk 小模型（中文/英文），模型加载后断网也能出字幕；配合麦克风模式完全免手势、免 Key。
- **自动恢复** — WebSocket 短暂断开后自动重连。
- **快捷键** — **Alt+K**（macOS 为 **Option+K**）开启并跟随正在发声的标签页（含后台播放）。
- **点击工具栏图标** — 一键开启当前标签页字幕并打开侧边栏。

## 安装

1. 打开 `chrome://extensions`，开启 **开发者模式**。
2. 选择 **加载已解压的扩展程序**，加载本项目目录（包含约 95MB 离线模型，加载稍慢属正常）。
3. 点工具栏 Koe 图标打开侧边栏；「设置」里选字幕模式（麦克风 + 本地离线即可零配置开始）。
4. DashScope 模式需要填写并保存 DashScope API Key。

API Key 只保存在当前浏览器配置的 `chrome.storage.local` 中，Koe 仅在直连 DashScope 时使用它。

## 开发

运行时是纯 Manifest V3 JavaScript。修改代码后在 `chrome://extensions` 重新加载扩展即可。

主要模块：`background.js` 负责会话调度，`offscreen.js` 负责音频采集与识别（DashScope / Chrome 内置 / Vosk 本地模型），`content.js` 负责视频探测与状态提示，`sidepanel.*` 负责侧边栏 UI 与滚动字幕流，`vosk.js` / `vosk-worker.js` 与 `models/` 是本地离线识别组件。

[MIT](LICENSE) © 2026 yuxino
