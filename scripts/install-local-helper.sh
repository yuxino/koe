#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
runtime_root="${HOME}/.local/share/koe"
log_root="${runtime_root}/logs"
wrapper_path="${runtime_root}/run-helper.sh"
agent_path="${HOME}/Library/LaunchAgents/cn.yuxino.koe-helper.plist"
agent_label="cn.yuxino.koe-helper"
keychain_service_dashscope="cn.yuxino.koe.dashscope-key"

proxy_url=""

proxy_settings="$(/usr/sbin/scutil --proxy)"
proxy_enabled="$(print -r -- "${proxy_settings}" | awk '/HTTPEnable/{print $3; exit}')"
proxy_host="$(print -r -- "${proxy_settings}" | awk '/HTTPProxy/{print $3; exit}')"
proxy_port="$(print -r -- "${proxy_settings}" | awk '/HTTPPort/{print $3; exit}')"
if [[ "${proxy_enabled}" == "1" && -n "${proxy_host}" && -n "${proxy_port}" ]]; then
  proxy_url="http://${proxy_host}:${proxy_port}"
fi

node_bin="$(command -v node || true)"
[[ -n "${node_bin}" ]] || { print -u2 "Node.js 20+ 未安装。"; exit 1; }
node_bin="${node_bin:A}"

if [[ -n "${KOE_DASHSCOPE_API_KEY:-}" ]]; then
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service_dashscope}" -w "${KOE_DASHSCOPE_API_KEY}" >/dev/null
elif ! /usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service_dashscope}" -w >/dev/null 2>&1; then
  read -r -s "dashscope_key?请输入 DashScope API Key（实时识别 + 翻译用）："
  print
  [[ -n "${dashscope_key}" ]] || { print -u2 "DashScope API Key 不能为空。"; exit 1; }
  /usr/bin/security add-generic-password -U -a "${USER}" -s "${keychain_service_dashscope}" -w "${dashscope_key}" >/dev/null
  unset dashscope_key
fi

mkdir -p "${runtime_root}" "${log_root}" "${HOME}/Library/LaunchAgents"

cat > "${wrapper_path}" <<EOF
#!/bin/zsh
set -euo pipefail
dashscope_key=\$(/usr/bin/security find-generic-password -a "${USER}" -s "${keychain_service_dashscope}" -w)
export PORT=8787
export DASHSCOPE_API_KEY="\${dashscope_key}"
export HTTP_PROXY="${proxy_url}"
export HTTPS_PROXY="${proxy_url}"
export ALL_PROXY="${proxy_url}"
export http_proxy="${proxy_url}"
export https_proxy="${proxy_url}"
export all_proxy="${proxy_url}"
export NO_PROXY="localhost,127.0.0.1,::1,aliyuncs.com,.aliyuncs.com,dashscope.aliyuncs.com"
export no_proxy="localhost,127.0.0.1,::1,aliyuncs.com,.aliyuncs.com,dashscope.aliyuncs.com"
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
