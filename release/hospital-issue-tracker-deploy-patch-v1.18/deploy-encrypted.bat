@echo off
chcp 65001 >nul
setlocal
set "SCRIPT=%~dp0deploy-encrypted.ps1"
REM self-elevate to Administrator, then forward any args (e.g. -InstallDir "D:\hospital-issue")
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList (@('-NoProfile','-ExecutionPolicy Bypass','-File','%SCRIPT%') + $args) -Wait" %*
endlocal
