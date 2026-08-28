#!/bin/zsh
set -euo pipefail

readonly expected_extension_id="dajnahkneeemkfndhdbanekjhmndgmej"
readonly install_root="${0:A:h}"
readonly extension_root="$install_root/Extension"
readonly checksum_file="$install_root/extension.sha256"
readonly state_root="$install_root/autoload"
readonly pid_marker="$state_root/ego-lite.pid"
readonly log_file="$state_root/autoload.log"
readonly singleton_lock="${1:-}"
readonly singleton_socket="${2:-}"
readonly expected_ego_bundle_id="com.citrolabs.ego.lite"
readonly expected_ego_team_id="JGQLC6YQYJ"
readonly -a extension_files=(
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

rotate_log() {
  [[ -f "$log_file" ]] || return 0
  local bytes="$(/usr/bin/stat -f '%z' "$log_file" 2>/dev/null || print 0)"
  if [[ "$bytes" =~ '^[0-9]+$' ]] && (( bytes > 65536 )); then
    local temporary_log="$(/usr/bin/mktemp "$state_root/.autoload.log.XXXXXX")"
    /usr/bin/tail -c 32768 "$log_file" >"$temporary_log"
    /bin/chmod 600 "$temporary_log"
    /bin/mv -f "$temporary_log" "$log_file"
  fi
}

log() {
  /bin/mkdir -p "$state_root"
  /bin/chmod 700 "$state_root"
  rotate_log
  print -r -- "$(/bin/date '+%Y-%m-%d %H:%M:%S') $1" >>"$log_file"
  /bin/chmod 600 "$log_file"
}

validate_extension() {
  [[ "$singleton_lock" == /*/SingletonLock && "$singleton_lock" != *$'\n'* \
      && "$singleton_socket" == /*/SingletonSocket && "$singleton_socket" != *$'\n'* ]] || return 1
  [[ -d "$extension_root" && ! -L "$extension_root" \
      && -f "$checksum_file" && ! -L "$checksum_file" ]] || return 1
  local extension_key extension_hex extension_id item mode owner relative_path expected_hash actual_hash node_count
  local current_uid="$(/usr/bin/id -u)"
  extension_key="$(/usr/bin/plutil -extract key raw -expect string -o - "$extension_root/manifest.json" 2>/dev/null)" \
    || return 1
  extension_hex="$(
    print -rn -- "$extension_key" \
      | /usr/bin/base64 -D 2>/dev/null \
      | /usr/bin/openssl dgst -sha256 -binary 2>/dev/null \
      | /usr/bin/od -An -tx1 -N16 \
      | /usr/bin/tr -d ' \n'
  )" || return 1
  extension_id="$(print -rn -- "$extension_hex" | /usr/bin/tr '0-9a-f' 'a-p')"
  [[ "$extension_id" == "$expected_extension_id" ]] || return 1
  [[ "$(/usr/bin/awk 'NF == 2 { count += 1 } END { print count + 0 }' "$checksum_file")" == "${#extension_files}" ]] \
    || return 1
  for relative_path in $extension_files; do
    item="$extension_root/$relative_path"
    [[ -f "$item" && ! -L "$item" ]] || return 1
    expected_hash="$(/usr/bin/awk -v target="$relative_path" '$2 == target { print $1 }' "$checksum_file")"
    [[ "$expected_hash" =~ '^[0-9a-f]{64}$' ]] || return 1
    actual_hash="$(/usr/bin/shasum -a 256 "$item" | /usr/bin/awk '{ print $1 }')" || return 1
    [[ "$actual_hash" == "$expected_hash" ]] || return 1
  done
  node_count="$(/usr/bin/find "$extension_root" -mindepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" \
    || return 1
  [[ "$node_count" == "$(( ${#extension_files} + 1 ))" ]] || return 1
  for item in "$extension_root" "$extension_root/assets" "$checksum_file" "$extension_root"/**/*(DN); do
    [[ ! -L "$item" ]] || return 1
    mode="$(/usr/bin/stat -f '%Lp' "$item" 2>/dev/null)" || return 1
    owner="$(/usr/bin/stat -f '%u' "$item" 2>/dev/null)" || return 1
    [[ "$mode" =~ '^[0-7]+$' ]] || return 1
    [[ "$owner" == "$current_uid" ]] || return 1
    (( (8#$mode & 8#022) == 0 )) || return 1
  done
}

browser_present() {
  [[ (-e "$singleton_lock" || -L "$singleton_lock") && -S "$singleton_socket" ]]
}

browser_application_for_pid() {
  local pid="$1"
  local owner executable app_root bundle_id bundle_executable
  owner="$(/bin/ps -p "$pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ')"
  executable="$(/bin/ps -ww -p "$pid" -o comm= 2>/dev/null | /usr/bin/sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ "$owner" == "$(/usr/bin/id -u)" && "$executable" == /*.app/Contents/MacOS/'ego lite' ]] || return 1
  app_root="${executable%/Contents/MacOS/ego lite}"
  [[ -d "$app_root" && ! -L "$app_root" && -f "$app_root/Contents/Info.plist" ]] || return 1
  bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -expect string -o - "$app_root/Contents/Info.plist" 2>/dev/null)" \
    || return 1
  bundle_executable="$(/usr/bin/plutil -extract CFBundleExecutable raw -expect string -o - "$app_root/Contents/Info.plist" 2>/dev/null)" \
    || return 1
  [[ "$bundle_id" == "$expected_ego_bundle_id" && "$bundle_executable" == "ego lite" ]] || return 1
  print -r -- "$app_root"
}

current_browser_pid() {
  local target pid
  target="$(/usr/bin/readlink "$singleton_lock" 2>/dev/null || true)"
  pid="${target##*-}"
  [[ "$pid" =~ '^[0-9]+$' ]] || return 1
  browser_application_for_pid "$pid" >/dev/null || return 1
  print -r -- "$pid"
}

find_ego_browser() {
  local ego_pid="$1"
  local ego_app candidate
  ego_app="$(browser_application_for_pid "$ego_pid")" || return 1
  for candidate in \
    "$ego_app/Contents/Frameworks/ego Framework.framework/Helpers/ego-browser" \
    "${HOME:-}/.local/bin/ego-browser"; do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done
  return 1
}

load_extension_for_pid() {
  local ego_pid="$1"
  local ego_app ego_signature ego_browser manifest_version autoload_output="" current_pid temporary_marker delay result permanent_stage registry_state transient_stage error_kind autoload_exit task_id cleanup_output
  local extension_path_b64 expected_id_b64 manifest_version_b64 ego_pid_b64
  local -a delays
  ego_app="$(browser_application_for_pid "$ego_pid")" || return 2
  /usr/bin/codesign --verify --strict "$ego_app" >/dev/null 2>&1 || {
    log "ego-lite failed code-signature validation; automatic loading is disabled for this browser session."
    return 3
  }
  ego_signature="$(/usr/bin/codesign -dv --verbose=4 "$ego_app" 2>&1 || true)"
  [[ "$ego_signature" == *"Identifier=$expected_ego_bundle_id"* \
      && "$ego_signature" == *"TeamIdentifier=$expected_ego_team_id"* ]] || {
    log "ego-lite publisher validation failed; automatic loading is disabled for this browser session."
    return 3
  }
  ego_browser="$(find_ego_browser "$ego_pid")" || {
    log "ego-browser is unavailable; update ego-lite, then run Install Koe.command again."
    return 3
  }
  manifest_version="$(/usr/bin/plutil -extract version raw -expect string -o - "$extension_root/manifest.json" 2>/dev/null)" \
    || return 3
  extension_path_b64="$(print -rn -- "$extension_root" | /usr/bin/base64 | /usr/bin/tr -d '\n')"
  expected_id_b64="$(print -rn -- "$expected_extension_id" | /usr/bin/base64 | /usr/bin/tr -d '\n')"
  manifest_version_b64="$(print -rn -- "$manifest_version" | /usr/bin/base64 | /usr/bin/tr -d '\n')"
  ego_pid_b64="$(print -rn -- "$ego_pid" | /usr/bin/base64 | /usr/bin/tr -d '\n')"
  delays=(0.25 0.5 1 2 2 2 2 2 2 2 2 2 2 2 2 2)
  for delay in $delays; do
    current_pid="$(current_browser_pid || true)"
    [[ "$current_pid" == "$ego_pid" ]] || return 2
    if autoload_output="$(
      "$ego_browser" nodejs 2>&1 <<EOF
let task
let taskName = ''
let registryReady = false
let stage = 'decode-config'
try {
  const decode = (value) => {
    const bytes = atob(value)
    let escaped = ''
    for (let index = 0; index < bytes.length; index += 1) {
      escaped += '%' + bytes.charCodeAt(index).toString(16).padStart(2, '0')
    }
    return decodeURIComponent(escaped)
  }
  const expectedId = decode('$expected_id_b64')
  const expectedPath = decode('$extension_path_b64')
  const expectedVersion = decode('$manifest_version_b64')
  const egoPid = decode('$ego_pid_b64')
  stage = 'task-space'
  taskName = 'koe extension restore ' + egoPid
  task = await useOrCreateTaskSpace(taskName)
  if (task?.name !== taskName || task?.ownership === 'user') {
    throw new Error('KOE_AUTOLOAD_TASKSPACE_OWNERSHIP')
  }
  cliLog('KOE_AUTOLOAD_TASK:' + task.id)
  stage = 'get-before'
  const before = await cdp('Extensions.getExtensions', {}, null)
  registryReady = true
  stage = 'inspect-before'
  const sameId = before.extensions.filter((item) => item.id === expectedId)
  const conflicts = sameId.filter((item) => item.path !== expectedPath)
  if (conflicts.length) throw new Error('KOE_AUTOLOAD_CONFLICT')
  const current = sameId.find((item) => item.path === expectedPath)
  cliLog('KOE_AUTOLOAD_STATE:' + [sameId.length, current ? 1 : 0, current?.version === expectedVersion ? 1 : 0, current?.enabled === true ? 1 : 0].join(':'))
  if (!current || current.version !== expectedVersion || current.enabled !== true) {
    stage = 'load-unpacked'
    const loaded = await cdp('Extensions.loadUnpacked', {
      path: expectedPath
    }, null)
    if (loaded?.id !== expectedId) throw new Error('KOE_AUTOLOAD_ID_MISMATCH')
  }
  stage = 'get-after'
  const after = await cdp('Extensions.getExtensions', {}, null)
  stage = 'verify-after'
  const verified = after.extensions.find((item) => item.id === expectedId && item.path === expectedPath)
  if (!verified || verified.version !== expectedVersion || verified.enabled !== true) {
    throw new Error('KOE_AUTOLOAD_VERIFY_FAILED')
  }
  cliLog('KOE_AUTOLOAD_OK:' + verified.id + ':' + verified.version)
} catch (error) {
  const message = String(error?.message || error || '')
  const permanent = registryReady || /method (?:not found|wasn't found)|unknown method/i.test(message)
  const safeName = String(error?.name || 'Error').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  const safeCode = String(error?.code || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  cliLog('KOE_AUTOLOAD_ERROR:' + safeName + ':' + (safeCode || 'none'))
  cliLog((permanent ? 'KOE_AUTOLOAD_PERMANENT:' : 'KOE_AUTOLOAD_TRANSIENT:') + stage)
  throw error
}
EOF
    )"; then
      autoload_exit=0
    else
      autoload_exit=$?
    fi
    task_id="$(print -r -- "$autoload_output" \
      | /usr/bin/sed -n 's/.*KOE_AUTOLOAD_TASK:\([0-9][0-9]*\).*/\1/p' \
      | /usr/bin/head -n 1)"
    if (( autoload_exit == 0 )) \
        && [[ "$autoload_output" == *"KOE_AUTOLOAD_OK:$expected_extension_id:$manifest_version"* ]] \
        && [[ ! "$task_id" =~ '^[0-9]+$' ]]; then
      log "Koe loaded, but its internal task ownership could not be verified; restart ego-lite to retry safely."
      return 3
    fi
    cleanup_output=""
    if [[ "$task_id" =~ '^[0-9]+$' ]]; then
      cleanup_output="$(
        "$ego_browser" nodejs 2>&1 <<EOF
const taskId = Number('$task_id')
const spaces = await listTaskSpaces()
const target = spaces.find((space) => Number(space.id) === taskId)
const managedName = String(target?.name || '')
if (!target || !managedName.startsWith('koe extension restore ') || target.ownership === 'user') {
  throw new Error('KOE_AUTOLOAD_CLEANUP_OWNERSHIP')
}
const result = await completeTaskSpace(taskId, { keep: false })
if (!result?.done) throw new Error('KOE_AUTOLOAD_CLEANUP_FAILED')
cliLog('KOE_AUTOLOAD_CLEANUP_OK')
EOF
      )" || true
      if [[ "$cleanup_output" != *"KOE_AUTOLOAD_CLEANUP_OK"* ]]; then
        log "Koe left its temporary task space untouched because ownership cleanup could not be verified."
        return 3
      fi
    fi
    if (( autoload_exit == 0 )) \
        && [[ "$autoload_output" == *"KOE_AUTOLOAD_OK:$expected_extension_id:$manifest_version"* ]]; then
      /bin/mkdir -p "$state_root"
      temporary_marker="$(/usr/bin/mktemp "$state_root/.ego-lite.pid.XXXXXX")"
      print -rl -- "$ego_pid" "$manifest_version" >"$temporary_marker"
      /bin/chmod 600 "$temporary_marker"
      /bin/mv -f "$temporary_marker" "$pid_marker"
      log "Koe $manifest_version loaded into ego-lite process $ego_pid."
      return 0
    fi
    if [[ "$autoload_output" == *"KOE_AUTOLOAD_CONFLICT"* ]]; then
      log "Koe is already loaded from another directory; restart ego-lite to activate the managed copy."
      return 3
    fi
    if [[ "$autoload_output" == *"KOE_AUTOLOAD_PERMANENT"* ]]; then
      permanent_stage="$(print -r -- "$autoload_output" \
        | /usr/bin/sed -n 's/.*KOE_AUTOLOAD_PERMANENT:\([a-z-]*\).*/\1/p' \
        | /usr/bin/head -n 1)"
      registry_state="$(print -r -- "$autoload_output" \
        | /usr/bin/sed -n 's/.*KOE_AUTOLOAD_STATE:\([0-9:]\{7\}\).*/\1/p' \
        | /usr/bin/head -n 1)"
      log "Koe could not be loaded at ${permanent_stage:-unknown-stage} (state ${registry_state:-unknown}); reinstall Koe before retrying."
      return 3
    fi
    if [[ "$autoload_output" == *"KOE_AUTOLOAD_TRANSIENT"* ]]; then
      transient_stage="$(print -r -- "$autoload_output" \
        | /usr/bin/sed -n 's/.*KOE_AUTOLOAD_TRANSIENT:\([a-z-]*\).*/\1/p' \
        | /usr/bin/head -n 1)"
    fi
    /bin/sleep "$delay"
  done
  error_kind="$(print -r -- "$autoload_output" \
    | /usr/bin/sed -n 's/.*KOE_AUTOLOAD_ERROR:\([A-Za-z0-9_-]*:[A-Za-z0-9_-]*\).*/\1/p' \
    | /usr/bin/head -n 1)"
  log "Koe could not connect to ego-lite within 30 seconds (stage ${transient_stage:-unknown}, ${error_kind:-unknown-error}); restart ego-lite to retry."
  return 1
}

/bin/mkdir -p "$state_root"
/bin/chmod 700 "$state_root"

if ! browser_present; then
  exit 0
fi

if ! validate_extension; then
  log "Koe Extension failed identity or permission validation; automatic loading is disabled for this browser session."
  while browser_present; do /bin/sleep 30; done
  exit 0
fi

last_pid=""
missing_ticks=0
while true; do
  ego_pid="$(current_browser_pid || true)"
  if [[ -n "$ego_pid" ]]; then
    missing_ticks=0
    if [[ "$ego_pid" != "$last_pid" ]]; then
      if load_extension_for_pid "$ego_pid"; then
        last_pid="$ego_pid"
      else
        result=$?
        if (( result == 2 )); then
          last_pid=""
        elif (( result == 3 )); then
          last_pid="$ego_pid"
        else
          last_pid="$ego_pid"
        fi
      fi
    fi
    /bin/sleep 2
    continue
  fi
  if ! browser_present; then
    (( missing_ticks += 1 ))
    (( missing_ticks >= 3 )) && exit 0
    /bin/sleep 1
  else
    # Socket 已就绪但 PID 锁还在切换时低频等待，不启动或干预浏览器。
    missing_ticks=0
    /bin/sleep 10
  fi
done
