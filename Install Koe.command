#!/bin/zsh
set -euo pipefail
unsetopt BG_NICE

readonly expected_extension_id="dajnahkneeemkfndhdbanekjhmndgmej"
readonly native_host_name="app.yuxino.koe.helper"
readonly native_protocol_version="1"
readonly script_dir="${0:A:h}"

fail() {
  print -u2 "\nKoe 安装失败：$1"
  print -u2 "没有修改浏览器扩展；修复上面的提示后可以重新运行。"
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
elif [[ -f "$script_dir/manifest.json" ]]; then
  extension_root="$script_dir"
  helper_payload_root="$script_dir/helper/bin"
else
  fail "没有找到 Koe Extension。请完整解压下载的文件后再运行安装器。"
fi

if [[ "${KOE_INSTALLER_TEST:-0}" == "1" ]]; then
  install_base="${KOE_INSTALL_BASE:-}"
  chrome_host_root="${KOE_CHROME_HOST_ROOT:-}"
  ego_host_root="${KOE_EGO_HOST_ROOT:-}"
  validate_test_path "$install_base" "KOE_INSTALL_BASE"
  validate_test_path "$chrome_host_root" "KOE_CHROME_HOST_ROOT"
  validate_test_path "$ego_host_root" "KOE_EGO_HOST_ROOT"
  machine_arch="${KOE_TEST_ARCH:-$(/usr/bin/uname -m)}"
  system_version="${KOE_TEST_OS_VERSION:-$(/usr/bin/sw_vers -productVersion)}"
else
  [[ -z "${KOE_INSTALL_BASE:-}${KOE_CHROME_HOST_ROOT:-}${KOE_EGO_HOST_ROOT:-}${KOE_TEST_ARCH:-}${KOE_TEST_OS_VERSION:-}" ]] \
    || fail "测试路径参数不能用于正式安装。"
  readonly user_home="${HOME:?无法确定当前用户目录}"
  install_base="$user_home/Library/Application Support/Koe"
  chrome_host_root="$user_home/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  ego_host_root="$user_home/Library/Application Support/Citro Labs/ego lite/NativeMessagingHosts"
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
hash_prefix="$(print -rn -- "$actual_hash" | /usr/bin/cut -c1-12)"
version_dir="$versions_root/${version}-${hash_prefix}"
installed_helper="$version_dir/koe-helper"
already_latest=0
staging_dir=""
backup_dir=""
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
  if [[ -n "$backup_dir" && -e "$backup_dir" ]]; then
    /bin/rm -rf -- "$backup_dir"
  fi
  if [[ -d "$validation_dir" ]]; then
    /bin/rm -rf -- "$validation_dir"
  fi
}
trap cleanup EXIT

/bin/mkdir -p "$versions_root"
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

print ""
if [[ "$already_latest" == "1" ]]; then
  print "Koe Helper 已经是最新版本。"
fi
if [[ "$quarantine_cleared" == "1" ]]; then
  print "已允许通过完整性校验的 Koe Helper 运行。"
fi
print "Koe 安装完成。"
print "扩展 ID：$extension_id"
if [[ "$native_translation" == "true" ]]; then
  print "已启用 macOS 26 本机中文翻译。"
else
  print "当前系统使用兼容 Helper：本地字幕显示原文，中文翻译可切换到 DashScope。"
fi
print "安装内容约 3 MB；Whisper 模型会在首次开启本地字幕时单独下载。"
print ""
print "最后一步：在 ego-lite 的扩展页开启开发者模式，选择“加载已解压的扩展程序”。"
print "请选择：$extension_root"

if [[ "${KOE_SKIP_BROWSER_OPEN:-0}" != "1" ]]; then
  /usr/bin/open -a "ego lite" "chrome://extensions" 2>/dev/null \
    || print "请手动打开 ego-lite，再访问 chrome://extensions。"
fi
