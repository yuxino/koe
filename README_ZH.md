<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>给 Chrome 标签页正在播放的声音加上实时字幕和翻译。</p>
  <p><a href="README.md">English</a></p>
</div>

Koe（こえ / 声）会捕获当前 Chrome 标签页的声音，实时识别成字幕，也可以把完整句子翻译成中文。

不下载视频，不跑 ffmpeg。声音直接从标签页流式送到 Koe 的本地助手。

## 功能

- **实时字幕** — 视频播放时同步显示识别结果。
- **中文翻译** — 完整句子识别后异步翻译，不阻塞下一句字幕。
- **自动恢复** — 识别连接或 WebSocket 短暂断开后自动重连。
- **切换视频** — 同一页面里换视频后继续工作。
- **页面字幕层** — 普通播放和全屏模式都能显示。
- **快捷键** — Windows/Linux 使用 **Alt+K**，macOS 使用 **Option+K**。

## 安装

Koe 当前仍需要一个很小的本地助手来处理实时识别和翻译，需要 **Node.js 20+** 和 DashScope API Key。

```bash
./scripts/install-local-helper.sh
```

然后打开 `chrome://extensions`，开启 **开发者模式**，选择 **加载已解压的扩展程序**，加载本项目目录。

安装脚本会把 DashScope API Key 存进 macOS 钥匙串，并通过 LaunchAgent 在 `127.0.0.1:8787` 启动本地助手。

## 使用

1. 在 Chrome 播放视频。
2. 打开 Koe 点击 **开始实时字幕**，或在 macOS 按 **Option+K**。
3. 需要时在弹窗里开启中文翻译。

Koe 只采集标签页声音，不下载视频，也不处理视频文件。

## 开发

```bash
npm install
npm run check
```

主要模块：`background.js` 负责会话调度，`offscreen.js` 负责标签页音频采集，`content.js` 负责字幕 UI，`src/server/` 是本地助手。

[MIT](LICENSE) © 2026 yuxino
