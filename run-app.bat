@echo off
set /p FINIMPULSE_TOKEN=Paste FinImpulse token: 
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1" -FinImpulseToken "%FINIMPULSE_TOKEN%"
pause
