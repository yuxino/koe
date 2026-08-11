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

Koe（こえ / 声）是一个批处理优先的 Chrome 视频字幕项目。它会先取得完整视频，分析整段音频，生成带时间轴的 WebVTT，然后把字幕加载回原视频。

Koe 不做边播边听写，也不会在分析过程中显示不完整的中间字幕。项目参考了 `ding-frame` 的时间轴思路，优先使用 Fun-ASR 的词级时间戳，再按标点、停顿和句长整理字幕。

## 工作方式

```text
视频来源 → 下载 / 上传 → FFmpeg 提取音频 → Fun-ASR 分段识别
        → 合并完整时间轴 → 生成 WebVTT → 视频加载字幕
```

## 快速开始

### 1. 启动服务端

需要 Node.js 20+；真实视频分析还需要 `ffmpeg` 和 `yt-dlp`。

```bash
npm install
cp .env.example .env
# 编辑 .env，至少填入 DASHSCOPE_API_KEY
npm start
```

### 2. 加载 Chrome 插件

在 Chrome 打开 `chrome://extensions`：

1. 打开「开发者模式」
2. 点击「加载已解压的扩展程序」
3. 选择本项目目录
4. 打开视频页面，点击 Koe
5. 点击 `Analyze video`

插件默认连接 `https://koe-api.yuxino.cn`。本地开发时，在插件面板将服务地址改为 `http://127.0.0.1:8787`。

## 配置

服务端配置写在 `.env` 中：

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

当服务端设置了 `KOE_API_TOKEN`，插件会把面板中保存的 token 以 Bearer Token 发送。真实 ASR Key 只保留在服务端，不会写入插件。

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
src/server/asr.js   Fun-ASR 与完整音频分段
src/server/transcript.js
                    字幕聚合与 WebVTT
test/               Node 测试
```

## 项目状态

Koe 目前是一个持续迭代中的实验项目。字幕准确度会受到音频质量、说话人、语言混合、背景音乐以及 ASR 模型版本影响。
