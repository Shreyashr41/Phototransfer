@echo off
setlocal
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
  echo [SnapBridge] Creating Python environment...
  python -m venv .venv || goto :fail
  .venv\Scripts\python -m pip install -q -r requirements.txt || goto :fail
)

if not exist frontend\dist\index.html (
  echo [SnapBridge] Building frontend ^(first run only^)...
  pushd frontend
  call npm install --no-audit --no-fund || (popd & goto :fail)
  call npm run build || (popd & goto :fail)
  popd
)

.venv\Scripts\python run.py
goto :eof

:fail
echo.
echo [SnapBridge] Setup failed. Make sure Python 3.10+ and Node.js 18+ are installed.
pause
exit /b 1
