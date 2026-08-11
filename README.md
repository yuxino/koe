<div align="center">
  <img src="./assets/koe-avatar.png" alt="Koe avatar" width="180">
  <h1>Koe</h1>
  <p><strong>先分析，再加字幕。</strong></p>
  <p>Batch video analysis for accurate, timestamped captions.</p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/mode-batch-586b4f" alt="Batch mode">
  <img src="https://img.shields.io/badge/chrome-MV3-4285F4" alt="Chrome MV3">
  <img src="https://img.shields.io/badge/node-20%2B-5FA04E" alt="Node.js 20 or later">
</p>

Koe（こえ / 声）是一个本地媒体、批处理优先的 Chrome 视频字幕项目。视频下载、音频提取、识别和双语翻译全部在你的电脑上完成（识别/翻译直接调用云端模型），完成后再把 WebVTT 加载回原视频。线上 Koe API 服务器不是主路径，仅作可选兜底。

Koe 不做边播边听写；字幕按“已识别完成的段落”渐进显示，不会出现半句。项目参考了 `ding-frame` 的时间轴思路，优先使用 Fun-ASR 的词级时间戳，再按标点、停顿和句长整理字幕。

字幕是渐进式出现的：识别完成一段就立即显示一段（含翻译）；你把视频拖到某个位置，Koe 会优先补算那一段；还没分析到的部分先跳过。全部完成后仍是完整、对齐的双语字幕。

## 工作方式

```text
浏览器真实媒体地址 → 本地 FFmpeg 提取音频 ─┐
拿不到媒体地址时 → 本地 yt-dlp 兜底 ───────┤
                                              ↓
                        首块 5 秒 + 30 秒切块 → Fun-ASR 完整识别
                        → 双语翻译 → 生成 WebVTT → 视频加载字幕
```

## 快速开始

### 1. 安装本地助手

需要 Node.js 20+ 和 `ffmpeg`。`yt-dlp` 是可选的兜底：只在页面不暴露视频直链或直链失效时用来下载音轨；大多数页面用不到，不装也能正常用。

```bash
./scripts/install-local-helper.sh
```

安装程序会把 DashScope API Key 保存到 macOS 钥匙串（用于本地识别和翻译），继承当前 macOS 系统代理，创建用户级 LaunchAgent，并启动 `http://127.0.0.1:8787`。完整视频和识别过程都不再经过线上 Koe 服务器。

### 2. 加载 Chrome 插件

在 Chrome 打开 `chrome://extensions`：

1. 打开「开发者模式」
2. 点击「加载已解压的扩展程序」
3. 选择本项目目录
4. 打开视频页面，点击 Koe
5. 点击 `Analyze video`

插件固定连接本机 `http://127.0.0.1:8787`，无需填写服务地址或 Token。如果页面里有多个视频，先在面板的下拉框里选中要分析的那一个，再点击 `Analyze video`；不选就自动挑选，自动选择会避开广告域名，优先正在播放、时长更长的视频。识别只看声音，不依赖画面清晰度；HLS 流会优先只拉音频轨，下载更少、更快。

弹窗里的「双语字幕」开关默认开启：识别完成后会把字幕翻译成中文，原文和译文两行对照显示；不需要翻译时关掉即可。

## 配置

线上识别服务配置写在 `.env` 中：

```env
PORT=8787
ASR_PROVIDER=dashscope
ASR_MODEL=fun-asr-flash-2026-06-15
ASR_SEGMENT_SECONDS=60
DASHSCOPE_API_KEY=...
KOE_API_TOKEN=...
FFMPEG_BIN=ffmpeg
YTDLP_BIN=yt-dlp
```

真实 ASR Key 只保留在线上服务端。本地助手从 macOS 钥匙串读取远端 Koe Token；扩展面板不再保存或显示任何 Token。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 查看服务状态、模式和工具路径 |
| `POST` | `/api/jobs` | 创建当前网页视频分析任务 |
| `GET` | `/api/jobs/:id` | 查询任务进度 |
| `GET` | `/api/jobs/:id/vtt` | 任务完成后获取完整 WebVTT |

## 部署

服务器部署说明见 [DEPLOY.md](DEPLOY.md)。当前线上 API 地址为 `https://koe-api.yuxino.cn`。

## 开发

运行检查：

```bash
npm run check
```

主要目录：

```text
manifest.json       Chrome MV3 配置
background.js       分析任务创建、轮询和字幕发布
content.js          视频源发现与 VTT 时间轴覆盖层
popup.*             批处理控制面板
src/server/media.js 视频来源与 FFmpeg 适配
src/server/jobs.js  异步分析任务
src/server/relay.js 本地音频上传与远端任务中继
src/server/asr.js   Fun-ASR 与完整音频分段
src/server/transcript.js
                    字幕聚合与 WebVTT
test/               Node 测试
```

## 项目状态

Koe 目前是一个持续迭代中的实验项目。字幕准确度会受到音频质量、说话人、语言混合、背景音乐以及 ASR 模型版本影响。
