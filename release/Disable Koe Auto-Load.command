#!/bin/zsh
set -euo pipefail

readonly autoload_label="app.yuxino.koe.autoload"
readonly launch_agent_path="${HOME:?}/Library/LaunchAgents/$autoload_label.plist"
readonly disabled_path="$launch_agent_path.disabled"
readonly service_target="gui/$(/usr/bin/id -u)/$autoload_label"

fail() {
  print -u2 "Koe 自动恢复停用失败：$1"
  exit 1
}

[[ ! -L "$launch_agent_path" ]] \
  || fail "启动项是异常的符号链接；请重新运行 Install Koe.command 修复。"
if [[ -e "$disabled_path" || -L "$disabled_path" ]]; then
  [[ -f "$disabled_path" && ! -L "$disabled_path" ]] \
    || fail "停用备份路径异常；请移开 $disabled_path 后重试。"
fi

plist_moved=0
if [[ -e "$launch_agent_path" ]]; then
  [[ -f "$launch_agent_path" ]] || fail "启动项路径不是普通文件。"
  /bin/mv -f "$launch_agent_path" "$disabled_path" \
    || fail "无法停用启动项文件。"
  plist_moved=1
fi

if /bin/launchctl print "$service_target" >/dev/null 2>&1; then
  if ! /bin/launchctl bootout "$service_target" >/dev/null 2>&1; then
    if [[ "$plist_moved" == "1" && ! -e "$launch_agent_path" ]]; then
      /bin/mv "$disabled_path" "$launch_agent_path" 2>/dev/null || true
    fi
    fail "系统拒绝停止当前启动项；原配置已尽力恢复。"
  fi
  service_stopped=0
  for _ in {1..30}; do
    if ! /bin/launchctl print "$service_target" >/dev/null 2>&1; then
      service_stopped=1
      break
    fi
    /bin/sleep 0.1
  done
  if [[ "$service_stopped" != "1" ]]; then
    if [[ "$plist_moved" == "1" && ! -e "$launch_agent_path" ]]; then
      /bin/mv "$disabled_path" "$launch_agent_path" 2>/dev/null || true
    fi
    fail "启动项没有及时停止；原配置已尽力恢复。"
  fi
fi

print "Koe 的 ego-lite 自动恢复已停用。"
print "当前浏览器里已加载的 Koe 会保留到退出；下次重开不再自动恢复。"
print "扩展文件、字幕设置与 Helper 都已保留。重新运行 Install Koe.command 即可恢复。"
