#!/usr/bin/env bash
# ============================================================
# 绝顶赵博客 · 文章管理后台 快速启动脚本（macOS / Linux / Git Bash）
# 依赖：Node.js 18 及以上（https://nodejs.org）
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "未找到 Node.js，请先安装 Node.js 18 及以上版本：https://nodejs.org"
    exit 1
fi

PORT="${PORT:-8618}"

echo ""
echo "  绝顶赵 · 文章管理后台"
echo "  地址：http://127.0.0.1:${PORT}"
echo "  按 Ctrl+C 停止服务"
echo ""

# 尝试自动打开浏览器（失败不影响启动）
( sleep 1
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:${PORT}" >/dev/null 2>&1
  elif command -v open >/dev/null 2>&1; then open "http://127.0.0.1:${PORT}" >/dev/null 2>&1
  fi ) &

exec node admin/server.js
