@echo off
echo =========================================
echo    Starting TradeOsphere Server...
echo =========================================
echo.
echo Please leave this window open while using the app.
echo.

:: Start the browser and navigate to the local server
start http://localhost:3000

:: Start the Node.js server
node server.js
