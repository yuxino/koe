# Koe Helper

Koe Helper 是“本地精准”模式使用的 macOS Native Messaging 处理器。识别在本机通过 WhisperKit 完成，不经过 localhost，也不调用 DashScope。

它有两条处理路径：兼容的 HLS 直接读取播放位置附近的媒体分片；没有可用直读来源时，扩展可捕获标签页声音，并通过 Native Messaging 把 PCM 交给 Helper 做本地实时识别。

## 环境要求

- 运行：macOS 15 或更高版本。
- 构建：Swift 6，以及包含 macOS 26 SDK 的 Xcode 26 或对应 Command Line Tools。
- 安装脚本面向 ego-lite，并按传入的扩展 ID 限制 Native Messaging 来源。

## 安装

1. 在 `chrome://extensions` 找到 Koe 的扩展 ID。
2. 在仓库根目录运行：

   ```sh
   helper/scripts/install-ego-lite.sh <扩展 ID>
   ```

3. 重新加载 Koe，使用默认的「标签页视频 · 本地精准」模式。

首次构建会联网下载 Swift 依赖；首次识别会下载并缓存 `large-v3-v20240930_626MB` 模型。

## 本地翻译

Apple Silicon 与 macOS 26+ 可使用 Apple Translation 做本机简体中文翻译。请先在「系统设置 → 通用 → 语言与地区 → 翻译语言」启用 **On-Device** 并下载对应语言包。

旧系统、Intel Mac、缺少语言包、不支持的语言对或翻译失败时，Koe 保留原文字幕。

## 支持边界

- HLS 直读仅支持公网 HTTP/HTTPS 的 `.m3u8` VOD：未加密、无 byte-range，音频为 MPEG-TS AAC/ADTS 或完整的 CMAF/fMP4 分片。
- 普通 MP4、DASH 等媒体不走直读解析；浏览器能捕获标签页声音时，可以使用本地实时回退。
- Koe 不绕过 DRM。加密 HLS 不能直读，其他受保护页面是否允许标签页捕获由浏览器和播放器决定。
- 直读路径不读取 Cookie 或 Authorization，只传递必要的 Origin/Referer；localhost、私网、回环、链路本地和不安全重定向会被拒绝。

本地处理仍可能联网下载 Whisper 模型，并从原媒体服务器或 CDN 读取当前字幕窗口所需的分片；Apple 语言包需用户另行在系统设置中安装。音频和识别文本不会发送给 DashScope。
