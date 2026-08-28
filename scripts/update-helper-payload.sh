#!/bin/zsh
set -euo pipefail

readonly repo_root="${0:A:h:h}"
readonly helper_root="$repo_root/helper"
readonly compatible_sdk="/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"
readonly mode="${1:-all}"

fail() {
  print -u2 "Koe Helper 载荷更新失败：$1"
  exit 1
}

[[ "$(/usr/bin/uname -m)" == "arm64" ]] \
  || fail "当前轻量载荷只支持在 Apple Silicon Mac 上构建。"
[[ "$mode" == "all" || "$mode" == "baseline" || "$mode" == "macos26" ]] \
  || fail "用法：scripts/update-helper-payload.sh [all|baseline|macos26]"

cache_root="${TMPDIR:-/tmp}/koe-swift-build-cache"
staging_root="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/koe-helper-payload.XXXXXX")" \
  || fail "无法创建载荷暂存目录。"
cleanup() {
  if [[ -d "$staging_root" ]]; then
    /bin/rm -rf -- "$staging_root"
  fi
}
trap cleanup EXIT
/bin/mkdir -p "$cache_root/clang" "$cache_root/swiftpm"

build_variant() {
  local variant="$1"
  local sdk_path="$2"
  local disable_translation="$3"
  local scratch_root="$cache_root/$variant"
  local source_binary="$scratch_root/release/koe-helper"
  local staged_variant="$staging_root/$variant"
  local staged_payload="$staged_variant/koe-helper"
  local description minimum_os libraries payload_hash
  local -a build_command=(
    /usr/bin/swift build
    --package-path "$helper_root"
    --scratch-path "$scratch_root"
    --only-use-versions-from-resolved-file
    -c release
    --product koe-helper
  )

  if [[ "$disable_translation" == "true" ]]; then
    build_command+=(-Xswiftc -DKOE_DISABLE_NATIVE_TRANSLATION)
  fi

  print "正在构建 $variant…"
  SDKROOT="$sdk_path" \
  CLANG_MODULE_CACHE_PATH="$cache_root/clang" \
  SWIFTPM_MODULECACHE_OVERRIDE="$cache_root/swiftpm" \
    "${build_command[@]}"

  [[ -x "$source_binary" ]] || fail "$variant 构建完成后没有找到 koe-helper。"
  description="$(/usr/bin/file "$source_binary")"
  [[ "$description" == *"Mach-O 64-bit executable arm64"* ]] \
    || fail "$variant 构建结果不是 arm64 Helper。"
  minimum_os="$(/usr/bin/otool -l "$source_binary" | /usr/bin/awk '
    $1 == "cmd" && $2 == "LC_BUILD_VERSION" { found = 1; next }
    found && $1 == "minos" && minos == "" { minos = $2 }
    END { print minos }
  ')"
  [[ "$minimum_os" == "15.0" ]] \
    || fail "$variant 构建结果的最低系统版本不是 15.0：${minimum_os:-未知}。"
  libraries="$(/usr/bin/otool -L "$source_binary")"
  if [[ "$variant" == "macos-arm64" ]]; then
    [[ "$libraries" != *"/Translation.framework/"* ]] \
      || fail "兼容 Helper 意外链接了 macOS 26 Translation.framework。"
  else
    [[ "$libraries" == *"/Translation.framework/"* ]] \
      || fail "macOS 26 Helper 没有链接 Translation.framework。"
  fi

  /bin/mkdir -p "$staged_variant"
  /usr/bin/install -m 755 "$source_binary" "$staged_payload"
  # Swift release binaries retain a large local symbol table. Published payloads
  # do not need those private symbols; strip them before restoring the stable
  # ad-hoc identity that the installer and package checks expect.
  /usr/bin/strip -x "$staged_payload" \
    || fail "$variant 无法移除本地符号。"
  /usr/bin/codesign --force --sign - --identifier koe-helper "$staged_payload" >/dev/null 2>&1 \
    || fail "$variant 无法恢复临时代码签名。"
  /usr/bin/codesign --verify --strict "$staged_payload" 2>/dev/null \
    || fail "$variant 代码签名结构无效。"
  payload_hash="$(/usr/bin/shasum -a 256 "$staged_payload" | /usr/bin/awk '{ print $1 }')"
  print -r -- "$payload_hash  koe-helper" >"$staged_payload.sha256"
}

typeset -a variants
if [[ "$mode" == "all" || "$mode" == "baseline" ]]; then
  [[ -d "$compatible_sdk" ]] \
    || fail "没有找到 macOS 15.4 SDK：$compatible_sdk"
  build_variant "macos-arm64" "$compatible_sdk" true
  variants+=(macos-arm64)
fi

if [[ "$mode" == "all" || "$mode" == "macos26" ]]; then
  native_sdk="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)" \
    || fail "无法找到当前 macOS SDK。"
  native_sdk_version="$(/usr/bin/xcrun --sdk macosx --show-sdk-version)" \
    || fail "无法读取当前 macOS SDK 版本。"
  native_sdk_major="${native_sdk_version%%.*}"
  [[ "$native_sdk_major" =~ '^[0-9]+$' && "$native_sdk_major" -ge 26 ]] \
    || fail "macos26 载荷需要 macOS 26 SDK；当前是 $native_sdk_version。"
  build_variant "macos26-arm64" "$native_sdk" false
  variants+=(macos26-arm64)
fi

for variant in $variants; do
  payload_root="$helper_root/bin/$variant"
  /bin/mkdir -p "$payload_root"
  /usr/bin/install -m 755 "$staging_root/$variant/koe-helper" "$payload_root/koe-helper"
  /usr/bin/install -m 644 "$staging_root/$variant/koe-helper.sha256" "$payload_root/koe-helper.sha256"
  payload_hash="$(/usr/bin/awk 'NR == 1 { print $1 }' "$payload_root/koe-helper.sha256")"
  print "Koe Helper 载荷已更新："
  print "  $payload_root/koe-helper"
  print "  $(/usr/bin/stat -f '%z' "$payload_root/koe-helper") bytes"
  print "  SHA-256 $payload_hash"
done
