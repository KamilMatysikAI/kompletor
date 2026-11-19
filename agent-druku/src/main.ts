// Punkt startowy: `node dist/main.js [--konfig ścieżka] [--sprawdz-konfig | --instaluj]`. Uruchamiany przez Harmonogram
// zadań Windows przy logowaniu (skrypty/start.ps1) albo ręcznie przez uruchom.cmd. `--instaluj` to rozmowa instalatora
// w konsoli (droga awaryjna): kod instalacyjny i przypisanie drukarek (instalator.ts), wołana przez skrypty/instaluj.ps1.
// Zwykły start uruchamia też stronę „Kompletor Druk (ustawienia)” na 127.0.0.1 (ustawienia.ts).
//
// Kody wyjścia (czyta je skrypty/start.ps1):
//   0 — zatrzymany celowo (koniec pętli),
//   1 — awaria (start.ps1 uruchamia ponownie za 30 s),
//   2 — błędna konfiguracja i brak strony ustawień (restart nic nie da, start.ps1 kończy pracę z wpisem w
//       logi\start.log); z działającą stroną ustawień program nie kończy się, tylko czeka na ustawienia,
//   3 — działa już inna kopia agenta (start.ps1 próbuje ponownie co 60 s),
//   4 — ponowne uruchomienie ze strony ustawień (start.ps1 uruchamia od razu).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zalozBlokade } from './blokada.js'
import { DrukarkiWindows } from './drukarki.js'
import { Agent } from './kolejka.js'
import { WERSJA_AGENTA } from './kontrakt.js'
import type { Konfiguracja } from './konfiguracja.js'
import { BladKonfiguracji, bezDrukarek, domyslnaSumatra, ostrzezeniaKonfiguracji, PORT_USTAWIEN, wczytajKonfiguracje } from './konfiguracja.js'
import { instaluj, sprawdzKodNaSerwerze } from './instalator.js'
import { LogPlikowy } from './log.js'
import { RejestrWydrukow } from './rejestr.js'
import { KlientSerwera } from './serwer.js'
import {
  czyWindowsZarzadzaDomyslna,
  kluczUstawien,
  portyUstawien,
  surowaKonfiguracja,
  uruchomSerwerUstawien,
  wyczyscAdres,
  zachowajKluczPrzyRestarcie,
  zapiszAdres,
} from './ustawienia.js'

/** Katalog programu = katalog nad dist/ (tam leżą agent-druku.json, skrypty/, dane/, logi/). */
const KATALOG_PROGRAMU = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const KOD_AWARIA = 1
export const KOD_BLAD_KONFIGURACJI = 2
export const KOD_DZIALA_INNA_KOPIA = 3
/** Ponowne uruchomienie na życzenie (przycisk na stronie ustawień): start.ps1 uruchamia od razu, bez przerwy. */
export const KOD_RESTART = 4

/**
 * Znacznik w katalogu danych: czas ostatniego raportu stanu przyjętego przez serwer. Czyta go instaluj.ps1, żeby
 * zakończyć instalację dopiero po pierwszym raporcie (agent naprawdę rozmawia z serwerem). Bez danych z serwera.
 */
export const PLIK_ZNACZNIKA_STANU = 'ostatni-raport-stanu.txt'

/** `--sprawdz-konfig`: kod wyjścia (0 albo KOD_BLAD_KONFIGURACJI) i tekst dla człowieka, po polsku. */
export function sprawdzPlikKonfiguracji(plik: string, katalogProgramu: string): { kod: number; tekst: string } {
  try {
    const k = wczytajKonfiguracje(plik, katalogProgramu)
    return { kod: 0, tekst: ['Konfiguracja poprawna.', ...ostrzezeniaKonfiguracji(k).map((w) => `UWAGA: ${w}`)].join('\n') }
  } catch (e) {
    const tekst = e instanceof BladKonfiguracji ? e.message : `Nie udało się wczytać konfiguracji: ${(e as Error).message}`
    return { kod: KOD_BLAD_KONFIGURACJI, tekst }
  }
}

/**
 * Powtarza `krok` co `odstepMs` po zakończeniu poprzedniego (bez nakładania się) aż do `sygnal.abort()`. Kończy się
 * dopiero po dokończeniu kroku w toku: przeładowanie ustawień w trakcie druku nie uruchomi drugiej kolejki obok
 * pierwszej (ten sam wydruk dwa razy).
 */
