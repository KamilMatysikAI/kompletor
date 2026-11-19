// Rdzeń agenta: cykl zleceń (pobierz → drukuj po kolei → odeślij wynik) i raport stanu drukarek.
// Błąd jednego zlecenia kończy się raportem BLAD i nie zatrzymuje kolejnych.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Drukarki } from './drukarki.js'
import { BladDruku } from './drukarki.js'
import type { RaportWyniku, RolaDrukarki, StanDrukarki, StanJednejDrukarki, ZlecenieDruku } from './kontrakt.js'
import { WERSJA_AGENTA, jestTermiczna } from './kontrakt.js'
import type { Log } from './log.js'
import type { MapaRol } from './mapowanie.js'
import { nazwaDrukarki, rolaZapasowa, stanyRol } from './mapowanie.js'
import type { RejestrWydrukow } from './rejestr.js'
import type { PortSerwera } from './serwer.js'
import { BladSerwera } from './serwer.js'

/** Po 401/403 (token unieważniony, stanowisko wyłączone) agent pyta serwer tylko co tyle. */
export const PRZERWA_PO_ODMOWIE_TOKENU_MS = 5 * 60_000
/** 429 bez czytelnego `Retry-After`. */
export const PRZERWA_PO_429_MS = 60_000
/** Górna granica `Retry-After`: serwer nie uśpi agenta na dłużej niż godzinę. */
export const MAKS_PRZERWA_MS = 3600_000

export const KOMUNIKAT_ODMOWY_TOKENU =
  'Serwer odrzucił token stanowiska (nowy token albo wyłączone stanowisko w panelu). Agent pyta teraz tylko co 5 min. ' +
  'Uruchom Zainstaluj.cmd /nowy i wklej nowy kod instalacyjny z panelu'

export interface UstawieniaAgenta {
  stanowisko: string
  drukarki: MapaRol
  katalogTymczasowy: string
  maksBajtowPliku: number
  /** Tyle zadań stojących w kolejce Windows termicznej = traktujemy ją jak awarię (zacięta kolejka). */
  maksKolejkaTermicznej: number
}

export interface ZaleznosciAgenta {
  serwer: PortSerwera
  drukarki: Drukarki
  rejestr: RejestrWydrukow
  log: Log
  ustawienia: UstawieniaAgenta
  teraz?: () => Date
}

export interface PodsumowanieCyklu {
  pobrane: number
  wydrukowane: number
  bledy: number
  /** Zlecenia już wydrukowane wcześniej — tylko ponowiony raport. */
  powtorzone: number
  /** Raporty, których nie udało się wysłać (wrócą, gdy serwer znów poda zlecenie). */
  niewyslaneRaporty: number
  /** Ustawione, gdy nie udało się pobrać listy zleceń. */
  bladSerwera?: string
}

class BladZlecenia extends Error {
  constructor(
    message: string,
    /** true = awaria drukarki (termiczna → rola zapasowa w raporcie); false = problem z plikiem lub danymi. */
    readonly awariaDrukarki: boolean,
  ) {
    super(message)
  }
}

const KOMUNIKAT_PRZERWANY =
  'Druk przerwany (program został zamknięty w trakcie). Sprawdź, czy wydruk wyszedł; jeśli nie — zleć go ponownie z ekranu.'

const komunikatNiepewny = (drukarka: string, powod: string) =>
  `Nie wiadomo, czy wydruk wyszedł: drukarka „${drukarka}” nie odpowiedziała (${powod}). ` +
  'Sprawdź drukarkę i jej kolejkę w Windows; jeśli wydruk nie wyszedł — zleć go ponownie z ekranu.'

export class Agent {
  private readonly teraz: () => Date
  private trwaCykl = false
  private ostatniBladSerwera: string | undefined
  /** Do tej chwili (ms) agent nic nie wysyła do serwera: po odrzuconym tokenie albo 429. */
  private wstrzymaneDo: number | undefined
  private ostatniPowodWstrzymania: string | undefined
  /** Ostatnia udana rozmowa z serwerem (lista zleceń albo stan drukarek) — dla strony ustawień. */
  private kontaktOk: Date | undefined
  /** Od kiedy trwa seria nieudanych prób połączenia (undefined = połączenie działa albo jeszcze nie próbowano). */
  private bladOd: Date | undefined

