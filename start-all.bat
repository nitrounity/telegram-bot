@echo off
cd /d C:\Users\NitroUnity\telegram-bot

echo Starting BOT...
start cmd /k node bot.js

timeout /t 2

echo Starting SERVER...
start cmd /k node server.js

timeout /t 2

echo Starting NGROK...
start cmd /k ngrok http 3000

echo All services started!
pause