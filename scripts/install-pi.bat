@echo off
REM Install the debug APK from a Windows host, finding adb wherever it happens
REM to live. Run it from a Windows terminal in this directory or anywhere else:
REM it resolves its own location.
REM
REM   scripts\install-pi.bat
REM
REM The APK is this repo's own build output. An APK passed as %1 wins, for a
REM build copied off a phone or out of a devcontainer.
setlocal
set "HERE=%~dp0"
set "APK=%~1"
if not defined APK set "APK=%HERE%..\android\app\build\outputs\apk\debug\app-debug.apk"

echo.
echo === the APK
if not exist "%APK%" (
    echo   NOT FOUND: %APK%
    echo   Build it first:  cd android ^&^& gradlew assembleDebug
    goto :done
)
for %%F in ("%APK%") do echo   %%~zF bytes   %%~tF

echo.
echo === finding adb
set "ADB="
for %%A in (adb.exe) do if not defined ADB if not "%%~$PATH:A"=="" set "ADB=%%~$PATH:A"
if not defined ADB if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"   set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not defined ADB if exist "%USERPROFILE%\AppData\Local\Android\Sdk\platform-tools\adb.exe" set "ADB=%USERPROFILE%\AppData\Local\Android\Sdk\platform-tools\adb.exe"
if not defined ADB if exist "C:\platform-tools\adb.exe"                           set "ADB=C:\platform-tools\adb.exe"
if not defined ADB if exist "%ProgramFiles%\Android\android-sdk\platform-tools\adb.exe" set "ADB=%ProgramFiles%\Android\android-sdk\platform-tools\adb.exe"

if not defined ADB (
    echo   adb not found.
    echo.
    echo   Either install Android Studio (it ships one), or grab the standalone
    echo   platform-tools and unzip it to C:\platform-tools:
    echo.
    echo     https://dl.google.com/android/repository/platform-tools-latest-windows.zip
    echo.
    echo   Then run this script again.
    goto :done
)
echo   %ADB%
"%ADB%" version | findstr /C:"Android Debug Bridge"

echo.
echo === attached devices
"%ADB%" devices -l

echo.
echo === installing
"%ADB%" install -r "%APK%"
if errorlevel 1 (
    echo.
    echo   install failed.
    echo   - If the phone is not attached: enable USB debugging, or turn on
    echo     Wireless debugging and run:  adb connect ^<phone-ip^>^:^<port^>
    echo   - If it says INSTALL_FAILED_UPDATE_INCOMPATIBLE, an older build with a
    echo     different package id is installed: adb uninstall app.pidabl
    echo   - That error can also mean the signing key differs from the
    echo     installed one.
    goto :done
)

echo.
echo === installed
echo   The first launch extracts ~170 MB into app-private storage and takes a
echo   few minutes. Then the app opens its own web UI on 127.0.0.1.
echo.
echo   To watch it:
echo     adb shell run-as app.pidabl cat files/log/node.log
echo     adb shell run-as app.pidabl cat files/home/.pi-mobile/port

:done
echo.
pause
