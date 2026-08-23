# Koe Helper

Koe Helper 是可选的 macOS 本地字幕处理器。扩展通过 Native Messaging 把当前媒体位置和短期有效的媒体地址交给它；音视频只在本机切片和识别，不经过 localhost，也不会上传到对象存储。

本地模式使用 WhisperKit 的 `large-v3-v20240930_626MB`。首次使用会下载模型，之后复用本机缓存。HLS 只下载当前位置附近的未加密 MPEG-TS 分片，并按视频绝对时间返回字幕；拖动进度条会取消旧代次并从新位置重新开始。

## 安装到 ego-lite

1. 在 `chrome://extensions` 找到 Koe 的扩展 ID。
2. 在仓库根目录运行：

   ```sh
   helper/scripts/install-ego-lite.sh <扩展 ID>
   ```

3. 重新加载 Koe，在设置中选择「标签页视频 · 本地精准（推荐）」。

本地精准模式默认只输出原文字幕，媒体读取、音频处理、识别和显示整条链路都留在本机。

在 macOS 26+ 上可开启中文翻译：翻译同样由本机的 Apple 翻译框架完成，音频与字幕都不上传。首次使用前，请到「系统设置 → 通用 → 语言与地区 → 翻译语言」勾选 **On-Device** 并下载所需语言包；没有安装语言包或在 macOS 15–25 上运行时，自动回退为原文字幕。

## 支持边界

- 支持直链媒体，以及未加密、非 byte-range 的 MPEG-TS HLS VOD。
- 不绕过 DRM，也不读取 Cookie 或 Authorization。
- Helper 会拒绝 localhost、回环、链路本地和私有网段，包括 HLS 重定向与分片地址。
