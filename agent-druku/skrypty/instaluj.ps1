# Instalacja i aktualizacja agenta druku. Uruchamiaj przez Zainstaluj.cmd (dwuklik w rozpakowanej paczce).
# Instrukcja: README.md, sekcja 1; docs/druk.md w repozytorium Kompletora.
#
# Kroki: kopia programu do C:\Kompletor\agent-druku (agent-druku.json i dane\ zostają nietknięte), Unblock-File,
# Node z paczki (runtime\node.exe, potem node z PATH), jedno zadanie Harmonogramu (ta sama nazwa = to samo zadanie
# przy aktualizacji), skróty „Kompletor Druk (ustawienia)”, start programu i otwarcie strony ustawień w przeglądarce
# (tam kod połączenia i wybór drukarek).
# -Konsola (Zainstaluj.cmd /konsola) albo -NowyKod (/nowy): droga awaryjna bez przeglądarki — kod i drukarki
# w tym oknie (node dist\main.js --instaluj), sprawdzenie konfiguracji i czekanie na pierwszy raport stanu drukarek.
param([switch]$NowyKod, [switch]$Konsola)
$ErrorActionPreference = 'Stop'
$DomyslnyCel = 'C:\Kompletor\agent-druku'
# KOMPLETOR_DRUK_CEL: inny folder programu (próba instalacji bez dotykania C:\Kompletor). Taki folder ma
# własne zadanie Harmonogramu („… (próba)”), żeby próba nie przejęła zadania prawdziwej instalacji.
$Cel = if ($env:KOMPLETOR_DRUK_CEL) { $env:KOMPLETOR_DRUK_CEL.TrimEnd('\') } else { $DomyslnyCel }
if ($Cel -notmatch '^[A-Za-z]:\\[^\\]+\\[^\\]+') { Write-Host "BŁĄD: folder programu „$Cel” musi być pełną ścieżką co najmniej dwa poziomy pod dyskiem." -ForegroundColor Red; exit 1 }
$NazwaZadania = if ($Cel -ieq $DomyslnyCel) { 'Kompletor - agent druku' } else { 'Kompletor - agent druku (próba)' }
$zrodlo = Split-Path -Parent $PSScriptRoot
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Krok($tekst) { Write-Host ''; Write-Host "==> $tekst" -ForegroundColor Cyan }
function Ok($tekst) { Write-Host "    OK: $tekst" -ForegroundColor Green }
function Uwaga($tekst) { Write-Host "    UWAGA: $tekst" -ForegroundColor Yellow }
function Stop-ZBledem($tekst) { Write-Host ''; Write-Host "BŁĄD: $tekst" -ForegroundColor Red; exit 1 }

function Zatrzymaj-Agenta {
  # Przed podmianą plików: zadanie Harmonogramu, start.ps1 i Node z tego folderu (runtime\node.exe jest wtedy zablokowany).
  if (Get-ScheduledTask -TaskName $NazwaZadania -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $NazwaZadania -ErrorAction SilentlyContinue
  }
  # Ścieżka folderu jako cały człon (po niej „\”, cudzysłów, spacja albo koniec), nie podciąg: C:\Kompletor\agent-druku2 nie pasuje.
  $wzor = '(?i)' + [Regex]::Escape($Cel) + '(\\|"|\s|$)'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'powershell.exe') -and $_.ProcessId -ne $PID -and "$($_.CommandLine) $($_.ExecutablePath)" -match $wzor } |
    Where-Object { "$($_.CommandLine)" -notmatch 'instaluj\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # Czekamy, aż Node naprawdę zniknie: kopia, która przeżyje, trzyma blokadę i nowy start czeka wtedy minutę (kod 3).
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $zywe = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { "$($_.CommandLine) $($_.ExecutablePath)" -match $wzor })
    if ($zywe.Count -eq 0) { break }
    $zywe | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

function Zawez-Uprawnienia {
  # Folder pod C:\ dziedziczy „Użytkownicy uwierzytelnieni: modyfikacja”: inne konto Windows na tym komputerze mogłoby
  # podmienić program, skrypt skrótu albo konfigurację. Zostają: bieżący użytkownik (to jego konto uruchamia program
  # z Harmonogramu), SYSTEM i Administratorzy. Błąd = ostrzeżenie, nie przerwanie instalacji.
  $ja = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $poprzednia = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & icacls.exe $Cel /inheritance:r /grant:r "*${ja}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' *> $null
    $kod = $LASTEXITCODE
  } catch { $kod = -1 } finally { $ErrorActionPreference = $poprzednia }
  if ($kod -eq 0) { Ok 'uprawnienia folderu: tylko to konto Windows, SYSTEM i Administratorzy' }
  else { Uwaga "nie udało się zawęzić uprawnień folderu (icacls, kod $kod). Program zadziała, ale inne konta Windows na tym komputerze mogą zmieniać jego pliki." }
}

