@echo off
chcp 936 >nul
title 医院信息科 - 软件问题登记系统 [服务运行中]
cd /d "%~dp0"

echo ============================================================
echo    医院信息科 · 软件问题登记系统 —— 服务运行窗口
echo ------------------------------------------------------------
echo    程序目录 : %cd%
echo    访问地址 : http://localhost:3000
echo    停止服务 : 关闭本窗口，或按 Ctrl+C
echo ============================================================
echo.

if not exist "runtime\node.exe" (
  color 0C
  echo [错误] 未找到 runtime\node.exe —— 请确认压缩包解压完整，
  echo        runtime 目录必须与本脚本在同一个目录下。
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr ":3000 " | findstr /i "LISTENING" >nul
if %errorlevel%==0 (
  color 0E
  echo [提示] 端口 3000 已被监听 —— 服务很可能已经在运行了。
  echo        请用浏览器访问 http://localhost:3000 验证；
  echo        如需重启，请先运行 stop.bat（或关闭旧的运行窗口）再运行本脚本。
  echo.
  pause
  exit /b 0
)

echo [启动] 正在启动后端服务，启动成功的标志是下方出现：
echo        "[issue-tracker] listening on http://localhost:3000"
echo.
cd backend
set _enc=0
if exist "src\index.js.enc" if not exist "src\index.js" set _enc=1
if %_enc%==1 (
    echo [switch] Encrypted source detected, booting with loader...
    ..\runtime\node.exe --import ./loader.mjs start-enc.mjs
) else (
    ..\runtime\node.exe src\index.js
)

echo.
color 0C
echo ============================================================
echo [异常] 服务进程已退出（正常情况下本窗口应一直显示运行信息）。
echo        请把本窗口上方的报错信息截图，反馈给系统维护人员。
echo ============================================================
pause
