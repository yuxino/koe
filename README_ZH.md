<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>为 Chromium 标签页中的视频生成本地优先字幕。</p>
  <p><a href="README.md">English</a></p>
</div>

Koe 为浏览器视频生成可手动开关、与播放进度同步的字幕，并可选显示简体中文翻译。视频画面只显示字幕；开关、提示和错误都留在弹窗或侧边栏。

## 工作方式

- **默认关闭** — Koe 关闭时，播放视频、切换页面、保存设置或打开 Koe 都不会把它开启。只有通过 Koe 控件或右键菜单明确执行开启操作才会启动会话；开启后会跟随媒体变化，直到用户停止。**Alt+K** 只打开控制器。
- **本地精准（默认）** — Koe Helper 在 Mac 上运行 Whisper `large-v3`。兼容的公开 HLS 直接按媒体时间线处理；没有可用 HLS 来源时，可回退到本地标签页音频识别。
- **DashScope** — 采集标签页声音并使用云端识别，可选中文翻译；需要用户自己的 DashScope API Key。
- **不遮挡视频** — 字幕跟随拖动进度、切换视频和全屏播放器；状态与错误不会压在视频画面上。
- **单一活动会话** — 工具栏显示全局状态，侧边栏保留当前会话近期确认字幕和诊断信息；停止会释放标签页声音。

## 安装

1. 打开 `chrome://extensions`，开启 **开发者模式**，选择 **加载已解压的扩展程序**并加载本仓库。
2. 安装 Koe Helper 后使用默认的**本地精准**模式；也可以切换到 **DashScope**，并在侧边栏保存 API Key。
3. 通过 Koe 控件或右键菜单明确开启；执行开启操作前，Koe 始终保持关闭。

## Koe Helper

只有本地精准模式需要 Koe Helper。仓库内的安装脚本面向 macOS 上的 ego-lite；运行环境要求 macOS 15+，构建需要 Swift 6 和包含 macOS 26 SDK 的工具链。

```sh
helper/scripts/install-ego-lite.sh <扩展 ID>
```

首次构建会下载 Swift 依赖，首次识别会下载并缓存约 626 MB 的 Whisper 模型。在 Apple Silicon 与 macOS 26+ 上，安装对应语言包后还可使用 Apple 本机翻译；其他受支持的 Mac 只显示原文字幕。

媒体直读支持公开、未加密、非 byte-range 的 HLS VOD，以及 MPEG-TS AAC 或 CMAF/fMP4 分片。Koe 不绕过 DRM，也不读取浏览器 Cookie 或 Authorization；没有可用 HLS 直读来源的页面可以尝试本地标签页音频回退。准确边界见 [Koe Helper 文档](helper/README.md)。

## 隐私

- **本地精准：**识别留在 Mac，不会发送给 DashScope。Koe 可能下载 Whisper 模型，并从原媒体服务器读取所需分片；Apple 语言包需用户另行在系统设置中安装。
- **DashScope：**标签页音频会直接发送给 DashScope 识别；开启翻译时，识别出的原文也会发送给 DashScope。视频文件本身不会上传。
- API Key 保存在浏览器配置的 `chrome.storage.local` 中，不会发送给 Koe Helper。诊断日志只记录时序和错误，不保存字幕正文。

## 开发

扩展是无需构建的 Manifest V3 JavaScript；修改后在 `chrome://extensions` 重新加载。可选 Helper 是 `helper/` 下的 Swift Package。

```sh
for test_file in test/*.test.js; do node "$test_file" || exit 1; done
swift run --package-path helper koe-helper-core-checks
```

© 2026 yuxino
