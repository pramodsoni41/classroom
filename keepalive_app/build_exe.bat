@echo off
rem Builds dist\NetKeepAlive.exe (single file, no console window).
cd /d "%~dp0"
python -m pip install -r requirements.txt pyinstaller || goto :fail
python -m PyInstaller --noconfirm --onefile --windowed --name NetKeepAlive --collect-all selenium keepalive_gui.py || goto :fail
echo.
echo Built: %~dp0dist\NetKeepAlive.exe
pause
exit /b 0

:fail
echo Build failed.
pause
exit /b 1
