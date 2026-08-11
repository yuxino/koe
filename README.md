# koe

一个独立的 Chrome MV3 视频字幕实验项目：插件捕获当前标签页的声音，本地服务按片段识别，再把带时间戳的字幕叠加回网页。

`koe`（こえ / 声）第一版默认使用 `mock` 模式，所以不需要 API Key 就能验证完整链路。服务端同时预留了 `ding-frame` 使用的 Fun-ASR 词级时间戳适配器。

## 运行

需要 Node.js 20+ 和 Chrome 116+。

```bash
npm install
npm start
```

然后在 Chrome 打开 `chrome://extensions`：

1. 打开右上角「开发者模式」
2. 点击「加载已解压的扩展程序」
3. 选择本项目目录
4. 打开一个有视频声音的网页
5. 点击扩展图标，再点 `Start captions`

默认服务地址是 `http://localhost:8787`。插件面板里可以修改服务地址。

## 使用真实 ASR

```bash
cp .env.example .env
# 编辑 .env，填入 DASHSCOPE_API_KEY，并把 ASR_PROVIDER 改为 dashscope
npm start
```

真实模式会把插件生成的 16 kHz 单声道 WAV 片段交给 Fun-ASR，并使用词级时间戳按标点、停顿和最长句长聚合字幕。Key 只留在本地 Node 服务，不会放进插件；没有 Key 时服务会自动回到 `mock`。

## 当前 MVP 的边界

- 插件通过用户主动点击开始，只处理当前标签页。
- 默认每 15 秒发送一个音频片段，优先验证稳定性；后续再做更低延迟的流式提交。
- 字幕覆盖层是页面内 Shadow DOM，不修改视频网站自己的播放器 DOM。
- 视频暂停、倍速和 seek 的时间轴对齐目前是基础版，识别本身按捕获时钟运行。
- 纯 mock 模式返回演示字幕，不代表模型识别结果。

## 目录

- `manifest.json`：Chrome MV3 配置
- `background.js`：插件 service worker 和标签页消息路由
- `offscreen.html/js`：隐藏音频采集页
- `audio-worklet.js`：PCM 音频采集
- `content.js`：网页字幕覆盖层
- `popup.*`：插件控制面板
- `src/server/`：本地字幕服务与 ASR 适配器
- `test/`：纯 Node 测试
- `docs/plans/`：MVP 实现计划
