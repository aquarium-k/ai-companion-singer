@echo off
REM Launch outside of any shell sandbox, directly from Explorer.
REM Double-click this file if `pnpm dev` keeps failing with 0xFFFF7003.
REM
REM Build policy (2026-11-13): rebuild only when dist is older than src/public,
REM via scripts\ensure-dist.mjs. That script is silent when dist is fresh and
REM prints one line when it (re)builds, so double-clicking stays quiet.
REM Set PET_SKIP_BUILD=1 to skip the check entirely.
REM
REM Extra arguments are forwarded to Electron, e.g.:
REM   run.bat --query "att=ra"
REM NOTE: keep this file ASCII-only. cmd.exe reads .bat in the OEM codepage
REM and UTF-8 Chinese bytes can be mis-parsed as & | > and break the script.
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

if not "%PET_SKIP_BUILD%"=="1" (
  call node "%~dp0scripts\ensure-dist.mjs"
  if errorlevel 1 (
    echo.
    echo Build failed, not starting Electron ^(see output above^).
    pause
    exit /b 1
  )
)

"%~dp0node_modules\electron\dist\electron.exe" --no-sandbox --user-data-dir="%~dp0.tmp\electron-profile" --crash-dumps-dir="%~dp0.tmp\electron-crashes" . %*

echo.
echo Electron exited with code %ERRORLEVEL%
pause
