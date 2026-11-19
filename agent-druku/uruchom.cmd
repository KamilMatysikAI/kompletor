@echo off
rem Reczne uruchomienie w oknie (do sprawdzenia, co sie dzieje). Zamkniecie okna zatrzymuje agenta.
rem Najpierw Node z paczki (runtime\node.exe), potem node z PATH (stare foldery bez paczki).
chcp 65001 >nul
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0dist\main.js"
) else (
  node "%~dp0dist\main.js"
)
pause
