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

当前轻量安装支持 **Apple Silicon Mac、macOS 15 或更高版本**；引导和验证过的浏览器路径是 [ego-lite](https://www.egolite.ai/download)。Intel Mac 暂不支持。

1. [下载 Koe ZIP](https://github.com/yuxino/koe/archive/refs/heads/main.zip) 并完整解压。
2. 双击解压目录中的 `Install Koe.command`。如果 macOS 阻止直接打开，请按住 Control 点击它，选择**打开**并确认一次。
3. 安装器会打开 ego-lite 的 `chrome://extensions`：开启**开发者模式**，选择**加载已解压的扩展程序**，然后选择刚才解压的 Koe 仓库根目录（里面直接有 `manifest.json`）。专用 Release ZIP 则选择其中的 `Koe Extension`。

现在打开视频，点 Koe，再点**开启本地精准字幕**即可。无需安装 Xcode、Swift 或管理员权限，也无需查找或填写扩展 ID。下载约 2–3 MB，解压约 6–7 MB；安装器会从两套预编译 Helper 中按系统选择一套，另写入约 3 MB。Git 下载不包含 1.7 GB 的开发缓存，也不包含 Whisper 模型。

首次开启本地字幕会自动下载约 626 MB 的 Whisper 模型，之后复用本机缓存。如果只想用云端识别，也可以在侧边栏切换到 **DashScope** 并保存自己的 API Key。

> 从 1.8.3 或更早的开发版升级：固定扩展 ID 会让 1.9.0 显示为一个新的扩展。请先移除旧 Koe，再按上面的步骤加载新目录；旧扩展中保存的 DashScope API Key 需要重新填写。1.9.0 之后升级时，请先把新文件覆盖到浏览器当前加载的原目录，再运行安装器并点“重新加载”；只把新 ZIP 解压到另一目录后点击旧扩展的“重新加载”，不会更新扩展代码。

## Koe Helper

只有本地精准模式需要 Koe Helper。下载中包含两套 Apple Silicon 预编译 Helper：macOS 15–25 自动安装兼容版，本地识别可用但只显示原文；macOS 26+ 自动安装翻译版，安装所需 Apple 语言包后可做本机中文翻译。`Install Koe.command` 会自动选择、校验并注册 Helper。

当前 Git 下载属于开发预览：Helper 尚未使用 Developer ID 签名和 Apple 公证。安装器只会在 SHA-256 与签名结构校验通过后，移除复制出来的 Helper 的下载隔离标记；安装器自身若被 macOS 拦截，仍需按住 Control 点击并选择**打开**。正式无提示分发仍需要签名、公证的 PKG/DMG。

安装器也会写入 Google Chrome 的兼容注册，但目前只自动打开并验证 ego-lite；Chrome 需要手动打开 `chrome://extensions` 并加载同一目录。

需要从源码重建 Helper 的开发者才需要 Swift 6，以及 macOS 15.4 与 macOS 26 SDK。一次更新两套轻量载荷：

```sh
scripts/update-helper-payload.sh all
./Install\ Koe.command
```

也可用 `baseline` 或 `macos26` 参数只更新其中一套。首次构建会下载 Swift 依赖。

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
scripts/package-release.sh
```

发布脚本从空目录按运行文件白名单组装 ZIP，不会复制 `.git`、`helper/.build`、测试、文档、Swift Helper 源码或模型。生成的预览包位于 `dist/`；正式公开分发前仍需使用 Developer ID 对 Helper 签名并完成 Apple 公证。

© 2026 yuxino
