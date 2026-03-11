#!/bin/bash
set -euo pipefail

INSTALL_DIR="/opt/clawpanel-lite"
SERVICE_LABEL="com.clawpanel.lite.service"
REPO="zhaoxinyi02/ClawPanel"
TAG_PREFIX="lite-v"
ACCEL_BASE="http://39.102.53.188:16198/clawpanel"
ACCEL_META_URL="${ACCEL_BASE}/update-lite.json"
GITHUB_RELEASES_API="https://api.github.com/repos/${REPO}/releases?per_page=20"
DEFAULT_VERSION="0.1.4"

log(){ printf '[Lite] %s\n' "$1"; }
err(){ printf '[Lite] %s\n' "$1" >&2; exit 1; }

fetch_text() {
  if command -v curl >/dev/null 2>&1; then
    curl --connect-timeout 8 --max-time 20 -fsSL "$1"
  else
    return 1
  fi
}

detect_arch() {
  case "$(uname -m)" in
    arm64) echo "arm64" ;;
    x86_64) echo "amd64" ;;
    *) err "暂不支持的 macOS 架构: $(uname -m)" ;;
  esac
}

get_latest_version_from_github() {
  local body tag
  body=$(fetch_text "$GITHUB_RELEASES_API" 2>/dev/null || true)
  tag=$(printf '%s' "$body" | awk -v prefix="$TAG_PREFIX" -F'"' '$2=="tag_name" && index($4,prefix)==1 {print $4; exit}')
  [[ -n "$tag" ]] && printf '%s\n' "${tag#${TAG_PREFIX}}"
}

get_latest_version_from_accel() {
  local body ver
  body=$(fetch_text "$ACCEL_META_URL" 2>/dev/null || true)
  ver=$(printf '%s' "$body" | awk -F'"' '/"latest_version"/ {print $4; exit}')
  [[ -n "$ver" ]] && printf '%s\n' "$ver"
}

normalize_source(){ case "${1:-}" in github) echo github;; accel) echo accel;; *) echo "";; esac; }
other_source(){ [[ "$1" == github ]] && echo accel || echo github; }

choose_download_source() {
  DOWNLOAD_SOURCE=$(normalize_source "${DOWNLOAD_SOURCE:-}")
  if [[ -n "$DOWNLOAD_SOURCE" ]]; then return; fi
  echo "请选择下载线路："
  echo "  1) GitHub（中国香港及境外服务器推荐）"
  echo "  2) 加速服务器（中国大陆服务器推荐）"
  if [[ -t 0 ]]; then
    read -r -p "请输入 [1/2]（默认 1）: " source_choice
    case "$source_choice" in
      2) DOWNLOAD_SOURCE=accel ;;
      *) DOWNLOAD_SOURCE=github ;;
    esac
  else
    DOWNLOAD_SOURCE=github
  fi
}

download_file() { curl --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 2 --retry-connrefused -fL "$1" -o "$2"; }

choose_download_source
ARCH=$(detect_arch)
VERSION=${VERSION:-$( [[ "$DOWNLOAD_SOURCE" == github ]] && get_latest_version_from_github || get_latest_version_from_accel )}
VERSION=${VERSION:-$( [[ "$DOWNLOAD_SOURCE" == github ]] && get_latest_version_from_accel || get_latest_version_from_github )}
VERSION=${VERSION:-$DEFAULT_VERSION}
PACKAGE_NAME="clawpanel-lite-core-v${VERSION}-darwin-${ARCH}.tar.gz"

PRIMARY_URL="${ACCEL_BASE}/releases/${PACKAGE_NAME}"
SECONDARY_URL="https://github.com/${REPO}/releases/download/${TAG_PREFIX}${VERSION}/${PACKAGE_NAME}"
if [[ "$DOWNLOAD_SOURCE" == github ]]; then
  PRIMARY_URL="$SECONDARY_URL"
  SECONDARY_URL="${ACCEL_BASE}/releases/${PACKAGE_NAME}"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

[[ $(id -u) -eq 0 ]] || err "请使用 sudo 运行 macOS Lite 安装脚本。"

log "下载 ClawPanel Lite v${VERSION}..."
download_file "$PRIMARY_URL" "$TMP_DIR/$PACKAGE_NAME" || download_file "$SECONDARY_URL" "$TMP_DIR/$PACKAGE_NAME" || err "下载失败"

mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR"/*
tar -xzf "$TMP_DIR/$PACKAGE_NAME" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/clawpanel-lite" "$INSTALL_DIR/bin/clawlite-openclaw"
ln -sf "$INSTALL_DIR/clawpanel-lite" /usr/local/bin/clawpanel-lite
ln -sf "$INSTALL_DIR/bin/clawlite-openclaw" /usr/local/bin/clawlite-openclaw

cat > "/Library/LaunchDaemons/${SERVICE_LABEL}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${INSTALL_DIR}/clawpanel-lite</string></array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAWPANEL_EDITION</key><string>lite</string>
    <key>CLAWPANEL_DATA</key><string>${INSTALL_DIR}/data</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout system "/Library/LaunchDaemons/${SERVICE_LABEL}.plist" >/dev/null 2>&1 || true
launchctl bootstrap system "/Library/LaunchDaemons/${SERVICE_LABEL}.plist"
launchctl kickstart -k "system/${SERVICE_LABEL}"

log "ClawPanel Lite macOS 安装完成：${INSTALL_DIR}"