$pelneZrodlo = (Resolve-Path $zrodlo).Path.TrimEnd('\')
$tenSamFolder = $pelneZrodlo -ieq $Cel

Krok "Kopiuję program do $Cel"
if (-not (Test-Path (Join-Path $pelneZrodlo 'dist\main.js'))) { Stop-ZBledem "Brak pliku dist\main.js w $pelneZrodlo. Rozpakuj całą paczkę Kompletor-Druk i uruchom Zainstaluj.cmd z rozpakowanego folderu." }
$aktualizacja = Test-Path (Join-Path $Cel 'dist\main.js')
if (-not $tenSamFolder) {
  Zatrzymaj-Agenta
  New-Item -ItemType Directory -Force -Path $Cel | Out-Null
  # Konfiguracja, rejestr wydruków (dane\) i logi zostają; reszta programu podmieniona w całości.
  foreach ($stary in 'dist', 'skrypty', 'runtime', 'sumatra') {
    $p = Join-Path $Cel $stary
    if (Test-Path $p) { Remove-Item -Recurse -Force $p }
  }
  Get-ChildItem -Force $pelneZrodlo | Where-Object { @('agent-druku.json', 'dane', 'logi') -notcontains $_.Name } |
    ForEach-Object { Copy-Item -Recurse -Force $_.FullName (Join-Path $Cel $_.Name) }
  Ok $(if ($aktualizacja) { 'zaktualizowano pliki programu (konfiguracja i rejestr wydruków bez zmian)' } else { 'skopiowano' })
} else {
  Zatrzymaj-Agenta
  Ok 'program jest już w tym folderze'
}
Zawez-Uprawnienia
# Pliki z ZIP-a pobranego z internetu mają znacznik „z internetu”; bez zdjęcia go Windows może pytać przy każdym starcie.
Get-ChildItem -Recurse -File $Cel | Unblock-File -ErrorAction SilentlyContinue
Ok 'odblokowano pliki z paczki'

Krok 'Sprawdzam Node.js'
$node = Join-Path $Cel 'runtime\node.exe'
if (-not (Test-Path $node)) {
  $zPath = Get-Command node -ErrorAction SilentlyContinue
  if (-not $zPath) { Stop-ZBledem 'W paczce brak runtime\node.exe, a Node.js nie jest zainstalowany. Pobierz pełną paczkę Kompletor-Druk (ZIP) od administratora.' }
  $node = $zPath.Source
  Uwaga 'paczka bez runtime\node.exe — używam Node.js zainstalowanego w systemie'
}
$wersja = (& $node --version).TrimStart('v')
if ([int]($wersja.Split('.')[0]) -lt 20) { Stop-ZBledem "Node.js $wersja jest za stary (potrzebny 20 lub nowszy). Użyj pełnej paczki Kompletor-Druk z runtime\node.exe." }
Ok "Node.js $wersja ($node)"

$plikKonfiguracji = Join-Path $Cel 'agent-druku.json'
$main = Join-Path $Cel 'dist\main.js'
$plikAdresu = Join-Path $Cel 'dane\adres-ustawien.txt'
$NazwaSkrotu = if ($Cel -ieq $DomyslnyCel) { 'Kompletor Druk (ustawienia)' } else { 'Kompletor Druk (ustawienia, próba)' }

function Zarejestruj-Zadanie {
  Krok "Zadanie Harmonogramu „$NazwaZadania” (start przy logowaniu użytkownika $env:USERNAME)"
  # Register-ScheduledTask -Force pod tą samą nazwą: aktualizacja nie zakłada drugiego zadania.
  $akcja = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Cel\skrypty\start.ps1`"" `
    -WorkingDirectory $Cel
  $wyzwalacz = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $ustawienia = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  $uzytkownik = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $NazwaZadania -Action $akcja -Trigger $wyzwalacz -Settings $ustawienia `
    -Principal $uzytkownik -Description 'Kompletor: pobiera zlecenia druku z serwera i drukuje (README.md w folderze programu).' -Force | Out-Null
  Ok 'zadanie gotowe'
}

function Utworz-Skroty {
  # Skrót otwiera stronę ustawień przez skrypty\ustawienia.ps1: ten czyta aktualny adres (port i klucz) z dane\
  # i w razie potrzeby uruchamia program. Pulpit i menu Start bieżącego użytkownika, bez uprawnień administratora.
  Krok "Skróty „$NazwaSkrotu” na pulpicie i w menu Start"
  try {
    $powloka = New-Object -ComObject WScript.Shell
    foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
      if (-not $folder) { continue }
      $s = $powloka.CreateShortcut((Join-Path $folder "$NazwaSkrotu.lnk"))
      $s.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Cel\skrypty\ustawienia.ps1`""
      $s.WorkingDirectory = $Cel
      $s.IconLocation = "$env:SystemRoot\System32\shell32.dll,16"
      $s.Description = 'Kompletor Druk: stan programu, drukarki i podłączenie do Kompletora'
      $s.WindowStyle = 7
      $s.Save()
    }
    Ok 'skróty gotowe'
  } catch {
    Uwaga "nie udało się utworzyć skrótów ($($_.Exception.Message)). Stronę otworzysz plikiem $Cel\skrypty\ustawienia.ps1."
  }
}