  constructor(private readonly z: ZaleznosciAgenta) {
    this.teraz = z.teraz ?? (() => new Date())
  }

  /** Jeden obrót kolejki. Nie rzuca — wszystko kończy się w podsumowaniu i logu. */
  async cyklZlecen(): Promise<PodsumowanieCyklu> {
    const podsumowanie: PodsumowanieCyklu = { pobrane: 0, wydrukowane: 0, bledy: 0, powtorzone: 0, niewyslaneRaporty: 0 }
    if (this.trwaCykl) return podsumowanie // poprzedni cykl jeszcze drukuje — nie zaczynamy drugiego równolegle
    this.trwaCykl = true
    try {
      if (this.wstrzymane()) {
        podsumowanie.bladSerwera = this.ostatniBladSerwera ?? 'przerwa po odmowie serwera'
        return podsumowanie
      }
      let lista
      try {
        lista = await this.z.serwer.pobierzZlecenia()
        if (this.ostatniBladSerwera) this.z.log.info('Połączenie z serwerem wróciło')
        this.ostatniBladSerwera = undefined
        this.ostatniPowodWstrzymania = undefined
        this.zanotujKontakt()
      } catch (e) {
        this.zanotujOdmowe(e)
        const tekst = (e as Error).message
        // Serwer leży = błąd co 5 s; logujemy tylko zmianę, żeby log nie zapchał się jedną linią.
        if (tekst !== this.ostatniBladSerwera) this.z.log.uwaga(`Nie udało się pobrać zleceń: ${tekst}`)
        this.ostatniBladSerwera = tekst
        this.bladOd ??= this.teraz()
        podsumowanie.bladSerwera = tekst
        return podsumowanie
      }

      podsumowanie.pobrane = lista.poprawne.length + lista.bledne.length
      for (const b of lista.bledne) {
        this.z.log.uwaga(b.powod, { id: b.id })
        if (!b.id) continue
        podsumowanie.bledy++
        // Rola nieznana → pole `rola` jest wymagane w kontrakcie, więc wpisujemy A4 jako wartość zastępczą
        // (opisane w README, sekcja 4); komunikat mówi, co jest nie tak.
        const ok = await this.wyslijRaport(b.id, { wynik: 'BLAD', komunikat: b.powod, rola: b.rola ?? 'A4' })
        if (!ok) podsumowanie.niewyslaneRaporty++
      }
      if (lista.poprawne.length === 0) return podsumowanie

      const kontekst = new KontekstCyklu(await this.stanyRolBezpiecznie())
      for (const zlecenie of lista.poprawne) {
        // Token odrzucony w trakcie cyklu: reszta zleceń nic jeszcze nie drukowała i wróci z serwera po przerwie.
        if (this.wstrzymane()) break
        let raport: Omit<RaportWyniku, 'stanowisko' | 'czas' | 'ponowienieRaportu'> & { ponowienieRaportu?: boolean }
        try {
          raport = await this.obsluzZlecenie(zlecenie, kontekst)
        } catch (e) {
          // Siatka bezpieczeństwa: nieprzewidziany wyjątek nie zatrzymuje kolejnych zleceń.
          raport = { wynik: 'BLAD', komunikat: `Nieoczekiwany błąd agenta: ${(e as Error).message}`, rola: zlecenie.rola }
        }
        if (raport.ponowienieRaportu) podsumowanie.powtorzone++
        else if (raport.wynik === 'OK') podsumowanie.wydrukowane++
        else podsumowanie.bledy++
        if (raport.wynik === 'BLAD') this.z.log.blad(`Zlecenie ${zlecenie.id}: ${raport.komunikat}`, { rolaZapasowa: raport.rolaZapasowa })
        const ok = await this.wyslijRaport(zlecenie.id, raport)
        if (!ok) podsumowanie.niewyslaneRaporty++
      }
      return podsumowanie
    } finally {
      this.trwaCykl = false
    }
  }

