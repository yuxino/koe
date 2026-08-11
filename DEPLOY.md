# Deploy Koe API

`koe-api.yuxino.cn` 使用 pm2 + nginx：

```text
Chrome extension → https://koe-api.yuxino.cn
                 → nginx :443
                 → 127.0.0.1:3011
                 → pm2 koe-api
```

## 服务器依赖

批处理模式需要 Node.js 20+、FFmpeg 和 yt-dlp：

```bash
dnf install -y https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-8.noarch.rpm
dnf install -y ffmpeg
curl -L --fail -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod 755 /usr/local/bin/yt-dlp
```

确认：

```bash
ffmpeg -version
yt-dlp --version
```

## 项目与环境变量

将项目部署到 `/root/koe`，并创建权限为 `600` 的 `/root/koe/.env`：

```env
PORT=3011
ASR_PROVIDER=dashscope
ASR_MODEL=fun-asr-flash-2026-06-15
ASR_SEGMENT_SECONDS=60
DASHSCOPE_API_KEY=...
KOE_API_TOKEN=long-random-client-token
FFMPEG_BIN=ffmpeg
YTDLP_BIN=yt-dlp
```

启动或重载：

```bash
cd /root/koe
npm ci --omit=dev
pm2 start src/server/start.js --name koe-api --cwd /root/koe
pm2 save
```

## nginx

证书沿用 `ding-frame` 的 `*.yuxino.cn` 证书：

```nginx
server {
    listen 80;
    server_name koe-api.yuxino.cn;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name koe-api.yuxino.cn;

    ssl_certificate /etc/nginx/ssl/fullchain.cer;
    ssl_certificate_key /etc/nginx/ssl/yuxino.cn.key;
    client_max_body_size 512m;

    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
```

校验并重载：

```bash
nginx -t
kill -HUP "$(ps -eo pid,cmd | awk '/nginx: master process/{print $1; exit}')"
```

## 验证

```bash
curl https://koe-api.yuxino.cn/health
pm2 status
pm2 logs koe-api
```

`/health` 公开；任务创建、视频上传、任务查询和 VTT 下载在设置 `KOE_API_TOKEN` 后都需要 `Authorization: Bearer <KOE_API_TOKEN>`。
