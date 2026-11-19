// Log do pliku z rotacją według rozmiaru (agent-druku.log → .1 → .2 …). Bez zależności: zapis synchroniczny,
// żeby po awarii procesu ostatnia linia była w pliku. Do logu nigdy nie trafia token ani treść plików.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type PoziomLogu = 'INFO' | 'UWAGA' | 'BLAD'

export interface Log {
  info(tekst: string, dane?: Record<string, unknown>): void
  uwaga(tekst: string, dane?: Record<string, unknown>): void
  blad(tekst: string, dane?: Record<string, unknown>): void
}

export interface OpcjeLoguPlikowego {
  plik: string
  maksBajtow: number
  /** Ile starych plików trzymać obok bieżącego. */
  plikow: number
  naKonsole?: boolean
  teraz?: () => Date
}

/** Czas lokalny komputera (osoba w magazynie czyta log w swojej strefie), np. 2026-10-25 11:05:03. */
export function czasLokalny(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export class LogPlikowy implements Log {
  private readonly teraz: () => Date

  constructor(private readonly opcje: OpcjeLoguPlikowego) {
    this.teraz = opcje.teraz ?? (() => new Date())
    mkdirSync(dirname(opcje.plik), { recursive: true })
  }

  info(tekst: string, dane?: Record<string, unknown>) {
    this.zapisz('INFO', tekst, dane)
  }
  uwaga(tekst: string, dane?: Record<string, unknown>) {
    this.zapisz('UWAGA', tekst, dane)
  }
  blad(tekst: string, dane?: Record<string, unknown>) {
    this.zapisz('BLAD', tekst, dane)
  }

  private zapisz(poziom: PoziomLogu, tekst: string, dane?: Record<string, unknown>) {
    const linia = `${czasLokalny(this.teraz())} ${poziom.padEnd(5)} ${tekst}${dane ? ' ' + JSON.stringify(dane) : ''}\n`
    if (this.opcje.naKonsole) process.stdout.write(linia)
    try {
      this.rotujJesliTrzeba(Buffer.byteLength(linia))
      appendFileSync(this.opcje.plik, linia, 'utf8')
    } catch (e) {
      // Pełny dysk albo plik zablokowany przez antywirusa nie może zatrzymać drukowania.
      process.stderr.write(`Nie udało się zapisać logu: ${(e as Error).message}\n`)
    }
  }

  private rotujJesliTrzeba(dopisane: number) {
    const { plik, maksBajtow, plikow } = this.opcje
    if (!existsSync(plik) || statSync(plik).size + dopisane <= maksBajtow) return
    const najstarszy = `${plik}.${plikow}`
    if (existsSync(najstarszy)) rmSync(najstarszy)
    for (let i = plikow - 1; i >= 1; i--) {
      if (existsSync(`${plik}.${i}`)) renameSync(`${plik}.${i}`, `${plik}.${i + 1}`)
    }
    if (plikow >= 1) renameSync(plik, `${plik}.1`)
    else rmSync(plik)
  }
}

/** Log w pamięci — do testów. */
export class LogPamieci implements Log {
  readonly wpisy: { poziom: PoziomLogu; tekst: string; dane?: Record<string, unknown> }[] = []
  info(tekst: string, dane?: Record<string, unknown>) {
    this.wpisy.push({ poziom: 'INFO', tekst, dane })
  }
  uwaga(tekst: string, dane?: Record<string, unknown>) {
    this.wpisy.push({ poziom: 'UWAGA', tekst, dane })
  }
  blad(tekst: string, dane?: Record<string, unknown>) {
    this.wpisy.push({ poziom: 'BLAD', tekst, dane })
  }
}
