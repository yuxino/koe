# koe

一个批处理优先的 Chrome 视频字幕实验项目：先取得完整视频，再分析整段音频并生成 VTT，最后把字幕加载回视频。它不做边播边听写，也不会在分析过程中显示中间字幕。

`koe`（こえ / 声）参考 `ding-frame` 的时间轴思路，优先使用 Fun-ASR 的词级时间戳，再按标点、停顿和句长整理字幕。

## 支持的来源

- PornHub / XVideos 页面：服务端使用 `yt-dlp` 提取视频
- 普通网页 HTML5 视频：插件尝试读取当前视频的直接源地址
- 本地视频：在插件面板选择文件后上传分析

站点改版、登录墙、DRM、不可下载的分片流会明确报错；项目不绕过 DRM 或访问控制。yt-dlp 的站点支持本身也会随网站变化，需要实际请求验证。

## 运行

需要 Node.js 20+，真实视频分析还需要 `ffmpeg` 和 `yt-dlp`。

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 DASHSCOPE_API_KEY
npm start
```

然后在 Chrome 打开 `chrome://extensions`：

1. 打开「开发者模式」
2. 点击「加载已解压的扩展程序」
3. 选择本项目目录
4. 打开视频页面，点击 Koe
5. 点击 `Analyze video`

插件默认连接 `https://koe-api.yuxino.cn`；本地开发时可以改为 `http://127.0.0.1:8787`。

分析流程是：创建任务 → 下载/上传视频 → FFmpeg 提取 16 kHz 单声道音频 → 服务端内部分段调用 Fun-ASR → 合并完整时间轴 → 生成 VTT → 插件加载字幕并从头播放。

## 服务端配置

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

API token 只保存在 Chrome 本地存储，并通过 Bearer Token 发送。真实 ASR 的 Key 只保留在服务端。

## API

- `GET /health`：服务状态、模式、工具路径
- `POST /api/jobs`：创建网页/直链任务，或用 `{ "upload": true }` 创建本地文件任务
- `POST /api/jobs/:id/source`：上传本地视频二进制内容
- `GET /api/jobs/:id`：查询任务进度
- `GET /api/jobs/:id/vtt`：任务完成后获取完整 WebVTT

## 部署

服务器部署见 [DEPLOY.md](DEPLOY.md)。当前 API 地址是 `https://koe-api.yuxino.cn`。

## 开发检查

```bash
npm run check
```

目录说明：

- `manifest.json`：Chrome MV3 配置
- `background.js`：分析任务创建、轮询和字幕发布
- `content.js`：视频源发现与完整 VTT 的时间轴覆盖层
- `popup.*`：批处理控制面板
- `src/server/media.js`：视频来源与 FFmpeg 适配
- `src/server/jobs.js`：异步分析任务
- `src/server/asr.js`：Fun-ASR 与完整音频分段
- `src/server/transcript.js`：字幕聚合与 WebVTT
- `test/`：Node 测试
