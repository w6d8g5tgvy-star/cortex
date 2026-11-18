@echo off
REM Windows: double-click to start Cortex and open the dashboard.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required. Opening https://nodejs.org ... & start https://nodejs.org & pause & exit /b 1)
title Cortex
node bin\cortex.js start --open
pause
