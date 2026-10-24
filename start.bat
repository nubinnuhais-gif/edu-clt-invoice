@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies (first run only, downloads a headless browser for PDF emails)...
  call npm install
)
start "" http://localhost:8080
node server.js
