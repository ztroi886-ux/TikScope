@echo off
REM ===========================================================================
REM  ARYOS GROUP - run the site and the bot on this computer
REM
REM  Double-click this file. It starts one process that serves BOTH:
REM    the website  ->  http://localhost:10000
REM    the Telegram bot (polling)
REM
REM  Close this window to stop both. Settings come from the .env file.
REM
REM  WARNING: Telegram allows only ONE poller per bot. If your hosted copy
REM  (Render / Railway) is running, it and this one will fight over messages.
REM  Pause the hosted service first, or start with WEBSITE ONLY below.
REM
REM  WEBSITE ONLY (no bot, safe alongside the hosted copy):
REM      set TELEGRAM_BOT_TOKEN=
REM      py -3 app.py
REM ===========================================================================

title Aryos Group - local
cd /d "%~dp0"

py -3 --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Python was not found.
    echo   Install it from https://www.python.org/downloads/ and tick
    echo   "Add python.exe to PATH", then run this again.
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo.
    echo   No .env file found next to app.py.
    echo   The website will still run; the bot needs TELEGRAM_BOT_TOKEN.
    echo.
)

if not defined PORT set PORT=10000

echo Starting on http://localhost:%PORT%  -  press Ctrl+C to stop.
echo.

REM -u = unbuffered, so the banner and bot messages appear immediately
start "" "http://localhost:%PORT%/index.html"
py -3 -u app.py

echo.
echo The server has stopped. Press any key to close.
pause >nul