function Czekaj-Na-Adres($od) {
  # Program zapisuje adres strony ustawień zaraz po starcie (zwykle 1–2 s). Do 2 minut na wolny pierwszy start
  # (antywirus sprawdza nowy node.exe) i na start po aktualizacji.
  Write-Host '    Uruchamiam program, to może potrwać do 2 minut…'
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-Path $plikAdresu) -and (Get-Item $plikAdresu).LastWriteTime -ge $od.AddSeconds(-1)) {
      $adres = (Get-Content -Raw -Encoding UTF8 $plikAdresu).Trim()
      if ($adres -match '^http://127\.0\.0\.1:\d{1,5}/u/[A-Za-z0-9_-]{43}/$') { return $adres }
    }
  }
  return $null
}

function Instalacja-Konsola {
  Krok 'Konfiguracja stanowiska (w tym oknie)'
  $pytaj = $NowyKod -or -not (Test-Path $plikKonfiguracji)
  if (-not $pytaj) {
    Ok 'jest agent-druku.json — zostaje bez zmian (aktualizacja)'
    $odp = Read-Host '    Enter = zostaw konfigurację; K = nowy kod instalacyjny i ponowne przypisanie drukarek'
    if ($odp.Trim().ToUpper() -eq 'K') { $pytaj = $true }
  }
  if ($pytaj) {
    $poprzednie = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $node $main --instaluj --konfig $plikKonfiguracji
    $kod = $LASTEXITCODE
    $ErrorActionPreference = $poprzednie
    if ($kod -ne 0) { Stop-ZBledem 'Konfiguracja nie została zapisana. Uruchom Zainstaluj.cmd jeszcze raz.' }
  }

  Krok 'Sprawdzam konfigurację programem agenta'
  # Ta sama walidacja co przy starcie; bez tego błędna konfiguracja kończyłaby się „Gotowe” i cichym brakiem stanu drukarek.
  $poprzednie = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $wynikSprawdzenia = @(& $node $main --sprawdz-konfig --konfig $plikKonfiguracji 2>&1 | ForEach-Object { "$_" })
  $kodSprawdzenia = $LASTEXITCODE
  $ErrorActionPreference = $poprzednie
  if ($kodSprawdzenia -ne 0) {
    Write-Host ''
    $wynikSprawdzenia | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Stop-ZBledem 'Konfiguracja ma błędy (lista wyżej). Uruchom Zainstaluj.cmd /nowy, żeby wkleić kod i przypisać drukarki od nowa.'
  }
  $wynikSprawdzenia | Where-Object { $_ -like 'UWAGA: *' } | ForEach-Object { Uwaga $_.Substring(7) }
  $konfig = Get-Content -Raw -Encoding UTF8 $plikKonfiguracji | ConvertFrom-Json
  Ok "stanowisko „$($konfig.stanowisko)”"

  Krok 'Sprawdzam SumatraPDF (druk PDF)'
  $sumatra = if ($konfig.sumatraPdf) { $konfig.sumatraPdf } elseif (Test-Path (Join-Path $Cel 'sumatra\SumatraPDF.exe')) { Join-Path $Cel 'sumatra\SumatraPDF.exe' } else { 'C:\Program Files\SumatraPDF\SumatraPDF.exe' }
  if (Test-Path $sumatra) { Ok $sumatra } else { Uwaga "Nie ma SumatraPDF w $sumatra — wydruki PDF nie zadziałają. Użyj pełnej paczki Kompletor-Druk." }

  Krok 'Sprawdzam drukarki'
  $wWindows = @(Get-Printer | ForEach-Object { $_.Name })
  foreach ($wpis in $konfig.drukarki.PSObject.Properties) {
    if ($wWindows -contains $wpis.Value) { Ok "$($wpis.Name) = $($wpis.Value)" } else { Uwaga "$($wpis.Name) = „$($wpis.Value)” — takiej drukarki nie ma w Windows (Zainstaluj.cmd /nowy przypisze drukarki od nowa)" }
  }

  Zarejestruj-Zadanie
  Utworz-Skroty

  Krok 'Uruchamiam agenta i czekam na pierwszy raport stanu drukarek (do 2 minut)'
  # Program mógł już działać bez konfiguracji (strona się nie otworzyła) — zatrzymany, żeby wczytał nowy plik.
  Zatrzymaj-Agenta
  $znacznik = Join-Path $Cel 'dane\ostatni-raport-stanu.txt'
  $start = Get-Date
  Start-ScheduledTask -TaskName $NazwaZadania
  $zgloszony = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if ((Test-Path $znacznik) -and (Get-Item $znacznik).LastWriteTime -ge $start.AddSeconds(-1)) { $zgloszony = $true; break }
  }
  Write-Host ''
  if ($zgloszony) {
    Write-Host "Gotowe: agent druku działa i zgłosił drukarki serwerowi — w panelu (Ustawienia → Wysyłka i druk → Druk) zrób wydruk testowy na każdej drukarce." -ForegroundColor Green
    Write-Host "Ustawienia zmienisz później skrótem „$NazwaSkrotu” na pulpicie."
  } else {
    $log = Join-Path $Cel 'logi\agent-druku.log'
    if (Test-Path $log) { Write-Host '    Ostatnie wpisy z logu:'; Get-Content -Encoding UTF8 -Tail 8 $log | ForEach-Object { Write-Host "      $_" } }
    $logStartu = Join-Path $Cel 'logi\start.log'
    if (Test-Path $logStartu) { Write-Host '    Ostatnie wpisy z logi\start.log:'; Get-Content -Encoding UTF8 -Tail 5 $logStartu | ForEach-Object { Write-Host "      $_" } }
    Write-Host 'Agent nie zgłosił się serwerowi w 2 minuty — sprawdź internet i wpisy wyżej, potem uruchom Zainstaluj.cmd jeszcze raz.' -ForegroundColor Yellow
    exit 1
  }
}

