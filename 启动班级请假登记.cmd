@echo off
chcp 65001 >nul
rem 班级请假登记 —— 双击本文件即可启动（Windows）
rem
rem 关闭这个命令行窗口（或按 Ctrl+C）就会退出程序，
rem 本次填写的内容不会保存到任何地方。

setlocal
cd /d "%~dp0"

rem 查找 Node.js（优先使用当前 PATH）
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，无法启动。
  echo 请先安装 Node.js（https://nodejs.org/），然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo 正在启动「班级请假登记」……
node "%~dp0server.js" %*
