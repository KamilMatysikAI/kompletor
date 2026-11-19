// Lokalny rejestr wydruków — idempotencja po restarcie programu (pkt 5).
//
// Decyzja 2026-10-25: zlecenie dostaje wpis W_TOKU tuż PRZED wysłaniem do drukarki, a WYDRUKOWANE zaraz po.
// Gdy program padnie w trakcie, po restarcie wpis W_TOKU blokuje ponowny druk i agent odsyła BLAD „sprawdź,
// czy wyszło” — człowiek zleca ponownie z ekranu (nowe id). Wolimy jedną etykietę za mało (widać od razu przy
// pakowaniu) niż dwie te same etykiety kurierskie (dwa nadania, dwie opłaty). Wpisy starsze niż 7 dni są usuwane:
// serwer nie zwraca tak starych zleceń, a plik nie rośnie bez końca.
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type StanWpisu = 'W_TOKU' | 'WYDRUKOWANE'

export interface WpisRejestru {
  stan: StanWpisu
  /** ISO 8601 ostatniej zmiany stanu. */
  czas: string
  drukarka?: string
}

export interface OpcjeRejestru {
  dniPrzechowywania?: number
  teraz?: () => Date
}

const DOBA_MS = 24 * 3600_000

export class RejestrWydrukow {
  private wpisy = new Map<string, WpisRejestru>()
  private kolejkaZapisu: Promise<void> = Promise.resolve()
  private readonly teraz: () => Date
  private readonly dniPrzechowywania: number

  private constructor(
    private readonly plik: string,
    opcje: OpcjeRejestru,
  ) {
    this.teraz = opcje.teraz ?? (() => new Date())
    this.dniPrzechowywania = opcje.dniPrzechowywania ?? 7
  }

  /**
   * Wczytuje rejestr z pliku (brak pliku = pusty). Uszkodzony plik jest odkładany jako *.uszkodzony-<czas>
   * i zaczynamy od pustego — informacja trafia do wyniku, żeby agent ją zalogował.
   */
  static async wczytaj(plik: string, opcje: OpcjeRejestru = {}): Promise<{ rejestr: RejestrWydrukow; uszkodzony?: string }> {
    const rejestr = new RejestrWydrukow(plik, opcje)
    mkdirSync(dirname(plik), { recursive: true })
    if (!existsSync(plik)) return { rejestr }
    const tekst = await readFile(plik, 'utf8')
    try {
      const json = JSON.parse(tekst) as { wpisy?: Record<string, WpisRejestru> }
      for (const [id, w] of Object.entries(json.wpisy ?? {})) {
        if ((w.stan === 'W_TOKU' || w.stan === 'WYDRUKOWANE') && typeof w.czas === 'string') rejestr.wpisy.set(id, w)
      }
      return { rejestr }
    } catch {
      const kopia = `${plik}.uszkodzony-${rejestr.teraz().getTime()}`
      await rename(plik, kopia)
      return { rejestr, uszkodzony: kopia }
    }
  }

  pobierz(id: string): WpisRejestru | undefined {
    return this.wpisy.get(id)
  }

  get rozmiar(): number {
    return this.wpisy.size
  }

  async oznaczWToku(id: string, drukarka: string): Promise<void> {
    this.wpisy.set(id, { stan: 'W_TOKU', czas: this.teraz().toISOString(), drukarka })
    await this.zapisz()
  }

  async oznaczWydrukowane(id: string, drukarka: string): Promise<void> {
    this.wpisy.set(id, { stan: 'WYDRUKOWANE', czas: this.teraz().toISOString(), drukarka })
    await this.zapisz()
  }

  /**
   * Po pewnym błędzie druku (drukarka odrzuciła zadanie, nic nie wyszło). Serwer nie zleca tego samego id drugi raz
   * (ponowny druk = nowe id), ale może podać je jeszcze raz, jeśli nie dostał raportu BLAD — wtedy agent drukuje
   * ponownie zamiast zgłaszać „Druk przerwany”.
   */
  async usun(id: string): Promise<void> {
    if (this.wpisy.delete(id)) await this.zapisz()
  }

  /** Usuwa wpisy starsze niż dniPrzechowywania. Zwraca liczbę usuniętych. */
  async sprzataj(): Promise<number> {
    const granica = this.teraz().getTime() - this.dniPrzechowywania * DOBA_MS
    let usuniete = 0
    for (const [id, w] of this.wpisy) {
      const t = Date.parse(w.czas)
      if (Number.isNaN(t) || t < granica) {
        this.wpisy.delete(id)
        usuniete++
      }
    }
    if (usuniete > 0) await this.zapisz()
    return usuniete
  }

  /** Zapis atomowy (plik tymczasowy + rename), szeregowany — nigdy pół pliku po zaniku prądu. */
  private zapisz(): Promise<void> {
    const migawka = JSON.stringify({ wersja: 1, wpisy: Object.fromEntries(this.wpisy) }, null, 1)
    const zapis = this.kolejkaZapisu.then(async () => {
      const tymczasowy = `${this.plik}.tmp`
      await writeFile(tymczasowy, migawka, 'utf8')
      await zamienZPonowieniem(tymczasowy, this.plik)
    })
    // Błąd jednego zapisu nie blokuje kolejnych; wywołujący dostaje go przez `zapis`.
    this.kolejkaZapisu = zapis.catch(() => undefined)
    return zapis
  }
}

/** Windows: antywirus albo indeksowanie potrafi chwilę trzymać plik (EPERM/EBUSY) — kilka prób. */
export async function zamienZPonowieniem(z: string, na: string, zamien: (z: string, na: string) => Promise<void> = rename): Promise<void> {
  for (let proba = 0; ; proba++) {
    try {
      await zamien(z, na)
      return
    } catch (e) {
      const kod = (e as NodeJS.ErrnoException).code
      if (proba >= 4 || (kod !== 'EPERM' && kod !== 'EBUSY' && kod !== 'EACCES')) throw e
      await new Promise((r) => setTimeout(r, 50 * (proba + 1)))
    }
  }
}
