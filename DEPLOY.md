# Deploy Koe API

`koe-api.yuxino.cn` follows the same server layout as `ding-frame`:

```text
Chrome extension → https://koe-api.yuxino.cn
                 → nginx :443
                 → 127.0.0.1:3011
                 → pm2 koe-api
```

## Server files

Deploy the project to `/root/koe`, then create `/root/koe/.env` with mode `600`:

```env
PORT=3011
ASR_PROVIDER=dashscope
ASR_MODEL=fun-asr-flash-2026-06-15
DASHSCOPE_API_KEY=your-dashscope-key
KOE_API_TOKEN=long-random-client-token
```

Start or reload:

```bash
cd /root/koe
npm ci --omit=dev
pm2 start src/server/start.js --name koe-api --cwd /root/koe
pm2 save
```

## nginx

The certificate already used by `ding-frame` covers `*.yuxino.cn`:

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

    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
    }
}
```

Validate and reload with the server's nginx master process if systemd does not own it:

```bash
nginx -t
kill -HUP "$(ps -eo pid,cmd | awk '/nginx: master process/{print $1; exit}')"
```

## Verification

```bash
curl https://koe-api.yuxino.cn/health
pm2 status
pm2 logs koe-api
```

`/health` is public. Session start, audio chunks, and session stop require `Authorization: Bearer <KOE_API_TOKEN>` when the token is configured.