export function powtarzaj(krok: () => Promise<unknown>, odstepMs: number, sygnal: AbortSignal): Promise<void> {
  return new Promise((koniec) => {
    let licznik: NodeJS.Timeout | undefined
    let wTrakcie = false
    const obrot = async () => {
      if (sygnal.aborted) return koniec()
      wTrakcie = true
      await krok().catch(() => undefined)
      wTrakcie = false
      if (sygnal.aborted) return koniec()
      licznik = setTimeout(obrot, odstepMs)
    }
    sygnal.addEventListener('abort', () => {
      clearTimeout(licznik)
      if (!wTrakcie) koniec()
    })
    void obrot()
  })
}

/** Katalogi i port strony z pliku konfiguracji, nawet gdy reszta pliku jest błędna albo pliku nie ma. */
export function sciezkiZPliku(plik: string, katalogProgramu: string): { katalogDanych: string; katalogLogow: string; port: number } {
  const k = surowaKonfiguracja(plik)
  const sciezka = (v: unknown, domyslna: string) =>
    typeof v === 'string' && v.trim() ? (isAbsolute(v) ? v : resolve(katalogProgramu, v)) : join(katalogProgramu, domyslna)
  const p = k.portUstawien
  const port = typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65534 ? p : PORT_USTAWIEN
  return { katalogDanych: sciezka(k.katalogDanych, 'dane'), katalogLogow: sciezka(k.katalogLogow, 'logi'), port }
}

/** Czeka na sygnał (przeładowanie albo koniec programu). */
const czekajNa = (s: AbortSignal) => new Promise<void>((r) => (s.aborted ? r() : s.addEventListener('abort', () => r(), { once: true })))