  private async obsluzZlecenie(
    z: ZlecenieDruku,
    kontekst: KontekstCyklu,
  ): Promise<Omit<RaportWyniku, 'stanowisko' | 'czas' | 'ponowienieRaportu'> & { ponowienieRaportu?: boolean }> {
    const { rejestr, log, ustawienia } = this.z
    const wpis = rejestr.pobierz(z.id)
    if (wpis?.stan === 'WYDRUKOWANE') {
      log.info(`Zlecenie ${z.id} było już wydrukowane (${wpis.czas}) — ponawiam tylko raport`)
      return { wynik: 'OK', rola: z.rola, drukarka: wpis.drukarka, ponowienieRaportu: true }
    }
    if (wpis?.stan === 'W_TOKU') {
      return { wynik: 'BLAD', komunikat: KOMUNIKAT_PRZERWANY, rola: z.rola, drukarka: wpis.drukarka, ponowienieRaportu: true }
    }

    const drukarka = nazwaDrukarki(ustawienia.drukarki, z.rola)
    try {
      if (!drukarka) throw new BladZlecenia(`Brak drukarki dla roli ${z.rola} w konfiguracji stanowiska`, true)
      kontekst.sprawdzDrukarke(z.rola, ustawienia.maksKolejkaTermicznej)
      const plik = await this.pobierzDoPliku(z)
      try {
        await rejestr.oznaczWToku(z.id, drukarka)
        try {
          if (z.format === 'pdf') {
            await this.z.drukarki.drukujPdf(drukarka, plik, z.kopie, jestTermiczna(z.rola) ? 'noscale' : 'fit')
          } else {
            await this.z.drukarki.drukujRaw(drukarka, plik, z.kopie)
          }
        } catch (e) {
          if (e instanceof BladDruku && e.niepewny) {
            // Przekroczony czas: zadanie mogło już trafić do kolejki Windows. Wpis W_TOKU zostaje (powtórka tego id
            // = „Druk przerwany”, bez druku), bez roli zapasowej dla tego zlecenia — inaczej serwer utworzyłby
            // nowe zlecenie na zapasie i mogłyby wyjść dwie etykiety kurierskie.
            // Kolejne zlecenia na tę rolę w tym cyklu nie dotarły do drukarki, więc dla nich awaria + rola zapasowa
            // są bezpieczne i nie czekają każde po pełnym limicie czasu (drugi przegląd, WAŻNE 1).
            const blad = new BladZlecenia(komunikatNiepewny(drukarka, e.message), false)
            kontekst.oznaczAwarie(z.rola, e.message)
            throw blad
          }
          // Drukarka odrzuciła zadanie — nic nie wyszło. Wpis znika z rejestru: gdy raport BLAD nie dotrze do
          // serwera i ten poda to samo zlecenie ponownie, agent spróbuje jeszcze raz (bezpiecznie, bo nic nie wyszło).
          // Ponowny druk zlecony z ekranu to zawsze NOWE id (README, sekcja 4).
          await rejestr.usun(z.id)
          kontekst.oznaczAwarie(z.rola, (e as Error).message)
          throw new BladZlecenia(`Drukarka „${drukarka}” odrzuciła wydruk: ${(e as Error).message}`, true)
        }
        try {
          await rejestr.oznaczWydrukowane(z.id, drukarka)
        } catch (e) {
          // Wydruk wyszedł, nie udał się tylko zapis rejestru (pełny dysk, antywirus). Fizyczny stan ma pierwszeństwo:
          // raport OK, inaczej pakujący zleciłby ponowny druk i wyszłyby dwie etykiety. W pamięci
          // wpis jest już WYDRUKOWANE; na dysku zostaje W_TOKU, więc po restarcie powtórka da „Druk przerwany”.
          log.blad(`Zlecenie ${z.id} wydrukowane, ale nie udało się zapisać rejestru wydruków: ${(e as Error).message}`)
        }
      } finally {
        await rm(plik, { force: true }).catch(() => undefined)
      }
      log.info(`Wydrukowano ${z.typ} ${z.id} (${z.format}, ${z.kopie} szt.) na „${drukarka}”`)
      return { wynik: 'OK', rola: z.rola, drukarka }
    } catch (e) {
      const awaria = e instanceof BladZlecenia && e.awariaDrukarki
      const zapas = awaria ? rolaZapasowa(z.rola, ustawienia.drukarki, kontekst.stanyDoZapasu()) : undefined
      return {
        wynik: 'BLAD',
        komunikat: (e as Error).message,
        rola: z.rola,
        ...(drukarka ? { drukarka } : {}),
        ...(zapas ? { rolaZapasowa: zapas } : {}),
      }
    }
  }

