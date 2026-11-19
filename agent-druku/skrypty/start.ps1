# Uruchamiany przez Harmonogram zadań przy logowaniu (ukryte okno). Pilnuje agenta według kodu wyjścia
# (opis kodów: src/main.ts):
#   0 — zatrzymany celowo: koniec,
#   2 — błędna konfiguracja bez strony ustawień: koniec z wpisem w logi\start.log (restart nic nie naprawi),
#   3 — działa już inna kopia agenta: ponowna próba co 60 s (np. po zamknięciu okna uruchom.cmd),
#   4 — ponowne uruchomienie ze strony ustawień: start od razu,
#   inny — awaria: ponowny start po 30 s.
$ErrorActionPreference = 'Continue'
# Node pisze w UTF-8; bez tego PowerShell czyta jego wyjście stroną kodową OEM (852) i psuje polskie znaki.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$katalog = Split-Path -Parent $PSScriptRoot
$logi = Join-Path $katalog 'logi'
New-Item -ItemType Directory -Force -Path $logi | Out-Null
$logStartu = Join-Path $logi 'start.log'
$main = Join-Path $katalog 'dist\main.js'

function Wpis($tekst) {
  Add-Content -Path $logStartu -Encoding UTF8 -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $tekst)
}

# Najpierw Node z paczki (runtime\node.exe), potem node z PATH (zgodność ze starymi folderami bez paczki).
$node = Join-Path $katalog 'runtime\node.exe'
if (-not (Test-Path $node)) {
  if (Get-Command node -ErrorAction SilentlyContinue) { $node = 'node' }
  else {
    # Jeden wpis zamiast pętli co 30 s.
    Wpis 'nie znaleziono programu Node.js: brak runtime\node.exe w folderze programu i brak node w PATH. Uruchom Zainstaluj.cmd z paczki Kompletor-Druk.'
    exit 1
  }
}

$czekaNaKopie = $false
while ($true) {
  # Oba strumienie przez jedno Add-Content -Encoding UTF8 (każda linia osobno, bez trzymania pliku otwartego):
  # samo „2>>” w PowerShell 5.1 pisze w UTF-16 i miesza kodowania w jednym pliku. Agent bez konsoli nic nie
  # pisze na stdout, poza listą błędów konfiguracji — ta też ma trafić do start.log.
  & $node $main 2>&1 | ForEach-Object { Add-Content -Path $logStartu -Encoding UTF8 -Value "$_" }
  $kod = $LASTEXITCODE
  if ($kod -eq 0) { break }
  if ($kod -eq 2) {
    Wpis 'agent zakończył się kodem 2: błędna konfiguracja (lista błędów wyżej). Uruchom Zainstaluj.cmd /nowy albo popraw agent-druku.json.'
    break
  }
  if ($kod -eq 3) {
    # Wpis tylko na początku serii, żeby log nie dostawał linii co minutę.
    if (-not $czekaNaKopie) {
      Wpis 'działa już inna kopia agenta (kod 3), sprawdzam ponownie (najpierw co 5 s, potem co 60 s). Jeśli ekran pakowania nie pokazuje stanu drukarek, usuń dane\agent.lock i uruchom Zainstaluj.cmd.'
      $czekaNaKopie = $true
      $prob = 0
    }
    # Pierwsze próby co 5 s (stara kopia zwykle kończy się zaraz po aktualizacji), potem co 60 s.
    $prob++
    if ($prob -le 6) { Start-Sleep -Seconds 5 } else { Start-Sleep -Seconds 60 }
    continue
  }
  $czekaNaKopie = $false
  if ($kod -eq 4) { Wpis 'ponowne uruchomienie ze strony ustawień'; continue }
  Wpis ("agent zakończył się kodem {0}, ponowny start za 30 s" -f $kod)
  Start-Sleep -Seconds 30
}
