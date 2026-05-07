#!/usr/bin/env bash
# 安装 systemd --user 单元，使 play-ppt 在后台长期运行（崩溃自动重启）。
# 默认：npm run start:prod（需已构建；脚本会默认先执行 npm run build）
# 可选：--dev → npm run dev（热更新；不建议与「生产常驻」混用，但适合本机长期联调）
set -euo pipefail

usage() {
  echo "用法: $0 [--dev] [--no-build] [--unit-name NAME]"
  echo "  --dev         使用 npm run dev（默认: npm run start:prod）"
  echo "  --no-build    跳过 npm run build（默认会先 build，--dev 时默认也跳过）"
  echo "  --unit-name   systemd 单元名（默认: playppt），不含 .service 后缀"
  exit 1
}

MODE="prod"
DO_BUILD=1
UNIT_NAME="playppt"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) MODE="dev"; DO_BUILD=0 ;;
    --no-build) DO_BUILD=0 ;;
    --unit-name)
      shift
      [[ $# -gt 0 ]] || usage
      UNIT_NAME="$1"
      ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/${UNIT_NAME}.service"

if [[ "$MODE" == "dev" ]]; then
  MODE_LABEL="dev: npm run dev"
  NPM_SCRIPT="npm run dev"
else
  MODE_LABEL="prod: npm run start:prod"
  NPM_SCRIPT="npm run start:prod"
fi

if [[ "$DO_BUILD" == 1 ]]; then
  echo "==> npm run build（仓库: $REPO）"
  (cd "$REPO" && npm run build)
else
  echo "==> 已跳过 build（--no-build 或 --dev）"
fi

systemctl --user stop "${UNIT_NAME}.service" 2>/dev/null || true
# 避免与之前手动起的 npm run dev 抢端口（前端默认 35172、后端 3001）
fuser -k 35172/tcp 3001/tcp 2>/dev/null >/dev/null || true
sleep 1

mkdir -p "$UNIT_DIR"
TMP="$(mktemp)"
sed -e "s|__PLAYPPT_ROOT__|${REPO//\\/\\\\}|g" \
    -e "s|__MODE_LABEL__|${MODE_LABEL}|g" \
    -e "s|__NPM_SCRIPT__|${NPM_SCRIPT//\\/\\\\}|g" \
    "$SCRIPT_DIR/playppt.service.in" >"$TMP"
mv "$TMP" "$UNIT_PATH"
echo "==> 已写入 $UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}.service"
systemctl --user restart "${UNIT_NAME}.service" 2>/dev/null || systemctl --user start "${UNIT_NAME}.service"

echo ""
echo "==> 已启用并启动: ${UNIT_NAME}.service"
echo "    查看日志: journalctl --user -u ${UNIT_NAME} -f"
echo "    状态:     systemctl --user status ${UNIT_NAME}"
echo "    停止:     systemctl --user stop ${UNIT_NAME}"
echo "    取消自启: systemctl --user disable ${UNIT_NAME}"
echo ""

if loginctl show-user "${USER}" 2>/dev/null | grep -q 'Linger=no'; then
  echo "提示：当前用户未开启 loginctl linger，注销/无图形会话时 user 服务可能被停掉。"
  echo "若要在「未登录桌面」时也保持运行，请执行（需管理员或已允许）："
  echo "    sudo loginctl enable-linger $USER"
  echo ""
fi
