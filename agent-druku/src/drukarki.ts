// Druk na Windows. PDF: SumatraPDF w trybie cichym. ZPL: surowe bajty do kolejki wydruku (typ danych RAW)
// przez skrypt PowerShell z wywołaniami winspool.drv. Stan: Get-Printer. Uzasadnienie wyboru w README.md.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { StanWindows } from './mapowanie.js'

/** PDF na termicznej bez skalowania (etykieta 100×150 ma wyjść 1:1), na A4 dopasowany do strony. */
export type Skalowanie = 'fit' | 'noscale'

export interface Drukarki {
  drukujPdf(drukarka: string, plik: string, kopie: number, skalowanie: Skalowanie): Promise<void>
  drukujRaw(drukarka: string, plik: string, kopie: number): Promise<void>
  /** Wszystkie drukarki widoczne w Windows (filtrowanie po nazwach robi wywołujący). */
  stan(): Promise<StanWindows[]>
}

export interface WynikProcesu {
  stdout: string
  stderr: string
}

/** Uruchomienie programu bez powłoki (argumenty nie są interpretowane przez cmd.exe). */
export type Uruchom = (
  program: string,
  argumenty: string[],
  opcje: { timeoutMs: number; env?: Record<string, string> },
) => Promise<WynikProcesu>

export class BladDruku extends Error {
  constructor(
    message: string,
    /**
     * true = nie wiadomo, czy zadanie trafiło do kolejki Windows (proces przerwany po przekroczeniu czasu —
     * SumatraPDF mógł już wysłać dane do sterownika). false = wiadomo, że nic nie wyszło (odmowa, brak programu).
     */
    readonly niepewny = false,
  ) {
    super(message)
    this.name = 'BladDruku'
  }
}

export const uruchomProces: Uruchom = (program, argumenty, opcje) =>
  new Promise((resolve, reject) => {
    execFile(
      program,
      argumenty,
      {
        timeout: opcje.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: opcje.env ? { ...process.env, ...opcje.env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
          const powod = e.killed
            ? `przekroczony czas ${Math.round(opcje.timeoutMs / 1000)} s`
            : e.code === 'ENOENT'
              ? `nie znaleziono programu ${program}`
              : `kod wyjścia ${String(e.code)}`
          const szczegoly = (stderr || stdout || '').trim().split(/\r?\n/).slice(-3).join(' ')
          reject(new BladDruku(szczegoly ? `${powod}: ${szczegoly}` : powod, e.killed === true))
        } else resolve({ stdout, stderr })
      },
    )
  })

export interface OpcjeDrukarekWindows {
  sumatraPdf: string
  powershell: string
  katalogSkryptow: string
  limitCzasuMs: number
  uruchom?: Uruchom
}

const ARGUMENTY_PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

export class DrukarkiWindows implements Drukarki {
  private readonly uruchom: Uruchom

  constructor(private readonly opcje: OpcjeDrukarekWindows) {
    this.uruchom = opcje.uruchom ?? uruchomProces
  }

  async drukujPdf(drukarka: string, plik: string, kopie: number, skalowanie: Skalowanie): Promise<void> {
    // -print-settings: "<n>x" = liczba kopii (SumatraPDF ≥ 3.0), skalowanie fit/noscale.
    await this.uruchom(
      this.opcje.sumatraPdf,
      ['-print-to', drukarka, '-print-settings', `${kopie}x,${skalowanie}`, '-silent', plik],
      { timeoutMs: this.opcje.limitCzasuMs },
    )
  }

  async drukujRaw(drukarka: string, plik: string, kopie: number): Promise<void> {
    // Parametry przez zmienne środowiskowe, nie przez linię poleceń: nazwy drukarek ze spacjami, nawiasami
    // i polskimi znakami przechodzą bez kłopotów z cytowaniem w powershell.exe.
    await this.uruchom(this.opcje.powershell, [...ARGUMENTY_PS, join(this.opcje.katalogSkryptow, 'druk-raw.ps1')], {
      timeoutMs: this.opcje.limitCzasuMs,
      env: { KOMPLETOR_DRUKARKA: drukarka, KOMPLETOR_PLIK: plik, KOMPLETOR_KOPIE: String(kopie) },
    })
  }

  async stan(): Promise<StanWindows[]> {
    const { stdout } = await this.uruchom(
      this.opcje.powershell,
      [...ARGUMENTY_PS, join(this.opcje.katalogSkryptow, 'stan-drukarek.ps1')],
      { timeoutMs: this.opcje.limitCzasuMs },
    )
    return parsujStanDrukarek(stdout)
  }
}

/** Wyjście stan-drukarek.ps1: tablica JSON {Name, PrinterStatus, JobCount, WorkOffline}. */
export function parsujStanDrukarek(stdout: string): StanWindows[] {
  const tekst = stdout.replace(/^﻿/, '').trim()
  if (!tekst) return []
  let json: unknown
  try {
    json = JSON.parse(tekst)
  } catch {
    throw new BladDruku(`nieczytelny stan drukarek z PowerShella: ${tekst.slice(0, 200)}`)
  }
  // ConvertTo-Json z jednym elementem potrafi zwrócić obiekt zamiast tablicy.
  const lista = Array.isArray(json) ? json : [json]
  return lista
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof p.Name === 'string')
    .map((p) => ({
      nazwa: p.Name as string,
      status: p.PrinterStatus === undefined || p.PrinterStatus === null ? '' : String(p.PrinterStatus),
      offline: p.WorkOffline === true,
      zleceniaWKolejce: typeof p.JobCount === 'number' ? p.JobCount : Number(p.JobCount) || 0,
    }))
}
