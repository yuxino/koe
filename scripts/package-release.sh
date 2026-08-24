#!/bin/zsh
set -euo pipefail

readonly repo_root="${0:A:h:h}"
readonly manifest_path="$repo_root/manifest.json"
readonly source_payload_root="$repo_root/helper/bin"
readonly installer="$repo_root/Install Koe.command"

fail() {
  print -u2 "Koe 打包失败：$1"
  exit 1
}

[[ -f "$manifest_path" && -x "$source_payload_root/macos-arm64/koe-helper" \
    && -x "$source_payload_root/macos26-arm64/koe-helper" && -x "$installer" ]] \
  || fail "缺少扩展、Helper 或安装器。"

dist_root="${KOE_DIST_DIR:-$repo_root/dist}"
[[ "$dist_root" == /* && "$dist_root" != "/" && "$dist_root" != *$'\n'* ]] \
  || fail "KOE_DIST_DIR 必须是安全的绝对路径。"
/bin/mkdir -p "$dist_root"

version="$(/usr/bin/plutil -extract version raw -expect string -o - "$manifest_path")"
[[ "$version" =~ '^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$' ]] \
  || fail "扩展版本格式无效。"
for version_part in ${(s:.:)version}; do
  (( 10#$version_part <= 65535 )) || fail "扩展版本号超出允许范围。"
done
extension_key="$(/usr/bin/plutil -extract key raw -expect string -o - "$manifest_path")"
extension_hex="$(
  print -rn -- "$extension_key" \
    | /usr/bin/base64 -D \
    | /usr/bin/openssl dgst -sha256 -binary \
    | /usr/bin/od -An -tx1 -N16 \
    | /usr/bin/tr -d ' \n'
)"
extension_id="$(print -rn -- "$extension_hex" | /usr/bin/tr '0-9a-f' 'a-p')"
[[ "$extension_id" == "dajnahkneeemkfndhdbanekjhmndgmej" ]] \
  || fail "扩展身份校验失败。"

bundle_name="Koe-${version}-macOS-arm64"
target_bundle="$dist_root/$bundle_name"
target_zip="$dist_root/$bundle_name.zip"
[[ ! -e "$target_bundle" && ! -e "$target_zip" ]] \
  || fail "$bundle_name 已存在；请移走旧产物后重试。"

staging_root="$(/usr/bin/mktemp -d "$dist_root/.package.XXXXXX")" \
  || fail "无法创建打包暂存目录。"
cleanup() {
  if [[ -d "$staging_root" ]]; then
    /bin/rm -rf -- "$staging_root"
  fi
}
trap cleanup EXIT

bundle_root="$staging_root/$bundle_name"
extension_root="$bundle_root/Koe Extension"
resources_root="$bundle_root/Resources"
/bin/mkdir -p "$extension_root/assets" "$resources_root" "$bundle_root/licenses"

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
  [[ -f "$repo_root/$relative_path" ]] || fail "缺少扩展文件：$relative_path"
  /usr/bin/install -m 644 "$repo_root/$relative_path" "$extension_root/$relative_path"
done

/usr/bin/install -m 755 "$installer" "$bundle_root/Install Koe.command"
/usr/bin/install -m 644 "$repo_root/release/README.txt" "$bundle_root/README.txt"
/usr/bin/install -m 644 "$repo_root/THIRD_PARTY_NOTICES.md" "$bundle_root/THIRD_PARTY_NOTICES.md"
/usr/bin/install -m 644 "$repo_root/licenses/argmax-oss-swift-MIT.txt" "$bundle_root/licenses/argmax-oss-swift-MIT.txt"
/usr/bin/install -m 644 "$repo_root/licenses/Apache-2.0.txt" "$bundle_root/licenses/Apache-2.0.txt"

helper_variants=(macos-arm64 macos26-arm64)
for helper_variant in $helper_variants; do
  source_helper="$source_payload_root/$helper_variant/koe-helper"
  source_checksum="$source_payload_root/$helper_variant/koe-helper.sha256"
  [[ -x "$source_helper" && -f "$source_checksum" ]] \
    || fail "缺少 $helper_variant Helper 或校验文件。"
  expected_source_hash="$(/usr/bin/awk 'NR == 1 { print $1 }' "$source_checksum")"
  [[ "$expected_source_hash" =~ '^[0-9a-f]{64}$' ]] \
    || fail "$helper_variant Helper 校验文件无效。"
  actual_source_hash="$(/usr/bin/shasum -a 256 "$source_helper" | /usr/bin/awk '{ print $1 }')"
  [[ "$actual_source_hash" == "$expected_source_hash" ]] \
    || fail "$helper_variant Helper 与校验文件不一致。"
  source_description="$(/usr/bin/file "$source_helper")"
  [[ "$source_description" == *"Mach-O 64-bit executable arm64"* ]] \
    || fail "$helper_variant Helper 不是 Apple Silicon 可执行文件。"
  source_minos="$(/usr/bin/otool -l "$source_helper" | /usr/bin/awk '
    $1 == "cmd" && $2 == "LC_BUILD_VERSION" { found = 1; next }
    found && $1 == "minos" && minos == "" { minos = $2 }
    END { print minos }
  ')"
  [[ "$source_minos" == "15.0" ]] \
    || fail "$helper_variant Helper 的最低系统版本异常：${source_minos:-未知}。"
  source_libraries="$(/usr/bin/otool -L "$source_helper")"
  if [[ "$helper_variant" == "macos-arm64" ]]; then
    [[ "$source_libraries" != *"/Translation.framework/"* ]] \
      || fail "兼容 Helper 不能链接 macOS 26 Translation.framework。"
  else
    [[ "$source_libraries" == *"/Translation.framework/"* ]] \
      || fail "macOS 26 Helper 缺少 Translation.framework。"
  fi
  /usr/bin/codesign --verify --strict "$source_helper" 2>/dev/null \
    || fail "$helper_variant Helper 的代码签名结构无效。"

  variant_root="$resources_root/$helper_variant"
  /bin/mkdir -p "$variant_root"
  /usr/bin/install -m 755 "$source_helper" "$variant_root/koe-helper"
  if [[ -n "${KOE_CODESIGN_IDENTITY:-}" ]]; then
    /usr/bin/codesign --force --options runtime --timestamp \
      --sign "$KOE_CODESIGN_IDENTITY" "$variant_root/koe-helper"
  fi
  /usr/bin/codesign --verify --strict "$variant_root/koe-helper" 2>/dev/null \
    || fail "$helper_variant Helper 的代码签名结构无效。"
  variant_hash="$(/usr/bin/shasum -a 256 "$variant_root/koe-helper" | /usr/bin/awk '{ print $1 }')"
  print -r -- "$variant_hash  koe-helper" >"$variant_root/koe-helper.sha256"
done

release_json="$resources_root/release.json"
/usr/bin/plutil -create xml1 "$release_json"
/usr/bin/plutil -insert version -string "$version" "$release_json"
/usr/bin/plutil -insert extensionId -string "$extension_id" "$release_json"
/usr/bin/plutil -insert helpers -dictionary "$release_json"
developer_id_signed=true
for helper_variant in $helper_variants; do
  variant_root="$resources_root/$helper_variant"
  variant_hash="$(/usr/bin/shasum -a 256 "$variant_root/koe-helper" | /usr/bin/awk '{ print $1 }')"
  variant_bytes="$(/usr/bin/stat -f '%z' "$variant_root/koe-helper")"
  variant_minimum="15.0"
  variant_translation=false
  if [[ "$helper_variant" == "macos26-arm64" ]]; then
    variant_minimum="26.0"
    variant_translation=true
  fi
  signature_details="$(/usr/bin/codesign -dvvv "$variant_root/koe-helper" 2>&1 || true)"
  variant_developer_id=true
  if [[ "$signature_details" != *"Authority=Developer ID Application:"* \
        || "$signature_details" == *"TeamIdentifier=not set"* ]]; then
    variant_developer_id=false
    developer_id_signed=false
  fi
  /usr/bin/plutil -insert "helpers.$helper_variant" -dictionary "$release_json"
  /usr/bin/plutil -insert "helpers.$helper_variant.architecture" -string "arm64" "$release_json"
  /usr/bin/plutil -insert "helpers.$helper_variant.minimumMacOS" -string "$variant_minimum" "$release_json"
  /usr/bin/plutil -insert "helpers.$helper_variant.nativeTranslation" -bool "$variant_translation" "$release_json"
  /usr/bin/plutil -insert "helpers.$helper_variant.sha256" -string "$variant_hash" "$release_json"
  /usr/bin/plutil -insert "helpers.$helper_variant.bytes" -integer "$variant_bytes" "$release_json"
  /usr/bin/plutil -insert "helpers.$helper_variant.developerIdSigned" -bool "$variant_developer_id" "$release_json"
done
/usr/bin/plutil -insert developerIdSigned -bool "$developer_id_signed" "$release_json"
/usr/bin/plutil -insert notarized -bool false "$release_json"
/usr/bin/plutil -convert json "$release_json"

archive_path="$staging_root/$bundle_name.zip"
(
  cd "$staging_root"
  COPYFILE_DISABLE=1 /usr/bin/zip -X -qry "$archive_path" "$bundle_name"
)

archive_bytes="$(/usr/bin/stat -f '%z' "$archive_path")"
(( archive_bytes < 10 * 1024 * 1024 )) \
  || fail "发布包超过 10 MiB，疑似带入了缓存或模型。"

/bin/mv "$bundle_root" "$target_bundle"
/bin/mv "$archive_path" "$target_zip"

print "Koe 发布包已生成："
print "  $target_zip"
print "  $archive_bytes bytes"
print "  扩展 ID：$extension_id"
if [[ "$developer_id_signed" != "true" ]]; then
  print "  注意：当前 Helper 不是 Developer ID 签名，仅适合 Git 预览分发。"
fi
