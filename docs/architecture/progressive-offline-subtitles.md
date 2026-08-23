# Progressive local subtitles

Koe 的本地精准模式以视频播放器的绝对时间为唯一显示时钟。扩展不录制标签页声音；它定位页面正在使用的媒体，并经 Chrome Native Messaging 把签名媒体地址、Referer、Origin、当前时间和媒体代次交给 macOS Helper。Cookie 与 Authorization 永不跨过浏览器边界，签名地址也不写入扩展持久化状态。

Helper 先处理 `[currentTime - 4s, currentTime + 16s]`，让当前位置尽快出现字幕；随后以 30 秒窗口、4 秒重叠向前预处理。WhisperKit 返回的段落/词时间加上窗口起点，形成 `{cueId, startMs, endMs, text}`。页面用 `video.currentTime` 直接查找 cue，不使用网络到达时间、FIFO 或固定延迟。

拖动、换源和模式切换都会提升 `mediaEpoch`。旧 Helper 任务先取消，新任务等待旧 CoreML 推理真正退出后再开始；扩展、后台和页面三层都拒绝旧 epoch。快速连续拖动还带单调 `discontinuityId`，迟到的旧 seek 无法覆盖新位置。

Pornhub 一类站点常把 `<video>` 暴露为 `blob:`。Koe 优先使用明确的 `currentSrc`；没有直链时，在页面主世界只读取播放器公开的 `mediaDefinitions`，再结合 webRequest 与近期 Performance 资源。识别只需要音轨，因此页面定义中优先最低画质 HLS，减少下载和首屏等待。

当前 HLS 路径支持未加密、非 byte-range 的 MPEG-TS VOD：只抓取与窗口相交的分片，在本机直接从 TS 解复用 AAC/ADTS 音轨，再交给 WhisperKit，不需要 ffmpeg，也不把视频字节送进解码器。临时音频用完即删。所有入口、重定向、子清单和分片都拒绝本机/内网地址；DRM、AES 加密或不支持的封装会明确报错，不尝试绕过。

本地精准模式在 macOS 26+（Apple Silicon）上可开启中文翻译：识别与翻译都由本机的 Apple Translation 框架完成（需在系统设置下载对应语言包），整条媒体读取、识别、翻译与显示链路都在本机；未安装语言包或系统低于 macOS 26 时自动回退为原文。中文翻译由独立的 DashScope 实时模式提供（标签页声音 · DashScope）。
