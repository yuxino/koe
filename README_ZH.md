<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe" width="128">
  <h1>Koe</h1>
  <p>为 Chromium 标签页中的视频生成本地优先字幕。</p>
  <p><a href="README.md">English</a></p>
</div>

Koe 为浏览器视频生成可手动开关、与播放进度同步的字幕，并可选显示简体中文翻译。视频画面只显示字幕；开关、提示和错误都留在弹窗或侧边栏。

## 工作方式

- **默认关闭** — 播放视频、切换页面、保存设置或打开 Koe 都不会启动字幕。只有通过 Koe 控件或右键菜单明确执行开启操作才会启动会话；开启后会跟随媒体变化，直到用户停止。**Alt+K** 只打开控制器。
- **本地精准（默认）** — Koe Helper 在 Mac 上运行 Whisper `large-v3`。兼容的公开 HLS 直接按媒体时间线处理；没有可用 HLS 来源时，可回退到本地标签页音频识别。
- **DashScope** — 采集标签页声音并使用云端识别，可选中文翻译；需要用户自己的 DashScope API Key。
- **同语言不重复翻译** — 默认情况下，可靠判断为浏览器语言的字幕只显示一行原文。可在侧边栏关闭此行为；不确定的语言检测仍会走正常翻译路径。
- **不遮挡视频** — 字幕跟随拖动进度、切换视频和全屏播放器；状态与错误不会压在视频画面上。
- **单一活动会话** — 工具栏显示全局状态，侧边栏保留近期确认字幕和诊断信息；停止会释放标签页声音。

## 安装

当前轻量安装支持 **Apple Silicon Mac、macOS 15 或更高版本**；引导和验证过的浏览器路径是 [ego-lite](https://www.egolite.ai/download)。Intel Mac 暂不支持。

1. 从 [Koe 最新版本](https://github.com/yuxino/koe/releases/latest) 下载 `Koe-*-macOS-arm64.zip`，并完整解压。
2. 双击解压目录中的 `Install Koe.command`。如果 macOS 阻止直接打开，请按住 Control 点击文件，选择**打开**并确认一次。
3. 安装器会把扩展复制到固定的应用支持目录并打开 ego-lite；Koe 会自动出现，无需进入扩展页，也无需在重开浏览器后反复导入。

安装后可以移动或删除解压目录。安装器会为当前用户注册 ego-lite 自动恢复项，并在隔离的空任务中核对浏览器发布者、Koe 的固定身份、安装路径、版本和文件哈希。运行 `~/Library/Application Support/Koe/Disable Koe Auto-Load.command` 可停用；重新运行安装器即可再次启用。

打开视频，点击 Koe，再点击开启按钮。无需 Xcode、Swift、管理员权限或扩展 ID。Git 下载不包含开发构建缓存，也不包含 Whisper 模型。

首次开启本地字幕会自动下载约 626 MB 的 Whisper 模型，之后复用本机缓存。也可以在侧边栏切换到 **DashScope**，并保存自己的 API Key。

> 从 1.8.3 或更早版本升级：请移除旧 Koe、运行安装器，并重新填写旧扩展保存的 DashScope API Key。若此前手动加载过 1.9.0–1.9.4，请重新运行安装器并重启 ego-lite 一次；若旧的手动加载项仍在，请将其移除。之后更新只需重新运行安装器。

## Koe Helper

只有本地精准模式需要 Koe Helper。下载中包含两套 Apple Silicon 预编译 Helper：macOS 15–25 使用兼容版，本地识别可用但只显示原文；macOS 26+ 使用翻译版，安装所需 Apple 语言包后可做本机翻译。`Install Koe.command` 会自动选择、校验、安装并注册正确版本。

当前 Git 下载属于开发预览：Koe Helper 尚未使用 Developer ID 签名或完成 Apple 公证，扩展界面目前只有简体中文。安装器只会为通过完整性与签名结构校验的 Helper 复制件移除下载隔离标记。

安装器也会写入 Google Chrome 的兼容注册，但自动恢复只针对 ego-lite。Chrome 仍需在 `chrome://extensions` 手动加载 `~/Library/Application Support/Koe/Extension`。

需要从源码重建 Helper 的开发者才需要 Swift 6，以及 macOS 15.4 与 macOS 26 SDK。一次更新两套轻量载荷：

```sh
scripts/update-helper-payload.sh all
./Install\ Koe.command
```

也可用 `baseline` 或 `macos26` 参数只更新其中一套。首次构建会下载 Swift 依赖。

媒体直读支持公开、未加密、非 byte-range 的 HLS VOD，以及 MPEG-TS AAC 或 CMAF/fMP4 分片。Koe 不绕过 DRM，也不读取浏览器 Cookie 或 Authorization；浏览器内部页面无法采集。没有可用 HLS 直读来源的页面可以尝试本地标签页音频回退。准确边界见 [Koe Helper 文档](helper/README.md)。

## 隐私

- **权限：**Koe 使用的浏览器权限包括所有网站访问、页面脚本、标签页音频采集、本地存储、Native Messaging、侧边栏和网络规则，用于发现媒体、显示字幕、保存设置、连接 Koe Helper 和为 DashScope 请求鉴权。只有明确执行开启操作后才会开始音频识别。
- **本地精准：**识别留在 Mac，不会发送给 DashScope。Koe 可能下载 Whisper 模型，并从原媒体服务器读取所需分片；Apple 语言包需用户另行在系统设置中安装。
- **DashScope：**标签页音频会直接发送给 DashScope 识别。翻译还会发送识别文本和最多五组近期原文/译文作为上下文；视频文件本身不会上传。
- API Key 保存在浏览器配置中，只会发往 DashScope 为请求鉴权，不会发送给 Koe Helper。近期字幕保存在浏览器会话存储中；诊断日志记录时序和错误，不保存字幕正文。

## 开发

扩展是无需构建的 Manifest V3 JavaScript；修改后在 `chrome://extensions` 重新加载。可选 Helper 是 `helper/` 下的 Swift Package。

```sh
for test_file in test/*.test.js; do node "$test_file" || exit 1; done
swift run --package-path helper koe-helper-core-checks
scripts/package-release.sh
```

发布脚本从空目录按运行文件白名单组装 ZIP，不会复制 `.git`、`helper/.build`、测试、文档、Swift Helper 源码或模型。生成的预览包位于 `dist/`；正式公开分发前仍需使用 Developer ID 对 Helper 签名并完成 Apple 公证。

© 2026 yuxino