async function main() {
  const i = process.argv.indexOf('--konfig')
  const plikKonfiguracji = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]!) : join(KATALOG_PROGRAMU, 'agent-druku.json')

  if (process.argv.includes('--instaluj')) {
    // Zamknięte wejście (EOF) zostawia pytanie bez odpowiedzi i Node kończy się sam; bez tego kodem 0,
    // a instaluj.ps1 brał to za zapisaną konfigurację. Kod 1, dopóki instalator nie skończy.
    process.exitCode = KOD_AWARIA
    process.exitCode = await instaluj({ plikKonfiguracji, katalogSkryptow: join(KATALOG_PROGRAMU, 'skrypty'), sumatraPdf: domyslnaSumatra(KATALOG_PROGRAMU) })
    return
  }

  if (process.argv.includes('--sprawdz-konfig')) {
    // Wołane przez instaluj.ps1 przed założeniem zadania. Wszystko na stdout (stderr w PowerShell 5.1 pod
    // $ErrorActionPreference = 'Stop' przerwałby instalator wyjątkiem zamiast pokazać listę błędów).
    const { kod, tekst } = sprawdzPlikKonfiguracji(plikKonfiguracji, KATALOG_PROGRAMU)
    process.stdout.write(`${tekst}\n`)
    process.exitCode = kod
    return
  }

  // Katalogi i port bez pełnej walidacji: program bez poprawnej konfiguracji też startuje — pokazuje stronę ustawień
  // i czeka, aż ktoś podłączy go do Kompletora i wybierze drukarki.
  const sciezki = sciezkiZPliku(plikKonfiguracji, KATALOG_PROGRAMU)
  let konfig: Konfiguracja | undefined
  let bladKonfiguracji: string | undefined
  const wczytaj = () => {
    try {
      konfig = wczytajKonfiguracje(plikKonfiguracji, KATALOG_PROGRAMU)
      bladKonfiguracji = undefined
    } catch (e) {
      konfig = undefined
      bladKonfiguracji = e instanceof BladKonfiguracji ? e.message : `Nie udało się wczytać konfiguracji: ${(e as Error).message}`
    }
  }
  wczytaj()

  const startowa = konfig as Konfiguracja | undefined
  const log = new LogPlikowy({
    plik: join(sciezki.katalogLogow, 'agent-druku.log'),
    maksBajtow: (startowa?.log.maksMb ?? 5) * 1024 * 1024,
    plikow: startowa?.log.plikow ?? 5,
    naKonsole: process.stdout.isTTY === true,
  })

  mkdirSync(sciezki.katalogDanych, { recursive: true })
  const plikBlokady = join(sciezki.katalogDanych, 'agent.lock')
  const { zwolnij, zajetaPrzez } = zalozBlokade(plikBlokady)
  if (!zwolnij) {
    log.uwaga(
      `Agent druku już działa na tym komputerze${zajetaPrzez ? ` (proces ${zajetaPrzez})` : ''} — ta kopia kończy pracę. ` +
        `Jeśli ekran pakowania nie pokazuje stanu drukarek, usuń plik ${plikBlokady} i uruchom Zainstaluj.cmd`,
    )
    process.exitCode = KOD_DZIALA_INNA_KOPIA
    return
  }

  const { rejestr, uszkodzony } = await RejestrWydrukow.wczytaj(join(sciezki.katalogDanych, 'wydrukowane.json'))
  if (uszkodzony) log.blad(`Rejestr wydruków był uszkodzony — odłożony jako ${uszkodzony}; możliwy ponowny druk ostatnich zleceń`)
  const usuniete = await rejestr.sprzataj()

  const stop = new AbortController()
  let kodWyjscia = 0
  let pokolenie = new AbortController()
  let agent: Agent | undefined
  const zakoncz = (powod: string, kod = 0) => {
    if (stop.signal.aborted) return
    log.info(`Zatrzymanie agenta (${powod})`)
    kodWyjscia = kod
    stop.abort()
    pokolenie.abort()
  }
  process.on('SIGINT', () => zakoncz('SIGINT'))
  process.on('SIGTERM', () => zakoncz('SIGTERM'))
  process.on('SIGBREAK', () => zakoncz('zamknięcie okna'))
  process.on('unhandledRejection', (e) => log.blad(`Nieobsłużony błąd: ${(e as Error)?.stack ?? String(e)}`))
  process.on('uncaughtException', (e) => {
    log.blad(`Krytyczny błąd, restart przez Harmonogram zadań: ${e.stack ?? e.message}`)
    zwolnij()
    process.exit(KOD_AWARIA)
  })

  let strona: { adres: string; zamknij: () => Promise<void> } | undefined
  try {
    strona = await uruchomSerwerUstawien(
      {
        plikKonfiguracji,
        katalogProgramu: KATALOG_PROGRAMU,
        plikLogu: () => join(sciezki.katalogLogow, 'agent-druku.log'),
        drukarki: () =>
          new DrukarkiWindows({
            sumatraPdf: konfig?.sumatraPdf ?? domyslnaSumatra(KATALOG_PROGRAMU),
            powershell: konfig?.powershell ?? 'powershell.exe',
            katalogSkryptow: join(KATALOG_PROGRAMU, 'skrypty'),
            limitCzasuMs: 60_000,
          }),
        stan: () => ({
          ...(konfig ? { stanowisko: konfig.stanowisko, serwer: new URL(konfig.serwer).origin } : {}),
          ...(bladKonfiguracji ? { bladKonfiguracji } : {}),
          ...(agent ? { polaczenie: agent.polaczenie() } : {}),
        }),
        sprawdzKod: (k) => sprawdzKodNaSerwerze(k),
        przeladuj: () => pokolenie.abort(),
        uruchomPonownie: () => {
          zachowajKluczPrzyRestarcie(sciezki.katalogDanych)
          zakoncz('ponowne uruchomienie ze strony ustawień', KOD_RESTART)
        },
        zarzadzanieDomyslna: () => czyWindowsZarzadzaDomyslna(),
        log,
      },
      { porty: portyUstawien(sciezki.port), klucz: kluczUstawien(sciezki.katalogDanych) },
    )
    zapiszAdres(sciezki.katalogDanych, strona.adres)
  } catch (e) {
    // Bez strony ustawień drukowanie działa dalej; ustawienia zostają przez Zainstaluj.cmd /konsola.
    log.blad(`Strona ustawień nie wystartowała: ${(e as Error).message}`)
  }

  log.info(`Start agenta druku ${WERSJA_AGENTA}`, { wpisowRejestru: rejestr.rozmiar, usunietychStarych: usuniete, stronaUstawien: strona ? 'tak' : 'nie' })

  // Pętla pokoleń: „Zapisz” na stronie ustawień kończy bieżące pokolenie (po dokończeniu wydruku w toku) i wczytuje
  // konfigurację od nowa — bez wylogowania z Windows i bez restartu procesu.
  let pierwszyObrot = true
  while (!stop.signal.aborted) {
    pokolenie = new AbortController()
    if (!pierwszyObrot) wczytaj()
    pierwszyObrot = false
    if (!konfig) {
      agent = undefined
      // Świeża instalacja (brak pliku) to nie błąd, tylko stan „czeka na podłączenie”; reszta jako błąd w jednej linii.
      // Podłączony kodem, ale bez wybranych drukarek: też zwykły krok ustawień, nie błąd.
      if (!existsSync(plikKonfiguracji)) log.info('Program nie jest jeszcze podłączony do Kompletora')
      else if (bladKonfiguracji && bezDrukarek(bladKonfiguracji)) log.info('Program podłączony, czeka na wybór drukarek')
      else log.blad((bladKonfiguracji ?? 'Brak konfiguracji').replace(/:\n- /, ': ').replace(/\n- /g, '; '))
      if (!strona) {
        // Bez strony ustawień nikt tego nie naprawi z wnętrza programu — jak dotąd kod 2 dla start.ps1.
        process.exitCode = KOD_BLAD_KONFIGURACJI
        zwolnij()
        return
      }
      log.info('Program czeka na ustawienia (strona „Kompletor Druk (ustawienia)”)')
      await czekajNa(pokolenie.signal)
      continue
    }
    const k: Konfiguracja = konfig
    const a = new Agent({
      serwer: new KlientSerwera({
        serwer: k.serwer,
        token: k.token,
        stanowisko: k.stanowisko,
        timeoutMs: k.limitCzasuSerweraSekundy * 1000,
        dozwoloneHostyPlikow: k.dozwoloneHostyPlikow,
      }),
      drukarki: new DrukarkiWindows({
        sumatraPdf: k.sumatraPdf,
        powershell: k.powershell,
        katalogSkryptow: join(KATALOG_PROGRAMU, 'skrypty'),
        limitCzasuMs: k.limitCzasuDrukuSekundy * 1000,
      }),
      rejestr,
      log,
      ustawienia: {
        stanowisko: k.stanowisko,
        drukarki: k.drukarki,
        katalogTymczasowy: join(sciezki.katalogDanych, 'tymczasowe'),
        maksBajtowPliku: k.maksRozmiarPlikuMb * 1024 * 1024,
        maksKolejkaTermicznej: k.maksKolejkaTermicznej,
      },
    })
    agent = a
    log.info('Konfiguracja wczytana', { stanowisko: k.stanowisko, serwer: new URL(k.serwer).origin, drukarki: k.drukarki }) // bez tokenu
    for (const w of ostrzezeniaKonfiguracji(k)) log.uwaga(w)

    await Promise.all([
      powtarzaj(async () => {
        const p = await a.cyklZlecen()
        if (p.pobrane > 0 || p.niewyslaneRaporty > 0) log.info('Cykl zleceń', { ...p })
      }, k.odpytywanieSekundy * 1000, pokolenie.signal),
      powtarzaj(async () => {
        if (!(await a.raportujStan())) return
        try {
          writeFileSync(join(sciezki.katalogDanych, PLIK_ZNACZNIKA_STANU), new Date().toISOString())
        } catch {
          // znacznik tylko dla instalatora — brak zapisu nie zatrzymuje agenta
        }
      }, k.stanSekundy * 1000, pokolenie.signal),
      powtarzaj(async () => {
        const n = await rejestr.sprzataj()
        if (n > 0) log.info(`Usunięto z rejestru ${n} wpisów starszych niż 7 dni`)
      }, 3600_000, pokolenie.signal),
    ])
    if (!stop.signal.aborted) log.info('Wczytuję nowe ustawienia')
  }
  await strona?.zamknij()
  if (strona && kodWyjscia !== KOD_RESTART) wyczyscAdres(sciezki.katalogDanych)
  zwolnij()
  process.exitCode = kodWyjscia
}

// Import z testów nie uruchamia programu.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: Error) => {
    // Błąd przed startem pętli (np. brak uprawnień do katalogu dane) — kod ≠ 0, start.ps1 spróbuje ponownie za 30 s.
    process.stderr.write(`Agent druku nie wystartował: ${e.stack ?? e.message}\n`)
    process.exitCode = KOD_AWARIA
  })
}
