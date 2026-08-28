# Koe

Koe 是一个为 Chromium 标签页视频生成字幕的本地优先扩展。

[English](README.md)

Koe 识别语音、让字幕跟随播放器进度，并可选翻译为简体中文。它默认关闭，只有点击 Koe 的开启按钮后才会工作。

## Koe 能做什么

- 在 Apple Silicon Mac 上使用 Whisper `large-v3` 本地识别；兼容的公开 HLS 按媒体时间线处理，其他页面可回退到本地标签页音频。
- 字幕跟随拖动进度、切换视频和全屏，并可直接显示在视频画面上。
- macOS 26+ 安装所需 Apple 语言包后可做本机中文翻译；也可使用自己的 API Key，选择 DashScope 云端识别与翻译。
- 同时只运行一个字幕会话；侧边栏提供近期确认字幕、显示设置和诊断日志。

## 开始使用

Koe 需要 **Apple Silicon Mac 和 macOS 15 或更高版本**。[ego-lite](https://www.egolite.ai/download) 是当前引导并实际验证过的浏览器路径；Intel Mac 暂不支持。

1. 从 [Koe 最新版本](https://github.com/yuxino/koe/releases/latest) 下载 `Koe-*-macOS-arm64.zip`，并完整解压。
2. 双击 `Install Koe.command`。如果 macOS 阻止打开，请按住 Control 点击文件，选择**打开**并确认一次。
3. 打开视频，点击 Koe，再点击开启按钮。

无需 Xcode、Swift、管理员权限或扩展 ID。首次开启本地字幕会下载约 626 MB 的 Whisper 模型，之后复用本机缓存。

安装器还会为当前用户启用 ego-lite 自动恢复。运行 `~/Library/Application Support/Koe/Disable Koe Auto-Load.command` 可停用；重新运行安装器即可再次启用或更新 Koe。

## 权限、隐私与限制

- **权限：**Koe 需要所有网站访问、页面脚本、标签页音频采集、本地存储、Native Messaging、侧边栏和网络规则权限，用于发现媒体、显示字幕、保存设置、连接 Koe Helper 和为 DashScope 请求鉴权。只有明确执行开启操作后才会开始音频识别。
- **本地模式：**语音识别留在 Mac。Koe 可能下载 Whisper 模型，并从原媒体服务器或 CDN 读取所需的公开媒体分片。macOS 15–25 的本地模式只显示原文；macOS 26+ 的本机翻译需要相应 Apple 语言包。
- **DashScope 与存储：**DashScope 模式会把采集的标签页音频直接发送给 DashScope；开启翻译时，还会发送识别文本和最多五组近期原文/译文作为上下文。视频文件本身不会上传。API Key 保存在浏览器配置中，只会发往 DashScope 为请求鉴权，不会发送给 Koe Helper。近期字幕保存在浏览器会话存储中，诊断日志不含字幕正文。
- **媒体支持：**媒体直读仅支持公开、未加密的 HLS VOD；其他普通网页可以尝试标签页音频回退，浏览器内部页面不可用。Koe 不绕过 DRM，也不读取 Cookie 或 Authorization。准确边界见 [Koe Helper](helper/README.md)。
- **分发：**当前下载是面向 Apple Silicon 的开发预览，Koe Helper 尚未使用 Developer ID 签名或完成 Apple 公证，扩展界面目前只有简体中文。自动安装与恢复仅支持 ego-lite；Google Chrome 仍需在 `chrome://extensions` 手动加载 `~/Library/Application Support/Koe/Extension`。

© 2026 yuxino
