@echo off
powershell.exe -NoProfile -File "%~dp0start-generation.ps1"
if errorlevel 1 pause
