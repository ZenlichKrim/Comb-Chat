@echo off
REM ============================================================
REM  Winter Atmosphere — build the mod jar on Windows
REM  Needs Java 21. Everything else (Gradle, Loom, Fabric API)
REM  is downloaded by the script on the first run.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo [1/5] Checking Java 21...
where java >nul 2>nul
if errorlevel 1 (
  echo     Java not found. Install JDK 21 from https://adoptium.net and run this again.
  pause & exit /b 1
)
for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /i "version"') do set "JVER=%%v"
echo     Found java !JVER!

echo [2/5] Checking Gradle...
set "GRADLE=gradle"
where gradle >nul 2>nul
if errorlevel 1 (
  if not exist ".gradle-dist\gradle-8.10\bin\gradle.bat" (
    echo     Gradle not installed - downloading 8.10 ...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri https://services.gradle.org/distributions/gradle-8.10-bin.zip -OutFile gradle.zip"
    powershell -NoProfile -Command "Expand-Archive -Force gradle.zip .gradle-dist-tmp"
    mkdir .gradle-dist 2>nul
    move .gradle-dist-tmp\gradle-8.10 .gradle-dist\gradle-8.10 >nul
    del gradle.zip
  )
  set "GRADLE=.gradle-dist\gradle-8.10\bin\gradle.bat"
)

echo [3/5] Building the mod (first run downloads Minecraft, 5-15 minutes)...
call %GRADLE% build --no-daemon
if errorlevel 1 (
  echo.
  echo BUILD FAILED. The error above names the file and line.
  echo Ask Comb Chat to "fix the build" and paste that text.
  pause & exit /b 1
)

echo [4/5] Collecting the jar...
if not exist "out" mkdir out
copy /y "build\libs\winter-atmosphere-1.0.0.jar" "out\" >nul
echo.
echo [5/5] DONE. Your mod is here:
echo     %cd%\out\winter-atmosphere-1.0.0.jar
echo Copy it into .minecraft\mods  (needs Fabric Loader + Fabric API).
start "" "%cd%\out"
pause
