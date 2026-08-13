<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>给 Chrome 标签页正在播放的声音加上实时字幕和中文翻译。</p>
  <p><a href="README.md">English</a></p>
</div>

Koe（こえ / 声）会捕获当前 Chrome 标签页的声音，实时识别成字幕，也可以把完整句子翻译成中文。

不下载视频，不跑 ffmpeg，也不需要 Node.js 或 `127.0.0.1` 本地助手。扩展直接连接 DashScope。

## 功能

- **实时字幕** — 播放媒体时同步显示识别结果。
- **中文翻译** — 完整句子异步翻译，不阻塞下一句字幕。
- **自动恢复** — WebSocket 短暂断开后自动重连。
- **切换视频** — 同一页面里换视频后继续工作。
- **全屏字幕层** — 普通播放和全屏模式都能显示。
- **快捷键** — Windows/Linux 使用 **Alt+K**，macOS 使用 **Option+K**。

## 安装

1. 打开 `chrome://extensions`，开启 **开发者模式**。
2. 选择 **加载已解压的扩展程序**，加载本项目目录。
3. 打开 Koe，填写并保存 DashScope API Key。
4. 播放视频，点击 **开始实时字幕**。

API Key 只保存在当前浏览器配置的 `chrome.storage.local` 中，Koe 仅在直连 DashScope 时使用它。

## 开发

运行时是纯 Manifest V3 JavaScript。修改代码后在 `chrome://extensions` 重新加载扩展即可。

主要模块：`background.js` 负责会话调度，`offscreen.js` 负责标签页音频采集与 DashScope 通信，`content.js` 负责字幕 UI，`popup.*` 负责设置。

[MIT](LICENSE) © 2026 yuxino
