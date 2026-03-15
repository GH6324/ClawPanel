#!/bin/bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR=${1:-"$ROOT_DIR/lite-assets/plugins"}
GLOBAL_NODE_ROOT=${GLOBAL_NODE_ROOT:-}
OPENCLAW_CONFIG_ROOT=${OPENCLAW_CONFIG_ROOT:-"$HOME/openclaw/config"}
PLUGIN_REPO_ROOT=${PLUGIN_REPO_ROOT:-"$HOME/ClawPanel-Plugins/official"}
OPENCLAW_APP_ROOT=${OPENCLAW_APP_ROOT:-"/usr/lib/node_modules/openclaw"}
TARGET_OS=${TARGET_OS:-linux}
TMP_NPM_DIR=${TMP_NPM_DIR:-$(mktemp -d)}

cleanup() {
  rm -rf "$TMP_NPM_DIR"
}
trap cleanup EXIT

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

first_existing_dir() {
  local candidate
  for candidate in "$@"; do
    if [[ -n "$candidate" && -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

copy_dir() {
  local name=$1
  shift
  local src
  if ! src=$(first_existing_dir "$@"); then
    echo "跳过插件: $name (未找到候选目录)" >&2
    return 0
  fi
  rm -rf "$OUT_DIR/$name"
  cp -a "$src" "$OUT_DIR/$name"
  echo "已收集插件: $name <- $src"
}

copy_npm_pkg() {
  local install_spec=$1
  local package_dir=$2
  local target_name=$3
  local src="$TMP_NPM_DIR/node_modules/$package_dir"
  if [[ ! -d "$src" ]]; then
    echo "跳过插件: $target_name (未找到 npm 安装目录 $src)" >&2
    return 0
  fi
  rm -rf "$OUT_DIR/$target_name"
  cp -a "$src" "$OUT_DIR/$target_name"
  echo "已收集插件: $target_name <- $install_spec"
}

rewrite_wecom_manifest() {
  python3 - <<'PY' "$OUT_DIR/wecom/package.json" "$OUT_DIR/wecom/openclaw.plugin.json"
import json, sys
package_path, manifest_path = sys.argv[1:3]
with open(package_path, 'r', encoding='utf-8') as f:
    pkg = json.load(f)
pkg.setdefault('openclaw', {}).setdefault('channel', {})['id'] = 'wecom'
pkg['openclaw'].setdefault('install', {})['localPath'] = 'extensions/wecom'
with open(package_path, 'w', encoding='utf-8') as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2)
    f.write('\n')
with open(manifest_path, 'r', encoding='utf-8') as f:
    manifest = json.load(f)
manifest['id'] = 'wecom'
with open(manifest_path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
}

# 把 @sunnoy/wecom 的 plugin id 改为 wecom-app，channel 路由标识保持 wecom
rewrite_wecom_app_manifest() {
  python3 - <<'PY' "$OUT_DIR/wecom-app/openclaw.plugin.json" "$OUT_DIR/wecom-app/index.js" "$OUT_DIR/wecom-app/wecom/channel-plugin.js"
import json, sys, re

manifest_path, index_path, channel_plugin_path = sys.argv[1:4]

# 1. openclaw.plugin.json: id -> wecom-app, channels 保持 wecom
with open(manifest_path, 'r', encoding='utf-8') as f:
    manifest = json.load(f)
manifest['id'] = 'wecom-app'
manifest['channels'] = ['wecom']  # channel 路由标识不变
with open(manifest_path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write('\n')

# 2. index.js: 只改顶层 plugin id 那一行
with open(index_path, 'r', encoding='utf-8') as f:
    content = f.read()
content = re.sub(r'^  id: "wecom",', '  id: "wecom-app",', content, count=1, flags=re.MULTILINE)
with open(index_path, 'w', encoding='utf-8') as f:
    f.write(content)

# 3. channel-plugin.js: channel 的 id/meta.id 保持 wecom，不改动
# （channel: "wecom" 消息路由标识全部保持，不替换）

print("wecom-app manifest rewritten: plugin id=wecom-app, channel id=wecom")
PY
}

if [[ -z "$GLOBAL_NODE_ROOT" ]]; then
  for candidate in \
    "/usr/lib/node_modules" \
    "/usr/local/lib/node_modules" \
    "$HOME/.npm-global/lib/node_modules" \
    "$HOME/.local/lib/node_modules"; do
    if [[ -d "$candidate" ]]; then
      GLOBAL_NODE_ROOT="$candidate"
      break
    fi
  done
fi

echo "==> 安装 Lite 预置插件候选 npm 包"
npm install --omit=dev --registry=https://registry.npmmirror.com --prefix "$TMP_NPM_DIR" \
  clawdbot-dingtalk@0.4.6 \
  @sliverp/qqbot@1.5.3 \
  @wecom/wecom-openclaw-plugin@1.0.6 \
  @sunnoy/wecom@1.5.0 >/dev/null

if [[ "$TARGET_OS" == "linux" ]]; then
  copy_dir "qq" \
    "$PLUGIN_REPO_ROOT/qq" \
    "$OPENCLAW_CONFIG_ROOT/extensions/qq"
fi
copy_npm_pkg "@sliverp/qqbot@1.5.3" "@sliverp/qqbot" "qqbot"
# 企业微信智能机器人（内置官方插件）
copy_npm_pkg "@wecom/wecom-openclaw-plugin@1.0.6" "@wecom/wecom-openclaw-plugin" "wecom"
if [[ -f "$OUT_DIR/wecom/openclaw.plugin.json" ]]; then
  rewrite_wecom_manifest
fi
# 企业微信自建应用（@sunnoy/wecom，plugin id 改写为 wecom-app 避免冲突）
copy_npm_pkg "@sunnoy/wecom@1.5.0" "@sunnoy/wecom" "wecom-app"
if [[ -f "$OUT_DIR/wecom-app/openclaw.plugin.json" ]]; then
  rewrite_wecom_app_manifest
fi
if [[ "$TARGET_OS" == "linux" ]]; then
  copy_dir "dingtalk" \
    "$OPENCLAW_CONFIG_ROOT/extensions/dingtalk" \
    "$PLUGIN_REPO_ROOT/dingtalk" \
    "$OPENCLAW_CONFIG_ROOT/extensions/dingtalk"
else
  copy_npm_pkg "clawdbot-dingtalk@0.4.6" "clawdbot-dingtalk" "dingtalk"
fi

echo "Lite 预置插件目录已输出到: $OUT_DIR"
