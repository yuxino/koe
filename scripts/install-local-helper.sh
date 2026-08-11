#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
runtime_root="${HOME}/.local/share/koe"
log_root="${runtime_root}/logs"
wrapper_path="${runtime_root}/run-helper.sh"
agent_path="${HOME}/Library/LaunchAgents/cn.yuxino.koe-helper.plist"
agent_label="cn.yuxino.koe-helper"
keychain_service="cn.yuxino.koe.remote-token"
remote_url="${KOE_REMOTE_URL:-https://koe-api.yuxino.cn}"

node_bin="$(command -v node || true)"
ffmpeg_bin="$(command -v ffmpeg || true)"
ytdlp_bin="$(command -v yt-dlp || true)"

if [[ -z "${ffmpeg_bin}" ]]; then
  ffmpeg_bin="$(find "${runtime_root}/venv" -type f -path '*/imageio_ffmpeg/binaries/ffmpeg-*' -perm -u+x 2>/dev/null | head -n 1 || true)"
fi
if [[ -z "${ytdlp_bin}" && -x "${runtime_root}/bin/yt-dlp" ]]; then
  ytdlp_bin="${runtime_root}/bin/yt-dlp"
fi

[[ -n "${node_bin}" ]] || { print -u2 "Node.js 20+ 未安装。"; exit 1; }
[[ -n "${ffmpeg_bin}" ]] || { print -u2 "ffmpeg 未安装。"; exit 1; }
[[ -n "${ytdlp_bin}" ]] || { print -u2 "yt-dlp 未安装（它只作为无法读取浏览器媒体地址时的兜底）。"; exit 1; }
node_bin="${node_bin:A}"
ffmpeg_bin="${ffmpeg_bin:A}"
ytdlp_bin="${ytdlp_bin:A}"

if [[ -n "${KOE_REMOTE_TOKEN:-}" ]]; then
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service}" -w "${KOE_REMOTE_TOKEN}" >/dev/null
elif ! /usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service}" -w >/dev/null 2>&1; then
  read -r -s "remote_token?请输入服务器 KOE_API_TOKEN："
  print
  [[ -n "${remote_token}" ]] || { print -u2 "Token 不能为空。"; exit 1; }
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service}" -w "${remote_token}" >/dev/null
  unset remote_token
fi

mkdir -p "${runtime_root}" "${log_root}" "${HOME}/Library/LaunchAgents"

cat > "${wrapper_path}" <<EOF
#!/bin/zsh
set -euo pipefail
remote_token=\$(/usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service}" -w)
export PORT=8787
export KOE_REMOTE_URL="${remote_url}"
export KOE_REMOTE_TOKEN="\${remote_token}"
export FFMPEG_BIN="${ffmpeg_bin}"
export YTDLP_BIN="${ytdlp_bin}"
exec "${node_bin}" "${repo_root}/src/server/start.js"
EOF
chmod 700 "${wrapper_path}"

cat > "${agent_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${agent_label}</string>
  <key>ProgramArguments</key>
  <array><string>${wrapper_path}</string></array>
  <key>WorkingDirectory</key>
  <string>${repo_root}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log_root}/helper.log</string>
  <key>StandardErrorPath</key>
  <string>${log_root}/helper-error.log</string>
</dict>
</plist>
EOF

/usr/bin/plutil -lint "${agent_path}" >/dev/null
/bin/launchctl bootout "gui/${UID}/${agent_label}" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/${UID}" "${agent_path}"
/bin/launchctl kickstart -k "gui/${UID}/${agent_label}"

for _ in {1..20}; do
  if /usr/bin/curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
    print "Koe 本地助手已启动：http://127.0.0.1:8787"
    exit 0
  fi
  sleep 0.25
done

print -u2 "Koe 本地助手启动失败，请查看 ${log_root}/helper-error.log"
exit 1
