@echo off
rem Starts AI Talk on http://127.0.0.1:8070 and opens it in Microsoft Edge.
rem The first start installs everything (needs internet).
rem Note for editing: no unescaped round brackets in echo lines inside if-blocks,
rem cmd then stops with "... was unexpected" and the window closes at once.
cd /d "%~dp0"
set MODEL=gemma3:4b

rem The Claude API key lives in backend\.env: create the file once so it is easy to find
if not exist backend\.env if exist backend\.env.example copy /y backend\.env.example backend\.env >nul

set CLAUDE=0
powershell -NoProfile -Command "if ((Get-Content 'backend\.env' -ErrorAction SilentlyContinue) -match '^\s*ANTHROPIC_API_KEY\s*=\s*\S') { exit 0 } else { exit 1 }"
if not errorlevel 1 set CLAUDE=1
if "%CLAUDE%"=="1" echo Main AI: Claude - the API key in backend\.env is used. Ollama is optional.
if "%CLAUDE%"=="0" echo Main AI: Ollama on this laptop - there is no Claude API key in backend\.env.

call :ollama
if not errorlevel 1 goto :python
if "%CLAUDE%"=="0" goto :need_ollama
echo   Warning: the local AI Ollama is not available. Claude works, the Ollama switch does not.

:python
if not exist backend\.venv (
  echo Creating the Python environment ...
  python -m venv backend\.venv || goto :error
)
backend\.venv\Scripts\python -c "import anthropic, fastapi, uvicorn, httpx" 2>nul
if errorlevel 1 (
  echo Installing Python packages ...
  backend\.venv\Scripts\python -m pip install -q -r backend\requirements.txt || goto :error
)

pushd frontend
if not exist node_modules (
  echo Installing website packages ...
  call npm install --no-audit --no-fund || goto :error
)
echo Building the website ...
call npm run build >nul || goto :error
popd

echo.
echo   AI Talk is running: http://127.0.0.1:8070
if "%CLAUDE%"=="1" echo   AI: Claude Opus 5.5 in the cloud. You can switch to Ollama in the settings.
if "%CLAUDE%"=="0" echo   AI: Ollama on this laptop.
echo   Use Microsoft Edge: it has natural voices for all five languages.
echo   Close this window to stop.
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process msedge 'http://127.0.0.1:8070'"
backend\.venv\Scripts\python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8070 --no-access-log
pause
goto :eof

:need_ollama
echo.
echo Without a Claude API key, AI Talk needs Ollama.
echo Install or start Ollama and run this file again, or paste your Claude API key into backend\.env
pause
goto :eof

:error
echo Something went wrong. Please read the message above.
pause
goto :eof

rem ---- Ollama: check it, start it, download the model once. Exit code 1 = not usable. ----
:ollama
where ollama >nul 2>nul
if errorlevel 1 (
  echo Ollama is not installed - get it from https://ollama.com/download
  exit /b 1
)
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto :ollama_model
echo Starting Ollama ...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
  start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
) else (
  start "" /min ollama serve
)
powershell -NoProfile -Command "for ($i = 0; $i -lt 30; $i++) { try { Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep -Seconds 1 } }; exit 1"
if errorlevel 1 (
  echo Ollama did not start - start it from the Windows Start menu.
  exit /b 1
)
:ollama_model
ollama list | findstr /b /c:"%MODEL%" >nul
if not errorlevel 1 exit /b 0
if "%CLAUDE%"=="1" (
  echo The local model %MODEL% is not downloaded. Claude works without it.
  echo To use Ollama too, run: ollama pull %MODEL%
  exit /b 0
)
echo Downloading the AI model %MODEL% - about 3.3 GB, only once ...
ollama pull %MODEL%
if errorlevel 1 exit /b 1
exit /b 0
