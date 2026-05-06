#!/usr/bin/env bash
# 生成本机 LaunchAgent plist 并注册（登录后自动执行 npm run start:prod）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLIST_SRC="$REPO_ROOT/scripts/macos/launchd/com.playppt.app.plist.example"
DEST="$HOME/Library/LaunchAgents/com.playppt.app.plist"
LOG_DIR="${HOME}/Library/Logs/play-ppt"
USER_ID="$(id -u)"

if [[ ! -f "$PLIST_SRC" ]]; then
  echo "找不到模板: $PLIST_SRC" >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/apps/server/dist/index.js" ]]; then
  echo "尚未构建后端产物（缺少 apps/server/dist/index.js）。请先在本仓库根目录执行：" >&2
  echo "  npm install && npm run build" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

python3 -c "
from pathlib import Path
repo = Path(r'''$REPO_ROOT''')
log = Path(r'''$LOG_DIR''')
src = Path(r'''$PLIST_SRC''')
dst = Path(r'''$DEST''')
text = src.read_text(encoding='utf-8')
text = text.replace('__PLAY_PPT_ROOT__', str(repo))
text = text.replace('__PLAY_PPT_LOG_DIR__', str(log))
dst.write_text(text, encoding='utf-8')
"

# 已加载则先卸掉（避免重复注册）
if launchctl print "gui/${USER_ID}/com.playppt.app" &>/dev/null; then
  launchctl bootout "gui/${USER_ID}/com.playppt.app" 2>/dev/null || true
fi

launchctl bootstrap "gui/${USER_ID}" "$DEST"

echo "已写入并注册: $DEST"
echo "日志: $LOG_DIR/play-ppt.out.log 与 play-ppt.err.log"
echo "立即重启任务: launchctl kickstart -k gui/${USER_ID}/com.playppt.app"
echo "卸载: launchctl bootout gui/${USER_ID}/com.playppt.app"
