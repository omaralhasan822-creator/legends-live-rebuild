@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo -------------------------------------
echo    LEGENDS LIVE - GAME SERVER
echo -------------------------------------
python -m pip install -r requirements.txt
if errorlevel 1 (
 echo Python required. Install Python 3.10 or newer.
 pause
 exit /b 1
)
echo Open http://localhost:8000 in your browser.
python -m uvicorn server:app --host 0.0.0.0 --port 8000
pause
