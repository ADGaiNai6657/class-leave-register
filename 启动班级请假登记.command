#!/bin/bash
# 班级请假登记 —— 双击本文件即可启动（macOS）
#
# 关闭这个终端窗口（或按 Control+C）就会退出程序，
# 本次填写的内容不会保存到任何地方。

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR" || exit 1

# 找到 Node.js（优先使用当前 PATH，其次常见安装位置）
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "未找到 Node.js，无法启动。"
  echo "请先安装 Node.js（https://nodejs.org/ 或 brew install node），然后重新双击本文件。"
  echo "按回车键关闭窗口。"
  read -r _
  exit 1
fi

echo "正在启动「班级请假登记」……"
exec "$NODE_BIN" "$APP_DIR/server.js" "$@"
