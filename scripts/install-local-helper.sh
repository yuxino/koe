#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
runtime_root="${HOME}/.local/share/koe"
log_root="${runtime_root}/logs"
wrapper_path="${runtime_root}/run-helper.sh"
agent_path="${HOME}/Library/LaunchAgents/cn.yuxino.koe-helper.plist"
agent_label="cn.yuxino.koe-helper"
keychain_service="cn.yuxino.koe.remote-token"
keychain_service_dashscope="cn.yuxino.koe.dashscope-key"
remote_url="${KOE_REMOTE_URL:-https://koe-api.yuxino.cn}"
proxy_url=""

proxy_settings="$(/usr/sbin/scutil --proxy)"
proxy_enabled="$(print -r -- "${proxy_settings}" | awk '/HTTPEnable/{print $3; exit}')"
proxy_host="$(print -r -- "${proxy_settings}" | awk '/HTTPProxy/{print $3; exit}')"
proxy_port="$(print -r -- "${proxy_settings}" | awk '/HTTPPort/{print $3; exit}')"
if [[ "${proxy_enabled}" == "1" && -n "${proxy_host}" && -n "${proxy_port}" ]]; then
  proxy_url="http://${proxy_host}:${proxy_port}"
fi

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
node_bin="${node_bin:A}"
ffmpeg_bin="${ffmpeg_bin:A}"
if [[ -n "${ytdlp_bin}" ]]; then
  ytdlp_bin="${ytdlp_bin:A}"
else
  print -u2 "提示：未检测到 yt-dlp（可选）。它只在页面不暴露视频直链时用作兜底，大多数视频用不到。"
fi

if [[ -n "${KOE_REMOTE_TOKEN:-}" ]]; then
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service}" -w "${KOE_REMOTE_TOKEN}" >/dev/null
elif ! /usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service}" -w >/dev/null 2>&1; then
  read -r -s "remote_token?请输入服务器 KOE_API_TOKEN："
  print
  [[ -n "${remote_token}" ]] || { print -u2 "Token 不能为空。"; exit 1; }
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service}" -w "${remote_token}" >/dev/null
  unset remote_token
fi

if [[ -n "${KOE_DASHSCOPE_API_KEY:-}" ]]; then
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service_dashscope}" -w "${KOE_DASHSCOPE_API_KEY}" >/dev/null
elif ! /usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service_dashscope}" -w >/dev/null 2>&1; then
  read -r -s "dashscope_key?请输入 DashScope API Key（本地识别 + 翻译用）："
  print
  [[ -n "${dashscope_key}" ]] || { print -u2 "DashScope API Key 不能为空。"; exit 1; }
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service_dashscope}" -w "${dashscope_key}" >/dev/null
  unset dashscope_key
fi

mkdir -p "${runtime_root}" "${log_root}" "${HOME}/Library/LaunchAgents"

cat > "${wrapper_path}" <<EOF
#!/bin/zsh
set -euo pipefail
remote_token=\$(/usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service}" -w)
dashscope_key=\$(/usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service_dashscope}" -w)
export PORT=8787
export KOE_REMOTE_URL="${remote_url}"
export KOE_REMOTE_TOKEN="\${remote_token}"
export DASHSCOPE_API_KEY="\${dashscope_key}"
export KOE_LOCAL_ASR=1
export FFMPEG_BIN="${ffmpeg_bin}"
export YTDLP_BIN="${ytdlp_bin}"
export HTTP_PROXY="${proxy_url}"
export HTTPS_PROXY="${proxy_url}"
export ALL_PROXY="${proxy_url}"
export http_proxy="${proxy_url}"
export https_proxy="${proxy_url}"
export all_proxy="${proxy_url}"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"
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
for _ in {1..20}; do
  if ! /bin/launchctl print "gui/${UID}/${agent_label}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! /bin/launchctl bootstrap "gui/${UID}" "${agent_path}"; then
  sleep 0.5
  /bin/launchctl bootstrap "gui/${UID}" "${agent_path}"
fi
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
