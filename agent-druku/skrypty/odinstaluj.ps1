# Usuwa zadanie Harmonogramu, skróty „Kompletor Druk (ustawienia)” tego folderu i zatrzymuje agenta. Pliki,
# konfiguracja i logi zostają w folderze.
$ErrorActionPreference = 'Stop'
$katalog = Split-Path -Parent $PSScriptRoot
# Zadanie tego folderu (zwykłe albo „(próba)” z KOMPLETOR_DRUK_CEL) — to, którego akcja wskazuje ten folder.
# Gdy żadne nie wskazuje: nazwa zwykła tylko dla C:\Kompletor\agent-druku, inaczej „(próba)” — odinstalowanie
# kopii próbnej nigdy nie zdejmuje zadania prawdziwej instalacji.
$NazwaZadania = if ($katalog.TrimEnd('\') -ieq 'C:\Kompletor\agent-druku') { 'Kompletor - agent druku' } else { 'Kompletor - agent druku (próba)' }
foreach ($n in 'Kompletor - agent druku', 'Kompletor - agent druku (próba)') {
  $z = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if ($z -and (($z.Actions | ForEach-Object { "$($_.Arguments) $($_.WorkingDirectory)" }) -join ' ').ToLower().Contains($katalog.ToLower())) { $NazwaZadania = $n; break }
}

if (Get-ScheduledTask -TaskName $NazwaZadania -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $NazwaZadania -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $NazwaZadania -Confirm:$false
  Write-Host "Usunięto zadanie „$NazwaZadania”." -ForegroundColor Green
} else {
  Write-Host "Zadania „$NazwaZadania” nie było."
}
$blokada = Join-Path $katalog 'dane\agent.lock'
if (Test-Path $blokada) {
  # Blokada: JSON {"pid":…,"start":…} albo sam numer (starsza wersja). Uszkodzony plik nie może przerwać
  # odinstalowania — wtedy tylko go kasujemy.
  try {
    $tresc = (Get-Content -Raw $blokada).Trim()
    $agentPid = if ($tresc.StartsWith('{')) { [int](($tresc | ConvertFrom-Json).pid) } else { [int]$tresc }
    $proces = Get-Process -Id $agentPid -ErrorAction SilentlyContinue
    if ($proces -and $proces.ProcessName -eq 'node') { Stop-Process -Id $proces.Id; Write-Host 'Zatrzymano działającego agenta.' }
  } catch {
    Write-Host "Plik blokady był nieczytelny ($($_.Exception.Message)) — usuwam go."
  }
  Remove-Item $blokada -Force -ErrorAction SilentlyContinue
}
# Skróty z instalatora — tylko te, które otwierają stronę ustawień z tego folderu.
try {
  $powloka = New-Object -ComObject WScript.Shell
  foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
    if (-not $folder) { continue }
    # Druga para: nazwy z wcześniejszych wersji paczki (z długim myślnikiem).
    foreach ($nazwa in 'Kompletor Druk (ustawienia)', 'Kompletor Druk (ustawienia, próba)',
        "Kompletor Druk $([char]0x2014) ustawienia", "Kompletor Druk $([char]0x2014) ustawienia (próba)") {
      $plik = Join-Path $folder "$nazwa.lnk"
      if (-not (Test-Path $plik)) { continue }
      if ($powloka.CreateShortcut($plik).Arguments.ToLower().Contains($katalog.ToLower())) {
        Remove-Item $plik -Force
        Write-Host "Usunięto skrót „$nazwa”."
      }
    }
  }
} catch {
  Write-Host "Nie udało się usunąć skrótów: $($_.Exception.Message)"
}
