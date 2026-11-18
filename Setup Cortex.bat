@echo off
REM Windows: double-click once to set everything up, then Cortex opens with the phone QR code.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required. Opening https://nodejs.org ... & start https://nodejs.org & pause & exit /b 1)
title Cortex Setup
node bin\cortex.js setup
if errorlevel 1 (pause & exit /b 1)
node bin\cortex.js start --open-settings
pause