if ($Konsola -or $NowyKod) {
  Instalacja-Konsola
  exit 0
}

# Zwykła droga: program startuje od razu (bez konfiguracji czeka na ustawienia), a resztę robi się na stronie
# „Kompletor Druk (ustawienia)” w przeglądarce. Gdy strona się nie otworzy — pytania w tym oknie.
Zarejestruj-Zadanie
Utworz-Skroty
Krok 'Uruchamiam program i otwieram stronę ustawień'
Zatrzymaj-Agenta
$start = Get-Date
Start-ScheduledTask -TaskName $NazwaZadania
$adres = Czekaj-Na-Adres $start
$otwarta = $false
if ($adres) {
  try { Start-Process $adres; $otwarta = $true } catch { Uwaga "przeglądarka się nie otworzyła ($($_.Exception.Message))" }
} else {
  Uwaga 'program nie podał adresu strony ustawień w 2 minuty'
}
if ($otwarta) {
  Write-Host ''
  Write-Host 'Gotowe: program działa, a w przeglądarce otworzyła się strona „Kompletor Druk (ustawienia)”.' -ForegroundColor Green
  Write-Host '  1. Wklej tam kod połączenia z Kompletora (Ustawienia → Wysyłka i druk → Druk) i kliknij „Sprawdź i podłącz”.'
  Write-Host '  2. Przy każdej drukarce wybierz, do czego służy, i kliknij „Zapisz”.'
  Write-Host "Później stronę otworzysz skrótem „$NazwaSkrotu” na pulpicie. To okno możesz zamknąć."
  exit 0
}
Write-Host ''
Write-Host 'Strona ustawień się nie otworzyła — dokończymy w tym oknie.' -ForegroundColor Yellow
Instalacja-Konsola
