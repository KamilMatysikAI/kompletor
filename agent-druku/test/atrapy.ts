// Atrapy drukarek i serwera — testy nic nie drukują i nie łączą się z prawdziwym Kompletorem.
import { readFileSync } from 'node:fs'
import type { Drukarki, Skalowanie } from '../src/drukarki.js'
import { BladDruku } from '../src/drukarki.js'
import type { RaportStanu, RaportWyniku, ZleceniaPoParsowaniu, ZlecenieDruku } from '../src/kontrakt.js'
import { parsujZlecenia } from '../src/kontrakt.js'
import type { StanWindows } from '../src/mapowanie.js'
import type { PortSerwera } from '../src/serwer.js'
import { BladSerwera } from '../src/serwer.js'

export const PDF = Buffer.from('%PDF-1.7\n% Karta zamówienia: Jan Testowy, ul. Przykładowa 1, 00-000 Testowo\n%%EOF\n')
export const ZPL = Buffer.from('^XA^CI28^FO50,50^A0N,40,40^FDJan Testowy, ul. Przykładowa 1, 00-000 Testowo^FS^XZ')

export interface WywolanieDruku {
  rodzaj: 'pdf' | 'raw'
  drukarka: string
  kopie: number
  skalowanie?: Skalowanie
  tresc: string
}

export class AtrapaDrukarek implements Drukarki {
  readonly wydruki: WywolanieDruku[] = []
  stany: StanWindows[] = [
    { nazwa: 'Brother A4', status: 'Normal', offline: false, zleceniaWKolejce: 0 },
    { nazwa: 'Termiczna 1', status: 'Normal', offline: false, zleceniaWKolejce: 0 },
    { nazwa: 'Termiczna 2', status: 'Normal', offline: false, zleceniaWKolejce: 0 },
  ]
  /** Nazwy drukarek, które odrzucają zadania (np. odłączona termiczna). */
  readonly psute = new Set<string>()
  /** Nazwy drukarek, na których druk przekracza czas (nie wiadomo, czy wyszło). */
  readonly niepewne = new Set<string>()
  bladStanu: Error | undefined
  /** Wywoływane na początku druku — np. do rzucenia nieoczekiwanego wyjątku. */
  wTrakcieDruku: (() => void) | undefined
  wywolaniaStanu = 0
  /** true = druk nigdy się nie kończy (symulacja zamknięcia programu w trakcie). */
  zawies = false
  zawieszone = 0

  private async poczatekDruku(drukarka: string) {
    this.wTrakcieDruku?.()
    if (this.niepewne.has(drukarka)) throw new BladDruku('przekroczony czas 60 s', true)
    if (this.zawies) {
      this.zawieszone++
      await new Promise(() => undefined)
    }
  }

  async drukujPdf(drukarka: string, plik: string, kopie: number, skalowanie: Skalowanie) {
    await this.poczatekDruku(drukarka)
    if (this.psute.has(drukarka)) throw new BladDruku('kod wyjścia 1: Printing failed')
    this.wydruki.push({ rodzaj: 'pdf', drukarka, kopie, skalowanie, tresc: readFileSync(plik, 'latin1') })
  }

  async drukujRaw(drukarka: string, plik: string, kopie: number) {
    await this.poczatekDruku(drukarka)
    if (this.psute.has(drukarka)) throw new BladDruku('kod wyjścia 1: OpenPrinter: Odmowa dostępu')
    this.wydruki.push({ rodzaj: 'raw', drukarka, kopie, tresc: readFileSync(plik, 'utf8') })
  }

  async stan() {
    this.wywolaniaStanu++
    if (this.bladStanu) throw this.bladStanu
    return this.stany.map((s) => ({ ...s }))
  }

  ustawStan(nazwa: string, zmiana: Partial<StanWindows>) {
    const s = this.stany.find((x) => x.nazwa === nazwa)
    if (!s) throw new Error(`brak ${nazwa}`)
    Object.assign(s, zmiana)
  }
}

export class AtrapaSerwera implements PortSerwera {
  /** Surowa odpowiedź GET /api/druk/zlecenia — jak z sieci, przed parsowaniem. */
  odpowiedz: unknown = { zlecenia: [] }
  readonly pliki = new Map<string, Buffer>()
  readonly wyniki: { id: string; raport: RaportWyniku }[] = []
  readonly stany: RaportStanu[] = []
  niedostepny = false
  /** Odpowiedź błędu na każde żądanie (np. 401 po unieważnieniu tokenu, 429). */
  odmowa: BladSerwera | undefined
  /** Liczba żądań, które doszły do serwera (także odrzuconych). */
  zadania = 0
  /** Ile kolejnych wysyłek wyniku ma się nie udać. */
  bledyWyniku = 0
  /** Zachowanie jak prawdziwego serwera: po raporcie zlecenie znika z listy. */
  usuwajPoRaporcie = false

  zlecenia(...z: ZlecenieDruku[]) {
    this.odpowiedz = { zlecenia: z }
  }

  private sprawdzOdmowe() {
    this.zadania++
    if (this.odmowa) throw this.odmowa
  }

  async pobierzZlecenia(): Promise<ZleceniaPoParsowaniu> {
    this.sprawdzOdmowe()
    if (this.niedostepny) throw new BladSerwera('Brak połączenia z serwerem (atrapa): ECONNREFUSED')
    return parsujZlecenia(JSON.parse(JSON.stringify(this.odpowiedz)))
  }

  async wyslijWynik(id: string, raport: RaportWyniku) {
    this.sprawdzOdmowe()
    if (this.niedostepny || this.bledyWyniku > 0) {
      this.bledyWyniku = Math.max(0, this.bledyWyniku - 1)
      throw new BladSerwera('Serwer odpowiedział 503 dla /api/druk/zlecenia/x/wynik', 503)
    }
    this.wyniki.push({ id, raport })
    if (this.usuwajPoRaporcie) {
      const o = this.odpowiedz as { zlecenia: { id: string }[] }
      o.zlecenia = o.zlecenia.filter((z) => z.id !== id)
    }
  }

  async wyslijStan(raport: RaportStanu) {
    this.sprawdzOdmowe()
    if (this.niedostepny) throw new BladSerwera('Brak połączenia z serwerem (atrapa)')
    this.stany.push(raport)
  }

  async pobierzPlik(plikUrl: string) {
    this.sprawdzOdmowe()
    const p = this.pliki.get(plikUrl)
    if (!p) throw new BladSerwera(`Serwer odpowiedział 404 dla ${plikUrl}`, 404)
    return p
  }
}

let licznik = 0
export function zlecenie(z: Partial<ZlecenieDruku> = {}): ZlecenieDruku {
  licznik++
  return {
    id: `zl-${licznik}`,
    typ: 'karta',
    format: 'pdf',
    rola: 'A4',
    plikUrl: `/pliki/${z.id ?? `zl-${licznik}`}`,
    kopie: 1,
    ...z,
  }
}
