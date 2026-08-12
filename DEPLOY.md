# Deploy Koe API

`koe-api.yuxino.cn` 使用 pm2 + nginx：

```text
Chrome extension → https://koe-api.yuxino.cn
                 → nginx :443
                 → 127.0.0.1:3011
                 → pm2 koe-api
```

## 服务器依赖

需要 Node.js 20+ 和 FFmpeg：

```bash
dnf install -y https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-8.noarch.rpm
dnf install -y ffmpeg
```

确认：

```bash
ffmpeg -version
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

## GitHub Actions 自动部署

仓库包含 `.github/workflows/deploy.yml`。向 `main` 推送代码，或在 GitHub Actions 页面手动运行 `Deploy Koe API`，会自动完成：

1. 通过 SSH 将当前 commit 同步到 `/root/koe`
2. 保留服务器上的 `/root/koe/.env`
3. 执行 `npm ci --omit=dev`
4. 重启或首次启动 PM2 进程 `koe-api`
5. 请求本机 `/health` 做部署后检查

首次使用前，在仓库的 `Settings → Secrets and variables → Actions` 添加以下 secrets：

| Secret | 内容 |
| --- | --- |
| `DEPLOY_HOST` | 服务器域名或 IP |
| `DEPLOY_PORT` | SSH 端口，可不填，默认 `22` |
| `DEPLOY_USER` | SSH 登录用户；当前服务器部署可填 `root` |
| `DEPLOY_SSH_KEY` | 对应登录用户的 SSH 私钥，完整多行内容 |
| `DEPLOY_KNOWN_HOSTS` | 服务器 SSH host key，不能留空 |

生成 `DEPLOY_KNOWN_HOSTS` 的示例：

```bash
ssh-keyscan -H -p 22 your-server.example.com
```

私钥只放在 GitHub Actions Secrets 中，不要提交到仓库。服务器上的 `.env` 仍然只保留在服务器，不通过 Actions 传输。