  private async pobierzDoPliku(z: ZlecenieDruku): Promise<string> {
    let dane: Buffer
    try {
      dane = await this.z.serwer.pobierzPlik(z.plikUrl, this.z.ustawienia.maksBajtowPliku)
    } catch (e) {
      this.zanotujOdmowe(e)
      throw new BladZlecenia(`Nie udało się pobrać pliku: ${(e as Error).message}`, false)
    }
    if (z.format === 'pdf' && dane.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw new BladZlecenia('Pobrany plik nie jest PDF-em', false)
    if (z.format === 'zpl' && !dane.toString('latin1').toUpperCase().includes('^XA'))
      throw new BladZlecenia('Pobrany plik nie wygląda na ZPL (brak ^XA)', false)
    await mkdir(this.z.ustawienia.katalogTymczasowy, { recursive: true })
    const plik = join(this.z.ustawienia.katalogTymczasowy, `${z.id}.${z.format}`)
    await writeFile(plik, dane)
    return plik
  }

  private async wyslijRaport(
    id: string,
    r: Omit<RaportWyniku, 'stanowisko' | 'czas' | 'ponowienieRaportu'> & { ponowienieRaportu?: boolean },
  ): Promise<boolean> {
    // W przerwie po odmowie nie wysyłamy; wydrukowane zostaje w rejestrze, raport wróci przy kolejnym podaniu zlecenia.
    if (this.wstrzymane()) return false
    const raport: RaportWyniku = {
      stanowisko: this.z.ustawienia.stanowisko,
      ...r,
      ponowienieRaportu: r.ponowienieRaportu ?? false,
      czas: this.teraz().toISOString(),
    }
    try {
      await this.z.serwer.wyslijWynik(id, raport)
      return true
    } catch (e) {
      this.zanotujOdmowe(e)
      // Wydrukowane jest w rejestrze — gdy serwer poda to zlecenie ponownie, odeślemy OK bez drugiego druku.
      this.z.log.uwaga(`Nie udało się wysłać wyniku zlecenia ${id}: ${(e as Error).message}`)
      return false
    }
  }

  /** Stan połączenia z serwerem dla strony ustawień: bez tokenu, tylko czasy i ostatni komunikat. */
  polaczenie(): { ostatniKontakt?: Date; bladOd?: Date; blad?: string; wstrzymaneDo?: Date } {
    return {
      ...(this.kontaktOk ? { ostatniKontakt: this.kontaktOk } : {}),
      ...(this.bladOd ? { bladOd: this.bladOd } : {}),
      ...(this.bladOd && (this.ostatniPowodWstrzymania ?? this.ostatniBladSerwera) ? { blad: this.ostatniPowodWstrzymania ?? this.ostatniBladSerwera } : {}),
      ...(this.wstrzymaneDo !== undefined && this.teraz().getTime() < this.wstrzymaneDo ? { wstrzymaneDo: new Date(this.wstrzymaneDo) } : {}),
    }
  }

  private zanotujKontakt() {
    this.kontaktOk = this.teraz()
    this.bladOd = undefined
  }

  /** true = trwa przerwa po odmowie serwera; nic nie wysyłamy. */
  private wstrzymane(): boolean {
    if (this.wstrzymaneDo === undefined) return false
    if (this.teraz().getTime() < this.wstrzymaneDo) return true
    this.wstrzymaneDo = undefined
    return false
  }

  /**
   * 401/403 = token odrzucony: kolejne pytania co 5 min zamiast co kilka sekund, żeby stary agent nie zapełniał
   * licznika nieudanych prób adresu IP wspólnego z innymi stanowiskami. 429 = przerwa według
   * `Retry-After`. Wpis w logu tylko przy zmianie powodu.
   */
  private zanotujOdmowe(e: unknown): void {
    if (!(e instanceof BladSerwera) || e.status === undefined) return
    let przerwaMs: number
    let powod: string
    if (e.status === 401 || e.status === 403) {
      przerwaMs = PRZERWA_PO_ODMOWIE_TOKENU_MS
      powod = `${KOMUNIKAT_ODMOWY_TOKENU} (odpowiedź ${e.status})`
    } else if (e.status === 429) {
      przerwaMs = Math.min(MAKS_PRZERWA_MS, e.ponowZaSekund !== undefined ? e.ponowZaSekund * 1000 : PRZERWA_PO_429_MS)
      powod = `Serwer ogranicza liczbę żądań (429), przerwa ${Math.ceil(przerwaMs / 1000)} s`
    } else return
    this.wstrzymaneDo = Math.max(this.wstrzymaneDo ?? 0, this.teraz().getTime() + przerwaMs)
    if (powod !== this.ostatniPowodWstrzymania) this.z.log.blad(powod)
    this.ostatniPowodWstrzymania = powod
  }

  private async stanyRolBezpiecznie(): Promise<StanJednejDrukarki[] | undefined> {
    try {
      return stanyRol(this.z.ustawienia.drukarki, await this.z.drukarki.stan())
    } catch (e) {
      // Nie wiemy, jak się mają drukarki — drukujemy mimo to; błąd druku i tak wyjdzie przy samym zleceniu.
      this.z.log.uwaga(`Nie udało się odczytać stanu drukarek przed drukiem: ${(e as Error).message}`)
      return undefined
    }
  }

  /** Stan wszystkich ról z konfiguracji dla POST /api/druk/stan. */
  async zbierzStan(): Promise<StanJednejDrukarki[]> {
    const mapa = this.z.ustawienia.drukarki
    try {
      return stanyRol(mapa, await this.z.drukarki.stan())
    } catch (e) {
      const komunikat = `nie udało się odczytać stanu z Windows: ${(e as Error).message}`
      return Object.entries(mapa)
        .filter(([, nazwa]) => nazwa?.trim())
        .map(([rola, nazwa]) => ({ rola: rola as RolaDrukarki, nazwa: nazwa!, stan: 'BLAD' as const, komunikat, zleceniaWKolejce: null }))
    }
  }

  async raportujStan(): Promise<boolean> {
    if (this.wstrzymane()) return false
    const drukarki = await this.zbierzStan()
    try {
      await this.z.serwer.wyslijStan({
        stanowisko: this.z.ustawienia.stanowisko,
        czas: this.teraz().toISOString(),
        wersjaAgenta: WERSJA_AGENTA,
        drukarki,
      })
      this.zanotujKontakt()
      return true
    } catch (e) {
      this.zanotujOdmowe(e)
      this.bladOd ??= this.teraz()
      // Bez osobnego wpisu co minutę, gdy serwer leży — tę samą przyczynę loguje cykl zleceń.
      if (!this.ostatniBladSerwera) this.z.log.uwaga(`Nie udało się wysłać stanu drukarek: ${(e as Error).message}`)
      return false
    }
  }
}

/** Wiedza o drukarkach w obrębie jednego cyklu: stan z Windows + awarie wykryte przy druku. */
class KontekstCyklu {
  private readonly stany = new Map<RolaDrukarki, StanJednejDrukarki>()
  private readonly awarie = new Map<RolaDrukarki, string>()

