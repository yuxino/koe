#!/bin/zsh
set -euo pipefail
unsetopt BG_NICE

readonly expected_extension_id="dajnahkneeemkfndhdbanekjhmndgmej"
readonly native_host_name="app.yuxino.koe.helper"
readonly native_protocol_version="1"
readonly autoload_label="app.yuxino.koe.autoload"
readonly script_dir="${0:A:h}"

fail() {
  print -u2 "\nKoe 安装失败：$1"
  print -u2 "修复上面的提示后可以重新运行；安装器会安全复用或修复已完成的文件。"
  exit 1
}

validate_test_path() {
  local value="$1"
  local label="$2"
  [[ "$value" == /* && "$value" != "/" && "$value" != *$'\n'* ]] \
    || fail "$label 必须是安全的绝对路径。"
}

if [[ -f "$script_dir/Koe Extension/manifest.json" ]]; then
  extension_root="$script_dir/Koe Extension"
  helper_payload_root="$script_dir/Resources"
  autoload_source="$script_dir/Resources/ensure-ego-extension.zsh"
  disable_autoload_source="$script_dir/Resources/Disable Koe Auto-Load.command"
elif [[ -f "$script_dir/manifest.json" ]]; then
  extension_root="$script_dir"
  helper_payload_root="$script_dir/helper/bin"
  autoload_source="$script_dir/release/ensure-ego-extension.zsh"
  disable_autoload_source="$script_dir/release/Disable Koe Auto-Load.command"
else
  fail "没有找到 Koe Extension。请完整解压下载的文件后再运行安装器。"
fi

if [[ "${KOE_INSTALLER_TEST:-0}" == "1" ]]; then
  install_base="${KOE_INSTALL_BASE:-}"
  chrome_host_root="${KOE_CHROME_HOST_ROOT:-}"
  ego_host_root="${KOE_EGO_HOST_ROOT:-}"
  launch_agent_root="${KOE_LAUNCH_AGENT_ROOT:-}"
  ego_user_data_root="${KOE_EGO_USER_DATA_ROOT:-}"
  validate_test_path "$install_base" "KOE_INSTALL_BASE"
  validate_test_path "$chrome_host_root" "KOE_CHROME_HOST_ROOT"
  validate_test_path "$ego_host_root" "KOE_EGO_HOST_ROOT"
  validate_test_path "$launch_agent_root" "KOE_LAUNCH_AGENT_ROOT"
  validate_test_path "$ego_user_data_root" "KOE_EGO_USER_DATA_ROOT"
  machine_arch="${KOE_TEST_ARCH:-$(/usr/bin/uname -m)}"
  system_version="${KOE_TEST_OS_VERSION:-$(/usr/bin/sw_vers -productVersion)}"
else
  [[ -z "${KOE_INSTALL_BASE:-}${KOE_CHROME_HOST_ROOT:-}${KOE_EGO_HOST_ROOT:-}${KOE_LAUNCH_AGENT_ROOT:-}${KOE_EGO_USER_DATA_ROOT:-}${KOE_TEST_ARCH:-}${KOE_TEST_OS_VERSION:-}" ]] \
    || fail "测试路径参数不能用于正式安装。"
  readonly user_home="${HOME:?无法确定当前用户目录}"
  install_base="$user_home/Library/Application Support/Koe"
  chrome_host_root="$user_home/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  ego_host_root="$user_home/Library/Application Support/Citro Labs/ego lite/NativeMessagingHosts"
  launch_agent_root="$user_home/Library/LaunchAgents"
  ego_user_data_root="$user_home/Library/Application Support/Citro Labs/ego lite"
  machine_arch="$(/usr/bin/uname -m)"
  system_version="$(/usr/bin/sw_vers -productVersion)"
fi

[[ "$machine_arch" == "arm64" ]] \
  || fail "当前轻量安装包只支持 Apple Silicon Mac；检测到 $machine_arch。"
system_major="${system_version%%.*}"
[[ "$system_major" =~ '^[0-9]+$' && "$system_major" -ge 15 ]] \
  || fail "需要 macOS 15 或更高版本；检测到 $system_version。"

helper_variant="macos-arm64"
if (( system_major >= 26 )) && [[ -f "$helper_payload_root/macos26-arm64/koe-helper" ]]; then
  helper_variant="macos26-arm64"
fi
helper_payload="$helper_payload_root/$helper_variant/koe-helper"
helper_checksum="$helper_payload_root/$helper_variant/koe-helper.sha256"
[[ -f "$helper_payload" && -f "$helper_checksum" ]] \
  || fail "没有找到适用于 $system_version 的预编译 Helper。这不是完整的 Koe 下载包。"
[[ -x "$autoload_source" ]] \
  || fail "没有找到自动恢复 Koe 扩展的组件。这不是完整的 Koe 下载包。"
[[ -x "$disable_autoload_source" ]] \
  || fail "没有找到停用自动恢复的组件。这不是完整的 Koe 下载包。"

manifest_path="$extension_root/manifest.json"
extension_key="$(/usr/bin/plutil -extract key raw -expect string -o - "$manifest_path" 2>/dev/null)" \
  || fail "扩展清单缺少固定身份。"
extension_hex="$(
  print -rn -- "$extension_key" \
    | /usr/bin/base64 -D \
    | /usr/bin/openssl dgst -sha256 -binary \
    | /usr/bin/od -An -tx1 -N16 \
    | /usr/bin/tr -d ' \n'
)" || fail "无法读取扩展身份。"
extension_id="$(print -rn -- "$extension_hex" | /usr/bin/tr '0-9a-f' 'a-p')"
[[ "$extension_id" == "$expected_extension_id" ]] \
  || fail "扩展身份校验失败；请重新下载完整的 Koe。"

version="$(/usr/bin/plutil -extract version raw -expect string -o - "$manifest_path" 2>/dev/null)" \
  || fail "无法读取 Koe 版本。"
[[ "$version" =~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$' ]] \
  || fail "Koe 版本格式无效。"
for version_part in ${(s:.:)version}; do
  (( 10#$version_part <= 65535 )) || fail "Koe 版本号超出允许范围。"
done
extension_files=(
  manifest.json
  background.js
  preferences.js
  media-discovery.js
  content.js
  popup.html
  popup.css
  popup.js
  sidepanel.html
  sidepanel.css
  sidepanel.js
  offscreen.html
  offscreen.js
  pcm-worklet.js
  assets/koe-avatar-16.png
  assets/koe-avatar-48.png
  assets/koe-avatar-128.png
)
for relative_path in $extension_files; do
  [[ -f "$extension_root/$relative_path" ]] \
    || fail "扩展文件不完整：$relative_path"
done
expected_hash="$(/usr/bin/awk 'NR == 1 { print $1 }' "$helper_checksum")"
[[ "$expected_hash" =~ '^[0-9a-f]{64}$' ]] \
  || fail "Helper 校验文件无效。"
actual_hash="$(/usr/bin/shasum -a 256 "$helper_payload" | /usr/bin/awk '{ print $1 }')"
[[ "$actual_hash" == "$expected_hash" ]] \
  || fail "Helper 文件不完整，SHA-256 校验失败。"

helper_description="$(/usr/bin/file "$helper_payload")"
[[ "$helper_description" == *"Mach-O 64-bit executable arm64"* ]] \
  || fail "Helper 不是 Apple Silicon 可执行文件。"
helper_minos="$(/usr/bin/otool -l "$helper_payload" | /usr/bin/awk '
  $1 == "cmd" && $2 == "LC_BUILD_VERSION" { found = 1; next }
  found && $1 == "minos" && minos == "" { minos = $2 }
  END { print minos }
')"
[[ "$helper_minos" == "15.0" ]] \
  || fail "Helper 的最低系统版本异常：${helper_minos:-未知}。"
/usr/bin/codesign --verify --strict "$helper_payload" 2>/dev/null \
  || fail "Helper 的代码签名结构无效。"

versions_root="$install_base/versions"
installed_extension="$install_base/Extension"
installed_extension_checksum="$install_base/extension.sha256"
installed_autoloader="$install_base/ensure-ego-extension.zsh"
installed_disable_autoload="$install_base/Disable Koe Auto-Load.command"
autoload_state_root="$install_base/autoload"
autoload_success_marker="$autoload_state_root/ego-lite.pid"
autoload_error_log="$autoload_state_root/runtime-errors.log"
launch_agent_path="$launch_agent_root/$autoload_label.plist"
disabled_launch_agent_path="$launch_agent_path.disabled"
singleton_lock="$ego_user_data_root/SingletonLock"
singleton_socket="$ego_user_data_root/SingletonSocket"
hash_prefix="$(print -rn -- "$actual_hash" | /usr/bin/cut -c1-12)"
version_dir="$versions_root/${version}-${hash_prefix}"
installed_helper="$version_dir/koe-helper"
already_latest=0
staging_dir=""
backup_dir=""
extension_staging_dir=""
extension_backup_dir=""
temporary_autoloader=""
temporary_disable_autoload=""
temporary_extension_checksum=""
temporary_launch_agent=""
launch_agent_backup=""
quarantine_cleared=0
validation_pid=""
validation_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/koe-installer.XXXXXX")" \
  || fail "无法创建安装校验目录。"

cleanup() {
  if [[ "$validation_pid" =~ '^[0-9]+$' ]]; then
    /bin/kill "$validation_pid" 2>/dev/null || true
    wait "$validation_pid" 2>/dev/null || true
  fi
  if [[ -n "$staging_dir" && -d "$staging_dir" ]]; then
    /bin/rm -rf -- "$staging_dir"
  fi
  if [[ -n "$backup_dir" && -e "$backup_dir" && ! -e "$version_dir" ]]; then
    /bin/mv "$backup_dir" "$version_dir" 2>/dev/null || true
  fi
  if [[ -n "$extension_staging_dir" && -d "$extension_staging_dir" ]]; then
    /bin/rm -rf -- "$extension_staging_dir"
  fi
  if [[ -n "$extension_backup_dir" && -e "$extension_backup_dir" && ! -e "$installed_extension" ]]; then
    /bin/mv "$extension_backup_dir" "$installed_extension" 2>/dev/null || true
  fi
  if [[ -n "$temporary_autoloader" && -e "$temporary_autoloader" ]]; then
    /bin/rm -f -- "$temporary_autoloader"
  fi
  if [[ -n "$temporary_disable_autoload" && -e "$temporary_disable_autoload" ]]; then
    /bin/rm -f -- "$temporary_disable_autoload"
  fi
  if [[ -n "$temporary_extension_checksum" && -e "$temporary_extension_checksum" ]]; then
    /bin/rm -f -- "$temporary_extension_checksum"
  fi
  if [[ -n "$temporary_launch_agent" && -e "$temporary_launch_agent" ]]; then
    /bin/rm -f -- "$temporary_launch_agent"
  fi
  if [[ -n "$launch_agent_backup" && -e "$launch_agent_backup" && ! -e "$launch_agent_path" ]]; then
    /bin/mv "$launch_agent_backup" "$launch_agent_path" 2>/dev/null || true
  fi
  if [[ -d "$validation_dir" ]]; then
    /bin/rm -rf -- "$validation_dir"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

for managed_path in "$install_base" "$versions_root"; do
  [[ ! -L "$managed_path" ]] || fail "受管安装目录不能是符号链接：$managed_path"
  if [[ -e "$managed_path" ]]; then
    [[ -d "$managed_path" ]] || fail "受管安装路径不是目录：$managed_path"
    [[ "$(/usr/bin/stat -f '%u' "$managed_path")" == "$(/usr/bin/id -u)" ]] \
      || fail "受管安装目录不属于当前用户：$managed_path"
  fi
done
/bin/mkdir -p "$versions_root"
/bin/chmod 700 "$install_base" "$versions_root"
extension_staging_dir="$(/usr/bin/mktemp -d "$install_base/.Extension.XXXXXX")" \
  || fail "无法创建扩展安装暂存目录。"
/bin/mkdir -p "$extension_staging_dir/assets"
for relative_path in $extension_files; do
  /usr/bin/install -m 644 "$extension_root/$relative_path" "$extension_staging_dir/$relative_path"
done
/bin/chmod 700 "$extension_staging_dir" "$extension_staging_dir/assets"
staged_extension_key="$(/usr/bin/plutil -extract key raw -expect string -o - "$extension_staging_dir/manifest.json" 2>/dev/null)" \
  || fail "复制后的扩展清单缺少固定身份。"
staged_extension_hex="$(
  print -rn -- "$staged_extension_key" \
    | /usr/bin/base64 -D \
    | /usr/bin/openssl dgst -sha256 -binary \
    | /usr/bin/od -An -tx1 -N16 \
    | /usr/bin/tr -d ' \n'
)" || fail "无法校验复制后的扩展身份。"
staged_extension_id="$(print -rn -- "$staged_extension_hex" | /usr/bin/tr '0-9a-f' 'a-p')"
staged_extension_version="$(/usr/bin/plutil -extract version raw -expect string -o - "$extension_staging_dir/manifest.json" 2>/dev/null)" \
  || fail "无法读取复制后的扩展版本。"
[[ "$staged_extension_id" == "$extension_id" && "$staged_extension_version" == "$version" ]] \
  || fail "复制后的扩展身份或版本不一致。"
temporary_extension_checksum="$(/usr/bin/mktemp "$install_base/.extension-sha256.XXXXXX")" \
  || fail "无法创建扩展完整性清单。"
for relative_path in $extension_files; do
  extension_file_hash="$(/usr/bin/shasum -a 256 "$extension_staging_dir/$relative_path" | /usr/bin/awk '{ print $1 }')"
  print -r -- "$extension_file_hash  $relative_path" >>"$temporary_extension_checksum"
done
/bin/chmod 600 "$temporary_extension_checksum"
if [[ -x "$installed_helper" ]]; then
  installed_hash="$(/usr/bin/shasum -a 256 "$installed_helper" | /usr/bin/awk '{ print $1 }')"
  if [[ "$installed_hash" == "$actual_hash" ]]; then
    already_latest=1
  fi
fi

if [[ "$already_latest" != "1" ]]; then
  staging_dir="$(/usr/bin/mktemp -d "$versions_root/.install.XXXXXX")" \
    || fail "无法创建安装暂存目录。"
  /usr/bin/install -m 755 "$helper_payload" "$staging_dir/koe-helper"
  staged_hash="$(/usr/bin/shasum -a 256 "$staging_dir/koe-helper" | /usr/bin/awk '{ print $1 }')"
  [[ "$staged_hash" == "$actual_hash" ]] \
    || fail "复制 Helper 后校验失败。"
  if /usr/bin/xattr -p com.apple.quarantine "$staging_dir/koe-helper" >/dev/null 2>&1; then
    /usr/bin/xattr -d com.apple.quarantine "$staging_dir/koe-helper" \
      || fail "无法允许已校验的 Koe Helper 运行。"
    quarantine_cleared=1
  fi
  /usr/bin/codesign --verify --strict "$staging_dir/koe-helper" 2>/dev/null \
    || fail "复制后的 Helper 代码签名结构无效。"
  staged_hash="$(/usr/bin/shasum -a 256 "$staging_dir/koe-helper" | /usr/bin/awk '{ print $1 }')"
  [[ "$staged_hash" == "$actual_hash" ]] \
    || fail "处理下载隔离标记后 Helper 校验失败。"
fi

candidate_helper="$installed_helper"
if [[ "$already_latest" != "1" ]]; then
  candidate_helper="$staging_dir/koe-helper"
elif /usr/bin/xattr -p com.apple.quarantine "$installed_helper" >/dev/null 2>&1; then
  /usr/bin/xattr -d com.apple.quarantine "$installed_helper" \
    || fail "无法允许已校验的 Koe Helper 运行。"
  quarantine_cleared=1
fi

ready_output="$validation_dir/ready.frame"
ready_json="$validation_dir/ready.json"
"$candidate_helper" </dev/null >"$ready_output" 2>"$validation_dir/helper.log" &
validation_pid=$!
validation_finished=0
for _ in {1..100}; do
  if ! /bin/kill -0 "$validation_pid" 2>/dev/null; then
    validation_finished=1
    break
  fi
  /bin/sleep 0.1
done
if [[ "$validation_finished" != "1" ]]; then
  /bin/kill "$validation_pid" 2>/dev/null || true
  wait "$validation_pid" 2>/dev/null || true
  validation_pid=""
  fail "Helper 启动校验超过 10 秒。"
fi
if ! wait "$validation_pid"; then
  validation_pid=""
  fail "Helper 无法在当前 Mac 上启动。"
fi
validation_pid=""
frame_length="$(/usr/bin/od -An -tu4 -N4 "$ready_output" | /usr/bin/tr -d ' \n')"
[[ "$frame_length" =~ '^[0-9]+$' && "$frame_length" -gt 0 && "$frame_length" -le 1048576 ]] \
  || fail "Helper 启动校验没有返回有效消息。"
/bin/dd if="$ready_output" of="$ready_json" bs=1 skip=4 count="$frame_length" 2>/dev/null
/usr/bin/plutil -convert xml1 -o /dev/null "$ready_json" >/dev/null 2>&1 \
  || fail "Helper 启动校验返回了无效数据。"
ready_type="$(/usr/bin/plutil -extract type raw -expect string -o - "$ready_json" 2>/dev/null)"
[[ "$ready_type" == "ready" ]] \
  || fail "Helper 没有进入就绪状态。"
ready_protocol_version="$(/usr/bin/plutil -extract protocolVersion raw -expect integer -o - "$ready_json" 2>/dev/null)" \
  || fail "Helper 没有报告协议版本。"
[[ "$ready_protocol_version" == "$native_protocol_version" ]] \
  || fail "Helper 协议版本不兼容：${ready_protocol_version:-未知}。"
native_translation="$(/usr/bin/plutil -extract nativeTranslation raw -expect bool -o - "$ready_json" 2>/dev/null)" \
  || native_translation="false"

if [[ "$already_latest" != "1" ]]; then
  if [[ -e "$version_dir" || -L "$version_dir" ]]; then
    backup_dir="$versions_root/.replaced-${version}-${hash_prefix}-$$"
    [[ ! -e "$backup_dir" && ! -L "$backup_dir" ]] \
      || fail "无法创建旧版本备份路径。"
    /bin/mv "$version_dir" "$backup_dir" \
      || fail "无法移开损坏的同版本 Helper。"
  fi
  if ! /bin/mv "$staging_dir" "$version_dir"; then
    if [[ -n "$backup_dir" && -e "$backup_dir" && ! -e "$version_dir" ]]; then
      /bin/mv "$backup_dir" "$version_dir" 2>/dev/null || true
      backup_dir=""
    fi
    fail "无法完成 Helper 安装。"
  fi
  staging_dir=""
  if [[ -n "$backup_dir" ]]; then
    /bin/rm -rf -- "$backup_dir"
    backup_dir=""
  fi
fi

write_native_manifest() {
  local target_root="$1"
  local target_path="$target_root/$native_host_name.json"
  local temporary_path
  /bin/mkdir -p "$target_root"
  temporary_path="$(/usr/bin/mktemp "$target_root/.${native_host_name}.XXXXXX")" \
    || fail "无法在 $target_root 创建 Native Messaging 配置。"
  /usr/bin/plutil -create xml1 "$temporary_path"
  /usr/bin/plutil -insert name -string "$native_host_name" "$temporary_path"
  /usr/bin/plutil -insert description -string "Koe local subtitle helper" "$temporary_path"
  /usr/bin/plutil -insert path -string "$installed_helper" "$temporary_path"
  /usr/bin/plutil -insert type -string "stdio" "$temporary_path"
  /usr/bin/plutil -insert allowed_origins -array "$temporary_path"
  /usr/bin/plutil -insert allowed_origins.0 -string "chrome-extension://$extension_id/" "$temporary_path"
  /usr/bin/plutil -convert json "$temporary_path"
  /usr/bin/plutil -convert xml1 -o /dev/null "$temporary_path" >/dev/null
  /bin/chmod 644 "$temporary_path"
  /bin/mv -f "$temporary_path" "$target_path"
}

write_native_manifest "$chrome_host_root"
write_native_manifest "$ego_host_root"

if [[ -e "$installed_extension" || -L "$installed_extension" ]]; then
  extension_backup_dir="$install_base/.Extension.replaced.$$"
  [[ ! -e "$extension_backup_dir" && ! -L "$extension_backup_dir" ]] \
    || fail "无法创建旧扩展备份路径。"
  /bin/mv "$installed_extension" "$extension_backup_dir" \
    || fail "无法移开旧的扩展文件。"
fi
if ! /bin/mv "$extension_staging_dir" "$installed_extension"; then
  if [[ -n "$extension_backup_dir" && -e "$extension_backup_dir" && ! -e "$installed_extension" ]]; then
    /bin/mv "$extension_backup_dir" "$installed_extension" 2>/dev/null || true
    extension_backup_dir=""
  fi
  fail "无法完成扩展文件安装。"
fi
extension_staging_dir=""
if [[ -e "$installed_extension_checksum" && -d "$installed_extension_checksum" ]]; then
  fail "扩展完整性清单路径被目录占用。"
fi
/bin/mv -f "$temporary_extension_checksum" "$installed_extension_checksum" \
  || fail "无法安装扩展完整性清单。"
temporary_extension_checksum=""
for relative_path in $extension_files; do
  expected_extension_file_hash="$(/usr/bin/awk -v target="$relative_path" '$2 == target { print $1 }' "$installed_extension_checksum")"
  installed_extension_file_hash="$(/usr/bin/shasum -a 256 "$installed_extension/$relative_path" | /usr/bin/awk '{ print $1 }')"
  [[ "$installed_extension_file_hash" == "$expected_extension_file_hash" ]] \
    || fail "安装后的扩展文件校验失败：$relative_path"
done
if [[ -n "$extension_backup_dir" ]]; then
  /bin/rm -rf -- "$extension_backup_dir"
  extension_backup_dir=""
fi

temporary_autoloader="$(/usr/bin/mktemp "$install_base/.ensure-ego-extension.XXXXXX")" \
  || fail "无法创建自动恢复组件暂存文件。"
/usr/bin/install -m 755 "$autoload_source" "$temporary_autoloader"
/bin/zsh -n "$temporary_autoloader" \
  || fail "自动恢复组件校验失败。"
/bin/mv -f "$temporary_autoloader" "$installed_autoloader"
temporary_autoloader=""

temporary_disable_autoload="$(/usr/bin/mktemp "$install_base/.disable-ego-extension.XXXXXX")" \
  || fail "无法创建停用组件暂存文件。"
/usr/bin/install -m 755 "$disable_autoload_source" "$temporary_disable_autoload"
/bin/zsh -n "$temporary_disable_autoload" \
  || fail "停用自动恢复组件校验失败。"
/bin/mv -f "$temporary_disable_autoload" "$installed_disable_autoload"
temporary_disable_autoload=""

/bin/mkdir -p "$launch_agent_root"
/bin/mkdir -p "$autoload_state_root"
/bin/chmod 700 "$autoload_state_root"
/usr/bin/touch "$autoload_error_log"
/bin/chmod 600 "$autoload_error_log"
temporary_launch_agent="$(/usr/bin/mktemp "$launch_agent_root/.${autoload_label}.XXXXXX")" \
  || fail "无法创建自动恢复启动项。"
/usr/bin/plutil -create xml1 "$temporary_launch_agent"
/usr/bin/plutil -insert Label -string "$autoload_label" "$temporary_launch_agent"
/usr/bin/plutil -insert ProgramArguments -array "$temporary_launch_agent"
/usr/bin/plutil -insert ProgramArguments.0 -string "/bin/zsh" "$temporary_launch_agent"
/usr/bin/plutil -insert ProgramArguments.1 -string "$installed_autoloader" "$temporary_launch_agent"
/usr/bin/plutil -insert ProgramArguments.2 -string "$singleton_lock" "$temporary_launch_agent"
/usr/bin/plutil -insert ProgramArguments.3 -string "$singleton_socket" "$temporary_launch_agent"
/usr/bin/plutil -insert ProcessType -string "Background" "$temporary_launch_agent"
/usr/bin/plutil -insert LimitLoadToSessionType -string "Aqua" "$temporary_launch_agent"
/usr/bin/plutil -insert ThrottleInterval -integer 10 "$temporary_launch_agent"
/usr/bin/plutil -insert StandardOutPath -string "/dev/null" "$temporary_launch_agent"
/usr/bin/plutil -insert StandardErrorPath -string "$autoload_error_log" "$temporary_launch_agent"
/usr/libexec/PlistBuddy \
  -c "Add :KeepAlive dict" \
  -c "Add :KeepAlive:PathState dict" \
  -c "Add :KeepAlive:PathState:'$singleton_socket' bool true" \
  "$temporary_launch_agent" >/dev/null \
  || fail "无法配置 ego-lite 启动检测。"
/usr/bin/plutil -lint "$temporary_launch_agent" >/dev/null \
  || fail "自动恢复启动项校验失败。"
/bin/chmod 644 "$temporary_launch_agent"
/usr/bin/plutil -convert xml1 -o /dev/null "$temporary_launch_agent" >/dev/null \
  || fail "自动恢复启动项无法读取。"
if [[ -L "$launch_agent_path" ]]; then
  fail "Koe 自动恢复启动项不能是符号链接。"
fi
if [[ -e "$disabled_launch_agent_path" || -L "$disabled_launch_agent_path" ]]; then
  [[ -f "$disabled_launch_agent_path" && ! -L "$disabled_launch_agent_path" ]] \
    || fail "Koe 自动恢复停用备份不是普通文件：$disabled_launch_agent_path"
fi
if [[ -e "$launch_agent_path" ]]; then
  launch_agent_backup="$launch_agent_root/.${autoload_label}.previous.$$"
  [[ ! -e "$launch_agent_backup" && ! -L "$launch_agent_backup" ]] \
    || fail "无法创建旧启动项备份。"
  /bin/mv "$launch_agent_path" "$launch_agent_backup" \
    || fail "无法备份旧的自动恢复启动项。"
fi
/bin/mv -f "$temporary_launch_agent" "$launch_agent_path"
temporary_launch_agent=""

autoload_registered=0
if [[ "${KOE_INSTALLER_TEST:-0}" != "1" ]]; then
  service_target="gui/$(/usr/bin/id -u)/$autoload_label"
  service_was_loaded=0
  if /bin/launchctl print "$service_target" >/dev/null 2>&1; then
    service_was_loaded=1
    if ! /bin/launchctl bootout "$service_target" >/dev/null 2>&1; then
      /bin/rm -f -- "$launch_agent_path"
      if [[ -n "$launch_agent_backup" && -e "$launch_agent_backup" ]]; then
        /bin/mv "$launch_agent_backup" "$launch_agent_path"
        launch_agent_backup=""
      fi
      fail "无法停止旧的 Koe 自动恢复启动项。"
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
      /bin/rm -f -- "$launch_agent_path"
      if [[ -n "$launch_agent_backup" && -e "$launch_agent_backup" ]]; then
        /bin/mv "$launch_agent_backup" "$launch_agent_path"
        launch_agent_backup=""
      fi
      fail "旧的 Koe 自动恢复启动项没有及时停止。"
    fi
  fi
  if ! /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$launch_agent_path" >/dev/null 2>&1; then
    /bin/rm -f -- "$launch_agent_path"
    if [[ -n "$launch_agent_backup" && -e "$launch_agent_backup" ]]; then
      /bin/mv "$launch_agent_backup" "$launch_agent_path"
      /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$launch_agent_path" >/dev/null 2>&1 || true
      launch_agent_backup=""
    fi
    fail "无法启用 Koe 的 ego-lite 自动恢复。"
  fi
  /bin/launchctl print "$service_target" >/dev/null 2>&1 \
    || fail "Koe 自动恢复启动项没有成功注册。"
  autoload_registered=1
fi
if [[ -n "$launch_agent_backup" ]]; then
  /bin/rm -f -- "$launch_agent_backup"
  launch_agent_backup=""
fi
if [[ -f "$disabled_launch_agent_path" ]]; then
  /bin/rm -f -- "$disabled_launch_agent_path" \
    || print "旧的停用备份无法清理，但自动恢复已重新启用：$disabled_launch_agent_path"
fi

if [[ "${KOE_SKIP_PROCESS_STOP:-0}" != "1" ]]; then
  while IFS= read -r pid; do
    [[ "$pid" =~ '^[0-9]+$' ]] || continue
    command_path="$(/bin/ps -ww -p "$pid" -o command= 2>/dev/null | /usr/bin/sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$command_path" in
      "$versions_root"/*/koe-helper|"$versions_root"/*/koe-helper\ *|"$install_base/bin/koe-helper"|"$install_base/bin/koe-helper "*)
        /bin/kill "$pid" 2>/dev/null || true
        ;;
    esac
  done < <(/usr/bin/pgrep -x koe-helper 2>/dev/null || true)
fi

autoload_verified=0
if [[ "${KOE_SKIP_BROWSER_OPEN:-0}" != "1" ]]; then
  /bin/rm -f -- "$autoload_success_marker"
  /usr/bin/open -a "ego lite" 2>/dev/null \
    || print "请手动打开 ego-lite；Koe 会在浏览器启动后自动载入。"
  if [[ "$autoload_registered" == "1" ]]; then
    for _ in {1..120}; do
      lock_target="$(/usr/bin/readlink "$singleton_lock" 2>/dev/null || true)"
      current_ego_pid="${lock_target##*-}"
      marker_pid="$(/usr/bin/sed -n '1p' "$autoload_success_marker" 2>/dev/null || true)"
      marker_version="$(/usr/bin/sed -n '2p' "$autoload_success_marker" 2>/dev/null || true)"
      if [[ "$current_ego_pid" =~ '^[0-9]+$' \
          && "$marker_pid" == "$current_ego_pid" && "$marker_version" == "$version" ]]; then
        autoload_verified=1
        break
      fi
      /bin/sleep 0.1
    done
  fi
fi

print ""
if [[ "$already_latest" == "1" ]]; then
  print "Koe Helper 已经是最新版本。"
fi
if [[ "$quarantine_cleared" == "1" ]]; then
  print "已允许通过完整性校验的 Koe Helper 运行。"
fi
print "Koe 文件安装完成。"
print "扩展 ID：$extension_id"
print "扩展已复制到固定位置：$installed_extension"
if [[ "$autoload_verified" == "1" ]]; then
  print "已在当前 ego-lite 验证 Koe $version；以后重开无需再次手动导入。"
elif [[ "${KOE_INSTALLER_TEST:-0}" == "1" ]]; then
  print "自动恢复启动项与受管扩展已完成离线校验。"
else
  print "自动恢复已启用，但当前会话尚未完成加载验证；请正常退出并重开 ego-lite 一次。"
fi
if [[ "$native_translation" == "true" ]]; then
  print "已启用 macOS 26 本机中文翻译。"
else
  print "当前系统使用兼容 Helper：本地字幕显示原文，中文翻译可切换到 DashScope。"
fi
print "本次版本的核心文件约 3 MB；旧版 Helper 可能保留用于排障。Whisper 模型会在首次开启本地字幕时单独下载。"
print ""
print "如需停用后台自动恢复，请运行：$installed_disable_autoload"
