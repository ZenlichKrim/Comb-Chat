@echo off
REM ============================================================
REM  Winter Atmosphere — build the mod jar on Windows
REM  Needs Java 21. Gradle, Minecraft and Fabric API are
REM  downloaded by this script on the first run.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo [1/6] Checking Java 21...
where java >nul 2>nul
if errorlevel 1 (
  echo     Java not found.
  echo     Install JDK 21 from https://adoptium.net and run this again.
  pause & exit /b 1
)
java -version 2>&1 | findstr /i "version" > "%TEMP%\wv.txt"
set /p JVER=<"%TEMP%\wv.txt"
echo     !JVER!
echo     (Java 17 or older will fail at the compile step — install 21.)

echo [2/6] Checking Gradle...
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

echo [3/6] Building the mod (first run downloads Minecraft, 5-15 minutes)...
call %GRADLE% build --no-daemon
if errorlevel 1 (
  echo.
  echo ------------------------------------------------------------
  echo BUILD FAILED.
  echo Copy the lines above starting with "error:" and paste them
  echo into Comb Chat with: "fix the build".
  echo ------------------------------------------------------------
  pause & exit /b 1
)

echo [4/6] Collecting the jar...
if not exist "out" mkdir out
for %%f in ("build\libs\*.jar") do (
  echo %%~nxf | findstr /i "sources" >nul || copy /y "%%f" "out\" >nul
)

echo [5/6] Checking the jar contains what it should...
powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead((Get-ChildItem out\*.jar | Select-Object -First 1).FullName); $z.Entries | Where-Object {$_.FullName -match 'fabric.mod.json|winter/lang/ru_ru.json'} | ForEach-Object { '    OK ' + $_.FullName }; $z.Dispose()"

echo [6/6] DONE. Your mod is here:
echo     %cd%\out
echo Copy the jar into .minecraft\mods  (needs Fabric Loader + Fabric API 0.141.6+).
start "" "%cd%\out"
pause