  constructor(stany: StanJednejDrukarki[] | undefined) {
    for (const s of stany ?? []) this.stany.set(s.rola, s)
  }

  /** Rzuca BladZlecenia, gdy wiadomo, że drukarka tej roli nie wydrukuje. */
  sprawdzDrukarke(rola: RolaDrukarki, maksKolejkaTermicznej: number) {
    const awaria = this.awarie.get(rola)
    if (awaria) throw new BladZlecenia(`Drukarka ${rola} zawiodła wcześniej w tym cyklu: ${awaria}`, true)
    const s = this.stany.get(rola)
    if (!s) return
    if (s.stan !== 'DOSTEPNA') throw new BladZlecenia(`Drukarka „${s.nazwa}” (${rola}): ${s.komunikat ?? s.stan}`, true)
    if (jestTermiczna(rola) && s.zleceniaWKolejce !== null && s.zleceniaWKolejce >= maksKolejkaTermicznej)
      throw new BladZlecenia(
        `Drukarka „${s.nazwa}” (${rola}) ma ${s.zleceniaWKolejce} niewydrukowanych zadań w kolejce Windows — prawdopodobnie stoi`,
        true,
      )
  }

  oznaczAwarie(rola: RolaDrukarki, powod: string) {
    this.awarie.set(rola, powod)
  }

  stanyDoZapasu(): Map<RolaDrukarki, StanDrukarki> {
    const m = new Map<RolaDrukarki, StanDrukarki>()
    for (const [rola, s] of this.stany) m.set(rola, s.stan)
    for (const rola of this.awarie.keys()) m.set(rola, 'BLAD')
    return m
  }
}
