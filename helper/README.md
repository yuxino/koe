# Koe Helper

Koe Helper 是“本地精准”模式使用的 macOS Native Messaging 处理器。识别在本机通过 WhisperKit 完成，不经过 localhost，也不调用 DashScope。

它有两条处理路径：兼容的 HLS 直接读取播放位置附近的媒体分片；没有可用直读来源时，扩展可捕获标签页声音，并通过 Native Messaging 把 PCM 交给 Helper 做本地实时识别。

## 环境要求

- 轻量安装包：Apple Silicon Mac、macOS 15 或更高版本；Intel Mac 暂不支持。
- 源码构建：Swift 6，以及 macOS 15.4 与 macOS 26 SDK。
- ego-lite 是当前引导和验证过的浏览器路径；安装器也写入 Chrome 的兼容注册，并使用扩展清单中的固定 ID 限制 Native Messaging 来源。

## 安装

1. 从 [Koe Releases](https://github.com/yuxino/koe/releases) 下载并完整解压 `Koe-*-macOS-arm64.zip`。
2. 双击解压目录中的 `Install Koe.command`，或在终端运行：

   ```sh
   ./Install\ Koe.command
   ```

3. 安装器会把扩展复制到固定目录并打开 ego-lite；Koe 会自动出现。Google Chrome 仍需在 `chrome://extensions` 手动加载 `~/Library/Application Support/Koe/Extension`。

无需手动填写扩展 ID，也无需安装 Swift/Xcode。首次识别会下载并缓存 `large-v3-v20240930_626MB` 模型。

下载中包含两套约 1.7 MB 的 Helper，安装器按系统只安装一套：macOS 15–25 使用不链接 Translation.framework 的兼容版，macOS 26+ 使用带本机翻译的版本。开发者修改 Swift 源码后，用 `scripts/update-helper-payload.sh all` 先暂存构建、再更新两套载荷与 SHA-256；也可传入 `baseline` 或 `macos26` 只更新一套。构建缓存不进入用户下载包。

当前 Helper 为 ad-hoc 签名的 Git 预览版，尚未经过 Developer ID 签名和 Apple 公证。安装器核对固定扩展 ID、SHA-256、Mach-O 架构、最低系统版本、依赖和签名结构，并只对通过校验的 Helper 复制件移除下载隔离标记。SHA 文件与二进制同包，只用于发现损坏，不代表发布者身份；正式公开分发仍需签名并公证整个发布容器。

## 本地翻译

Apple Silicon 与 macOS 26+ 可使用 Apple Translation 做本机简体中文翻译。请先在「系统设置 → 通用 → 语言与地区 → 翻译语言」启用 **On-Device** 并下载对应语言包。macOS 15–25 的兼容版仍能完成本地 Whisper 识别，但本地模式只显示原文；需要中文翻译时可切换 DashScope。

旧系统、Intel Mac、缺少语言包、不支持的语言对或翻译失败时，Koe 保留原文字幕。

## 支持边界

- HLS 直读仅支持公网 HTTP/HTTPS 的 `.m3u8` VOD：未加密、无 byte-range，音频为 MPEG-TS AAC/ADTS 或完整的 CMAF/fMP4 分片。
- 普通 MP4、DASH 等媒体不走直读解析；浏览器能捕获标签页声音时，可以使用本地实时回退。
- Koe 不绕过 DRM。加密 HLS 不能直读，其他受保护页面是否允许标签页捕获由浏览器和播放器决定。
- 直读路径不读取 Cookie 或 Authorization，只传递必要的 Origin/Referer；localhost、私网、回环、链路本地和不安全重定向会被拒绝。

本地处理仍可能联网下载 Whisper 模型，并从原媒体服务器或 CDN 读取当前字幕窗口所需的分片；Apple 语言包需用户另行在系统设置中安装。音频和识别文本不会发送给 DashScope。
