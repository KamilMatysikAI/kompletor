// Odstęp między odczytami odbiorcy jednego konta. Adapter powstaje przy każdym odczycie,
// więc limiter klienta kanału (np. `Throttle` Mirakla) nie przeżywa między wywołaniami: pilnujemy odstępu tutaj, w
// procesie. Trzyma wyłącznie klucz konta i znacznik czasu następnego wolnego okna, nigdy dane odbiorcy.
// Nie koordynuje się z innymi procesami (worker czyta dziennik osobno): to ochrona przed seriami ze stanowiska.
import { sleep as domyslnySen } from '../zrodla/http'

/** Kolejka chętnych przekroczyła limit czekania: odczyt odrzucony bez rezerwacji okna (do ponowienia później). */
export class TempoPrzekroczone extends Error {
  constructor(readonly czekanieMs: number) {
    super(`Odczyt odbiorcy wstrzymany limitem tempa kanału (wolne okno za ${Math.ceil(czekanieMs / 1000)} s).`)
    this.name = 'TempoPrzekroczone'
  }
}

export class TempoOdbiorcy {
  private readonly nastepne = new Map<string, number>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = domyslnySen,
  ) {}

  /**
   * Czeka na wolne okno konta `klucz` (odstęp `odstepMs`) i od razu rezerwuje następne, więc równoległe wywołania
   * ustawiają się w kolejce zamiast iść naraz. Gdy czekanie przekroczyłoby `maksCzekanieMs`, rzuca `TempoPrzekroczone`
   * i niczego nie rezerwuje (żądanie HTTP stanowiska nie wisi minutami).
   */
  async czekaj(klucz: string, odstepMs: number, maksCzekanieMs = odstepMs): Promise<void> {
    if (!(odstepMs > 0)) return
    const t = this.now()
    const okno = Math.max(t, this.nastepne.get(klucz) ?? 0)
    const czekanie = okno - t
    if (czekanie > maksCzekanieMs) throw new TempoPrzekroczone(czekanie)
    this.nastepne.set(klucz, okno + odstepMs)
    if (czekanie > 0) await this.sleep(czekanie)
  }
}

/** Jeden limiter na proces (web albo worker). */
export const tempoOdbiorcy = new TempoOdbiorcy()
