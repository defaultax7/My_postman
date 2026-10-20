@echo off
setlocal EnableExtensions
rem Build a portable Windows package for Postman Replicate.
rem Output: dist\Postman-Replicate-<version>-win64\ and .zip
rem Optional arguments are passed to tools\package-win.js, e.g. --no-zip or --src "C:\path\to\electron".

set "APPDIR=%~dp0"
if not exist "%APPDIR%main.js" (
  echo [package] Missing app files in "%APPDIR%".
  goto fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo [package] Node.js was not found in PATH.
  echo [package] Install Node.js 18+ and try again.
  goto fail
)

set "RUNTIME=%APPDIR%runtime"
if not exist "%RUNTIME%\Postman.exe" (
  echo [package] Creating the Electron runtime...
  set "RMODE=link"
  if exist "%APPDIR%.runtime-mode" set /p RMODE=<"%APPDIR%.runtime-mode"
  if /i "%RMODE%"=="copy" (
    node "%APPDIR%tools\make-runtime.js" --copy
  ) else (
    node "%APPDIR%tools\make-runtime.js"
  )
  if not exist "%RUNTIME%\Postman.exe" goto fail
)

echo.
echo [package] Building the Windows package...
node "%APPDIR%tools\package-win.js" %*
if errorlevel 1 goto fail

echo.
echo [package] Done. Output:
echo   %APPDIR%dist
if exist "%APPDIR%dist" start "" "%APPDIR%dist"
echo.
pause
exit /b 0

:fail
echo.
echo [package] Packaging failed.
pause
exit /b 1
