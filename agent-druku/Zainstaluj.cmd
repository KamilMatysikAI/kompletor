@echo off
rem Kompletor Druk: instalacja i aktualizacja agenta druku - dwuklik w rozpakowanej paczce.
rem Zwykle: kopia programu, start i strona ustawien w przegladarce (kod polaczenia, drukarki).
rem "Zainstaluj.cmd /konsola" = wszystko w tym oknie, bez przegladarki (droga awaryjna).
rem "Zainstaluj.cmd /nowy" = w tym oknie nowy kod i przypisanie drukarek mimo istniejacej konfiguracji.
rem Bez polskich znakow w tym pliku: cmd.exe czyta go w stronie kodowej OEM jeszcze przed chcp.
chcp 65001 >nul
set "KOMPLETOR_ARG="
if /i "%~1"=="/nowy" set "KOMPLETOR_ARG=-NowyKod"
if /i "%~1"=="/konsola" set "KOMPLETOR_ARG=-Konsola"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0skrypty\instaluj.ps1" %KOMPLETOR_ARG%
pause
