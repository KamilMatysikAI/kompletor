# Wypisuje stan wszystkich drukarek jako JSON: [{Name, PrinterStatus, JobCount, WorkOffline}].
# PrinterStatus i JobCount z Get-Printer; WorkOffline („Użyj drukarki w trybie offline”, odłączone USB) z Win32_Printer.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
  $offline = @{}
  try {
    Get-CimInstance -ClassName Win32_Printer | ForEach-Object { $offline[$_.Name] = [bool]$_.WorkOffline }
  } catch {
    # Brak WMI nie blokuje odczytu — zostaje sam PrinterStatus.
  }
  $lista = @(Get-Printer | ForEach-Object {
    [pscustomobject]@{
      Name          = $_.Name
      PrinterStatus = [string]$_.PrinterStatus
      JobCount      = [int]$_.JobCount
      WorkOffline   = [bool]$offline[$_.Name]
    }
  })
  ConvertTo-Json -InputObject $lista -Depth 2 -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
