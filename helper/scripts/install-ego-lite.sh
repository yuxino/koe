#!/bin/zsh
set -euo pipefail

extension_id="${1:-}"
if [[ ! "$extension_id" =~ '^[a-p]{32}$' ]]; then
  print -u2 "用法：helper/scripts/install-ego-lite.sh <扩展 ID>"
  exit 2
fi

script_dir="${0:A:h}"
helper_dir="${script_dir:h}"
install_root="$HOME/Library/Application Support/Koe/bin"
# ego-lite 0.4.x uses Chrome's macOS user-level Native Messaging registry,
# even though its browser profile itself lives under Citro Labs/ego lite.
host_root="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
# Some ego-lite builds read their own user-level registry; register there too so
# the host is found either way.
ego_host_root="$HOME/Library/Application Support/Citro Labs/ego lite/NativeMessagingHosts"
host_name="app.yuxino.koe.helper"

# Build against the default SDK (macOS 26). The package's deployment target is
# macOS 15, so the binary's minimum OS stays 15.0; the on-device translator is
# guarded by #available(macOS 26) and only activates on 26+. Older SDKs cannot
# compile the Translation-session code, so do not force an older SDKROOT here.
swift build --package-path "$helper_dir" -c release --product koe-helper
mkdir -p "$install_root" "$host_root" "$ego_host_root"
install -m 755 "$helper_dir/.build/release/koe-helper" "$install_root/koe-helper"

manifest="$(mktemp -t koe-helper-manifest).json"
trap 'rm -f "$manifest"' EXIT
printf '%s\n' \
  '{' \
  '  "name": "app.yuxino.koe.helper",' \
  '  "description": "Koe local progressive subtitle helper",' \
  "  \"path\": \"$install_root/koe-helper\"," \
  '  "type": "stdio",' \
  '  "allowed_origins": [' \
  "    \"chrome-extension://$extension_id/\"" \
  '  ]' \
  '}' > "$manifest"

install -m 644 "$manifest" "$host_root/$host_name.json"
install -m 644 "$manifest" "$ego_host_root/$host_name.json"
print "Koe Helper 已为 ego-lite 安装。重新加载扩展后即可使用本地精准字幕。"
