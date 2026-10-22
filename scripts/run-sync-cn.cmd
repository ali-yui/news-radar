@echo off
rem News Radar domestic data sync - launched by Windows Task Scheduler (hourly)
rem ASCII only: keeps schtasks /tr parsing simple (no dashes in the command line)
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "e:\news\news-radar\scripts\sync-cn.ps1" -PerCategory 50
exit /b 0
