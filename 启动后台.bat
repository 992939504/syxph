@echo off
rem ============================================================
rem 绝顶赵博客 · 文章管理后台 快速启动脚本（Windows）
rem 依赖：Node.js 18 及以上（https://nodejs.org）
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo 未找到 Node.js，请先安装 Node.js 18 及以上版本：https://nodejs.org
    pause
    exit /b 1
)

if "%PORT%"=="" set PORT=8618

echo.
echo   绝顶赵 · 文章管理后台
echo   地址：http://127.0.0.1:%PORT%
echo   按 Ctrl+C 停止服务
echo.

start "" "http://127.0.0.1:%PORT%"

node admin\server.js
