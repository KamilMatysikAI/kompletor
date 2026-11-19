# Otwiera stronę „Kompletor Druk (ustawienia)” w domyślnej przeglądarce. Wołany przez skrót na pulpicie i w menu Start
# (ukryte okno). Adres strony (port i losowy klucz) program zapisuje przy każdym starcie w dane\adres-ustawien.txt.
# Gdy program nie odpowiada, skrypt uruchamia jego zadanie Harmonogramu i czeka do 30 s.
$ErrorActionPreference = 'Stop'
$katalog = Split-Path -Parent $PSScriptRoot
$plikAdresu = Join-Path $katalog 'dane\adres-ustawien.txt'
$wzorAdresu = '^http://127\.0\.0\.1:\d{1,5}/u/[A-Za-z0-9_-]{43}/$'

function Adres {
  if (-not (Test-Path $plikAdresu)) { return $null }
  $a = (Get-Content -Raw -Encoding UTF8 $plikAdresu).Trim()
  # Tylko adres strony na tym komputerze: plik z innym wpisem nie otworzy niczego innego.
  if ($a -match $wzorAdresu) { return $a } else { return $null }
}

function Odpowiada($a) {
  if (-not $a) { return $false }
  try {
    $odp = Invoke-WebRequest -Uri $a -UseBasicParsing -TimeoutSec 3
    return $odp.StatusCode -eq 200
  } catch { return $false }
}

function Komunikat($tekst) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($tekst, 'Kompletor Druk', 'OK', 'Warning') | Out-Null
}

$adres = Adres
if (-not (Odpowiada $adres)) {
  # Zadanie tego folderu: zwykłe albo „(próba)” — to, którego akcja wskazuje ten folder.
  $zadanie = $null
  foreach ($n in 'Kompletor - agent druku', 'Kompletor - agent druku (próba)') {
    $z = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if ($z -and (($z.Actions | ForEach-Object { "$($_.Arguments) $($_.WorkingDirectory)" }) -join ' ').ToLower().Contains($katalog.ToLower())) { $zadanie = $n; break }
  }
  if (-not $zadanie) {
    Komunikat "Program Kompletor Druk nie jest zainstalowany w tym folderze ($katalog). Uruchom Zainstaluj.cmd z paczki Kompletor Druk."
    exit 1
  }
  Start-ScheduledTask -TaskName $zadanie
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $adres = Adres
    if (Odpowiada $adres) { break }
    $adres = $null
  }
  if (-not $adres) {
    Komunikat "Program Kompletor Druk nie odpowiada. Wyloguj się z Windows i zaloguj ponownie. Jeśli to nie pomoże, uruchom Zainstaluj.cmd z paczki.`n`nSzczegóły: $katalog\logi\start.log"
    exit 1
  }
}
Start-Process $adres
