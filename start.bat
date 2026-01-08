@echo off
title root@parameters
color 0f
echo Starting parameters...

:: Задержка перед запуском для читаемости
timeout /t 1 >nul

:: Запуск бота
echo Starting bot...
npm run dev
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to start the bot. Check your package.json or index.js.
    pause
    exit /b 1
)

:: Задержка перед закрытием окна
echo Bot process finished. Press any key to exit...
pause