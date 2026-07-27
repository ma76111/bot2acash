@echo off
echo.
echo ========================================
echo    DATABASE RESET UTILITY
echo ========================================
echo.
echo This will reset the bot database and remove all data.
echo A backup will be created before reset.
echo.
pause
echo.
echo Starting reset process...
node reset-database.js --interactive
echo.
pause