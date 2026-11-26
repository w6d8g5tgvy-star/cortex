@echo off
setlocal
title Install Cortex
REM Cortex installer for Windows. Double-click to run. Safe to run again (it updates Cortex).
set "HUB="
set "CODE="
set "MODE=main"
set "STANDBY=0"
set "APP=%USERPROFILE%\Cortex-app"
set "RUNNER=%USERPROFILE%\.cortex-runner"
echo.
echo  Installing Cortex. This takes a few minutes; keep this window open.
echo.
if not "%MODE%"=="computer" goto node
echo [1/4] Pairing this computer with your main Cortex...
if not exist "%RUNNER%" mkdir "%RUNNER%"
curl.exe -s -f -X POST "%HUB%/api/pair" -H "Content-Type: application/json" -d "{\"code\":\"%CODE%\",\"name\":\"%COMPUTERNAME%\",\"platform\":\"windows %COMPUTERNAME%\",\"format\":\"runner-config\",\"hub\":\"%HUB%\"}" -o "%RUNNER%\config.json"
if errorlevel 1 (echo. & echo  Pairing failed: the code may have expired or your main computer is off. Make a new code in Cortex: Settings, Devices, Add a computer. & pause & exit /b 1)
:node
echo [2/4] Checking Node.js...
where node >nul 2>nul && goto havenode
if exist "%ProgramFiles%\nodejs\node.exe" goto addnode
echo  Installing Node.js (you may be asked to allow it)...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
:addnode
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul || (echo. & echo  Node.js could not be installed automatically. Install the LTS version from nodejs.org, then run this installer again. & start https://nodejs.org & pause & exit /b 1)
:havenode
for /f "delims=" %%i in ('where node') do (set "NODE=%%i" & goto gotnode)
:gotnode
echo [3/4] Downloading Cortex...
set "TMPD=%TEMP%\cortex-install-%RANDOM%"
mkdir "%TMPD%"
curl.exe -L -f -s -o "%TMPD%\cortex.zip" "https://codeload.github.com/w6d8g5tgvy-star/cortex/zip/refs/heads/main"
if errorlevel 1 (echo  Download failed. Check your internet connection and run this again. & pause & exit /b 1)
tar -xf "%TMPD%\cortex.zip" -C "%TMPD%"
if errorlevel 1 (echo  Could not unpack Cortex. & pause & exit /b 1)
if exist "%APP%\bin\cortex.js" (robocopy "%TMPD%\cortex-main" "%APP%" /E /NFL /NDL /NJH /NJS /NP >nul) else (move "%TMPD%\cortex-main" "%APP%" >nul)
rmdir /s /q "%TMPD%" 2>nul
if not exist "%APP%\bin\cortex.js" (echo  Cortex could not be put in place at %APP%. & pause & exit /b 1)
echo [4/4] Setting up...
if "%MODE%"=="computer" goto computer
"%NODE%" "%APP%\bin\cortex.js" setup
start "Cortex" /min "%NODE%" "%APP%\bin\cortex.js" start --open-settings
echo.
echo  Done. Cortex is open in your browser and starts by itself when you sign in.
timeout /t 8 >nul
exit /b 0
:computer
set "ARGS=runner"
if "%STANDBY%"=="1" set "ARGS=runner --standby"
> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Cortex runner.cmd" echo @start "Cortex runner" /min "%NODE%" "%APP%\bin\cortex.js" %ARGS%
start "Cortex runner" /min "%NODE%" "%APP%\bin\cortex.js" %ARGS%
echo.
if "%STANDBY%"=="1" (echo  Done. This computer is connected to your main Cortex and keeps a standby copy: if the main computer is off, Cortex opens here at http://localhost:7777) else (echo  Done. This computer is connected to your main Cortex and can run agent jobs.)
echo  It starts by itself when you sign in. To remove it: delete "Cortex runner" from your Startup folder and remove the computer in Cortex, Settings, Devices.
pause
