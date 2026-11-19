# Wysyła plik bajt w bajt do kolejki wydruku Windows z typem danych RAW (ZPL dla drukarek Zebra i zgodnych).
# Parametry przez zmienne środowiskowe (ustawia je agent): KOMPLETOR_DRUKARKA, KOMPLETOR_PLIK, KOMPLETOR_KOPIE.
# Kopie idą w JEDNYM zadaniu wydruku (dane powtórzone N razy), żeby nie przeplatały się z innymi etykietami.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
  $drukarka = $env:KOMPLETOR_DRUKARKA
  $plik = $env:KOMPLETOR_PLIK
  $kopie = [int]$env:KOMPLETOR_KOPIE
  if (-not $drukarka -or -not $plik) { throw 'Brak KOMPLETOR_DRUKARKA albo KOMPLETOR_PLIK' }
  if ($kopie -lt 1) { $kopie = 1 }

  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class KompletorRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

  static Exception Blad(string krok) {
    return new Win32Exception(Marshal.GetLastWin32Error(), krok + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
  }

  public static void Wyslij(string drukarka, byte[] dane, int kopie, string nazwa) {
    IntPtr h;
    if (!OpenPrinter(drukarka, out h, IntPtr.Zero)) throw Blad("OpenPrinter");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = nazwa;
      di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw Blad("StartDocPrinter");
      try {
        if (!StartPagePrinter(h)) throw Blad("StartPagePrinter");
        for (int i = 0; i < kopie; i++) {
          int zapisane;
          if (!WritePrinter(h, dane, dane.Length, out zapisane)) throw Blad("WritePrinter");
          if (zapisane != dane.Length) throw new Exception("WritePrinter: zapisano " + zapisane + " z " + dane.Length + " bajtów");
        }
        EndPagePrinter(h);
      } finally {
        EndDocPrinter(h);
      }
    } finally {
      ClosePrinter(h);
    }
  }
}
'@

  $dane = [System.IO.File]::ReadAllBytes($plik)
  $nazwa = 'Kompletor ' + [System.IO.Path]::GetFileNameWithoutExtension($plik)
  [KompletorRaw]::Wyslij($drukarka, $dane, $kopie, $nazwa)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
