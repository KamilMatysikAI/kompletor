// Polecenia Windows sprawdzane na atrapie uruchamiania procesów — bez SumatraPDF, PowerShella i drukarek.
import { describe, expect, it } from 'vitest'
import type { Uruchom } from '../src/drukarki.js'
import { BladDruku, DrukarkiWindows, parsujStanDrukarek, uruchomProces } from '../src/drukarki.js'

function zAtrapa(stdout = '') {
  const wywolania: { program: string; argumenty: string[]; opcje: { timeoutMs: number; env?: Record<string, string> } }[] = []
  const uruchom: Uruchom = async (program, argumenty, opcje) => {
    wywolania.push({ program, argumenty, opcje })
    return { stdout, stderr: '' }
  }
  const d = new DrukarkiWindows({
    sumatraPdf: 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
    powershell: 'powershell.exe',
    katalogSkryptow: 'C:\\Kompletor\\agent-druku\\skrypty',
    limitCzasuMs: 60_000,
    uruchom,
  })
  return { d, wywolania }
}

describe('polecenia druku Windows', () => {
  it('PDF: SumatraPDF -print-to w trybie cichym z kopiami i skalowaniem', async () => {
    const { d, wywolania } = zAtrapa()
    await d.drukujPdf('Brother HL-L2350DW series', 'C:\\dane\\Z-1.pdf', 2, 'fit')
    expect(wywolania[0]).toEqual({
      program: 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
      argumenty: ['-print-to', 'Brother HL-L2350DW series', '-print-settings', '2x,fit', '-silent', 'C:\\dane\\Z-1.pdf'],
      opcje: { timeoutMs: 60_000 },
    })
  })

  it('ZPL: skrypt druk-raw.ps1, parametry w zmiennych środowiskowych (nazwa ze spacją i polskimi znakami)', async () => {
    const { d, wywolania } = zAtrapa()
    await d.drukujRaw('Termiczna 1 (Zebra) — magazyn', 'C:\\dane\\Z-2.zpl', 3)
    expect(wywolania[0]!.program).toBe('powershell.exe')
    expect(wywolania[0]!.argumenty.at(-1)).toMatch(/druk-raw\.ps1$/)
    expect(wywolania[0]!.argumenty).toContain('-NonInteractive')
    expect(wywolania[0]!.opcje.env).toEqual({
      KOMPLETOR_DRUKARKA: 'Termiczna 1 (Zebra) — magazyn',
      KOMPLETOR_PLIK: 'C:\\dane\\Z-2.zpl',
      KOMPLETOR_KOPIE: '3',
    })
  })

  it('stan: wynik stan-drukarek.ps1 (tablica, BOM, pojedynczy obiekt, liczbowy status)', async () => {
    const { d } = zAtrapa(
      '\uFEFF[{"Name":"Brother A4","PrinterStatus":"Normal","JobCount":2,"WorkOffline":false},{"Name":"Termiczna 1","PrinterStatus":"8","JobCount":0,"WorkOffline":true}]\r\n',
    )
    expect(await d.stan()).toEqual([
      { nazwa: 'Brother A4', status: 'Normal', offline: false, zleceniaWKolejce: 2 },
      { nazwa: 'Termiczna 1', status: '8', offline: true, zleceniaWKolejce: 0 },
    ])
    expect(parsujStanDrukarek('{"Name":"X","PrinterStatus":5,"JobCount":"1"}')).toEqual([
      { nazwa: 'X', status: '5', offline: false, zleceniaWKolejce: 1 },
    ])
    expect(parsujStanDrukarek('')).toEqual([])
    expect(() => parsujStanDrukarek('Get-Printer : Usługa bufora wydruku nie jest uruchomiona')).toThrow(BladDruku)
  })

  it('uruchomProces: brak programu i kod wyjścia ≠ 0 → BladDruku z opisem', async () => {
    await expect(uruchomProces('nie-ma-takiego-programu-xyz', [], { timeoutMs: 5000 })).rejects.toThrow(/nie znaleziono programu/)
    await expect(
      uruchomProces(process.execPath, ['-e', 'console.error("Printing failed"); process.exit(3)'], { timeoutMs: 10_000 }),
    ).rejects.toThrow(/kod wyjścia 3: Printing failed/)
    const ok = await uruchomProces(process.execPath, ['-e', 'console.log(process.env.KOMPLETOR_X)'], {
      timeoutMs: 10_000,
      env: { KOMPLETOR_X: 'zażółć' },
    })
    expect(ok.stdout.trim()).toBe('zażółć')
  })

  it('uruchomProces: przekroczony czas → BladDruku „niepewny” (nie wiadomo, czy zadanie trafiło do kolejki)', async () => {
    const e = (await uruchomProces(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 300 }).catch(
      (x: unknown) => x,
    )) as BladDruku
    expect(e).toBeInstanceOf(BladDruku)
    expect(e.message).toMatch(/przekroczony czas/)
    expect(e.niepewny).toBe(true)
    const pewny = (await uruchomProces(process.execPath, ['-e', 'process.exit(1)'], { timeoutMs: 10_000 }).catch((x: unknown) => x)) as BladDruku
    expect(pewny.niepewny).toBe(false)
  })
})
