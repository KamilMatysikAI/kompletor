// Harmonogram workera: zadania okresowe każdej aktywnej firmy z dedupeKey — nie piętrzą się,
// gdy worker nie nadąża. Rdzeń zawsze; import katalogu tylko, gdy instancja go włączy w env.
import { POLL_JOB } from '../cien/harmonogram'
import { dniSprzedazyZEnv } from '../import/okno-sprzedazy'
import { powiadomieniaZEnv } from '../powiadomienia/adres'
import { zapisKlientaZEnv } from '../klienci/kolejka'
import { EMPIK_AKCEPTACJA_JOB } from '../empik/nazwy'
import { FEED_JOB } from '../produkty/zdjecia-feed'
import { KURIER_AUTOMAT_JOB } from '../wysylka/kurier-regula'
import type { ScheduleEntry } from './petla'

/** Zadanie lustra stanów wFirmy: przebieg kolejki wywołań wFirmy z samym odczytem stanów. */
export const LUSTRO_WFIRMY_JOB = 'rdzen-wfirma'

/** zwroty klientów z kanałów (Allegro customer-returns), tylko odczyt. */
export const ZWROTY_KANALOW_JOB = 'zwroty-kanalow'

/** wysyłka faktur do KSeF (program „KSeF bezpośrednio”), statusy wysłanych i sprzątanie porzuconych prób. */
export const KSEF_WYSYLKA_JOB = 'ksef-wysylka'

/** Rdzeń stanów (spec 3.3, 4.4, 6.1, 5.4). */
export const HARMONOGRAM_RDZENIA: ScheduleEntry[] = [
  { kind: 'rdzen-fanout', everyMs: 5_000 },
  { kind: 'rdzen-przydzial', everyMs: 30_000 },
  { kind: 'rdzen-propagacja-cien', everyMs: 30_000 },
  // zapis statusów i numerów nadania do kanałów (nic nie wychodzi bez PRACA + `zapisWlaczony` konta)
  { kind: 'kanaly-zapis', everyMs: 30_000 },
  // wynik importów stanów, które kanał przetwarza później (Empik STO02/STO03); tylko odczyt, alert przy
  // odrzuceniach. Tylko firmy z aktywnym kontem Empik (dziś jedyny kanał z wynikiem importu).
  { kind: 'kanaly-importy-stanow', everyMs: 60_000, requires: 'empik' },
  // status w BL (np. „Kompletor”) dla zamówień wysłanych w Kompletorze; nic bez wyłącznika firmy
  // `statusBl` (domyślnie wyłączony) i tokena BL. Nazwa = STATUS_BL_JOB z lib/kanaly/status-bl.ts (bez importu: lekki moduł).
  { kind: 'kanaly-status-bl', everyMs: 5 * 60_000, requires: 'baselinker' },
  // śledzenie przesyłek (sam odczyt u przewoźnika, tylko moduły z shipment.track; przełącznik firmy)
  { kind: 'wysylka-sledzenie', everyMs: 15 * 60_000 },
  // zamawianie kuriera przez automat (konto przewoźnika „Zamawiaj kuriera automatycznie”, domyślnie wyłączone); firma
  // bez włączonego automatu = przebieg z samym odczytem reguł przewoźników, bez sieci
  { kind: KURIER_AUTOMAT_JOB, everyMs: 2 * 60_000 },
  { kind: 'rdzen-wygasanie', everyMs: 5 * 60_000 },
  { kind: 'rdzen-audyt', everyMs: 3600_000 },
  // nocna pełna synchronizacja kanałów i zlecenie pełnego odczytu wFirmy (handler działa tylko
  // w godzinie NIGHT_SYNC_HOUR), pełna synchronizacja konta po powrocie kanału (6.4)
  { kind: 'rdzen-noc', everyMs: 3600_000 },
  { kind: 'rdzen-kanaly-powrot', everyMs: 60_000 },
  // zwroty klientów zgłoszone w kanale (Allegro) → zwrot „Nowe” z zamówieniem; konta bez `returns.read` pomijane
  { kind: ZWROTY_KANALOW_JOB, everyMs: 15 * 60_000 },
  // faktury do KSeF; handler nic nie wysyła bez programu KSeF, „Wystawiaj faktury z Kompletora” i konta w PRACA,
  // a produkcja KSeF dodatkowo wymaga KSEF_PROD_ENABLED=1 i NIP-u firmy w KSEF_PROD_NIPS (lib/ksef/api/bramka.ts)
  { kind: KSEF_WYSYLKA_JOB, everyMs: 2 * 60_000 },
  // lustro stanów wFirmy w cieniu — kolejka wywołań wFirmy tylko z odczytem (odczyty celowane po fakturach
  // BL, pełny odczyt stronami). Wyłącznik CIEN_LUSTRO_WFIRMY (`lustroWfirmyZEnv`), egzekwowany też w handlerze.
  { kind: LUSTRO_WFIRMY_JOB, everyMs: 2 * 60_000 },
  // cień zamówień — planowanie odczytów kont (każde konto ma własny odstęp) i porównanie z BL
  { kind: 'cien-zamowienia-planuj', everyMs: 15_000 },
  // porównanie z BL to funkcja migracji z BL: firma bez tokena i inventory BL nie dostaje zadania
  { kind: 'cien-bl-porownanie', everyMs: 10 * 60_000, requires: 'baselinker' },
  // faktury BL w cieniu (spec 9.1: co ≤ 2 min), sprzedaż dnia kontra BL i raport rozjazdów (handler
  // zamyka dzień poprzedni po północy, inaczej nic), przegląd otwartych zamówień kontra kanał (raz na dobę)
  { kind: 'cien-bl-faktury', everyMs: 2 * 60_000, requires: 'baselinker' },
  // WZ z wFirmy — rozliczenie faktur, których cień nie rozliczył, i dokumenty do raportu (handler: lustro + klucze)
  { kind: 'cien-wz-wfirmy', everyMs: 30 * 60_000 },
  { kind: 'cien-sprzedaz-dnia', everyMs: 3600_000, requires: 'baselinker' },
  { kind: 'cien-raport-rozjazdow', everyMs: 3600_000, requires: 'baselinker' },
  { kind: 'cien-przeglad-otwartych', everyMs: 24 * 3600_000 },
  // zdjęcia z feedu produktowego, raz na dobę nocą (handler: okno 2–6 i jeden przebieg dziennie); tylko firmy z feedem
  { kind: FEED_JOB, everyMs: 3600_000, requires: 'feed' },
  // automatyczne akcje firmy (zdarzenia z dziennika zamówień; firma bez reguł = sam kursor) i reguły czasowe
  { kind: 'automaty-zdarzenia', everyMs: 30_000 },
  { kind: 'automaty-czas', everyMs: 15 * 60_000 },
  { kind: 'akcje-plan', everyMs: 5 * 60_000 }, // plan akcji z reguł (lib/akcje), bez wysyłki
  { kind: 'druk-sprzatanie', everyMs: 3600_000 }, // wygasanie zleceń druku i czyszczenie plików po 7 dniach
  { kind: 'zamowienia-masowo-sprzatanie', everyMs: 15 * 60_000 }, // akcje masowe bez ruchu > 1 h → przerwane, raporty po 30 dniach
  // alerty na Zulip; handler nic nie wysyła bez POWIADOMIENIA_WYSYLKA=1 i włącznika firmy
  { kind: 'powiadomienia-zulip', everyMs: 60_000 },
  // maile z planu akcji; handler nic nie wysyła bez POCZTA_WYSYLKA=1, włącznika firmy i konta w PRACA
  { kind: 'poczta-wysylka', everyMs: 60_000 },
  // linki resetu hasła firmy — szyfrogram tokenu z wygasłych, wpisy starsze niż doba
  { kind: 'poczta-reset-sprzatanie', everyMs: 24 * 3600_000 },
  // raporty o niedoręczeniu ze skrzynki nadawcy (IMAP); firma bez włączonego czytnika = przebieg bez połączenia
  { kind: 'poczta-odbicia', everyMs: 5 * 60_000 },
  // retencja danych klientów (lib/klienci/retencja.ts): przeliczenie terminów i licznik, usuwanie tylko w trybie USUWAJ
  { kind: 'klienci-retencja', everyMs: 24 * 3600_000 },
  { kind: 'mcp-sprzatanie', everyMs: 24 * 3600_000 }, // dziennik wywołań MCP — wpisy starsze niż 90 dni
  // przyjmowanie zamówień Empiku (OR21); konto w cieniu tylko zapisuje „zaakceptowałbym”, alert po X godzinach
  { kind: EMPIK_AKCEPTACJA_JOB, everyMs: 60_000, requires: 'empik' },
  // kursy średnie NBP (tabela A) do informacyjnego przeliczenia sum sprzedaży w obcych walutach; pierwszy
  // przebieg zaraz po starcie workera, potem raz na dobę. Nazwa = KURSY_WALUT_JOB z lib/kursy/nbp.ts.
  { kind: 'kursy-walut', everyMs: 6 * 3600_000 },
]

const MIN_GODZIN = 1

/** Rodzaje zadań cienia zamówień, które czytają zamówienia (dane osobowe) z kanałów i z BL. */
export const ZADANIA_CIENIA: readonly string[] = [
  'cien-zamowienia-planuj',
  POLL_JOB,
  'cien-bl-porownanie',
  'cien-bl-faktury',
  'cien-wz-wfirmy',
  'cien-sprzedaz-dnia',
  'cien-raport-rozjazdow',
  'cien-przeglad-otwartych',
]

/**
 * `CIEN_ODCZYT`: `1` albo puste = cień włączony (domyślnie, zgodność z self-hostem), `0` = worker nie
 * planuje odczytu zamówień ani porównania z BL, a zadania cienia już w kolejce kończą się bez odczytu. Na serwerze
 * włączamy świadomie, gdy właściciel ma konto w panelu. Zła wartość = błąd na starcie, nie po cichu.
 */
export function cienOdczytZEnv(env: Record<string, string | undefined>): boolean {
  const v = (env.CIEN_ODCZYT ?? '').trim()
  if (v === '' || v === '1') return true
  if (v === '0') return false
  throw new Error('CIEN_ODCZYT: 1 (włączony), 0 (wyłączony) albo puste')
}

/**
 * `CIEN_LUSTRO_WFIRMY`: `1` = lustro stanów wFirmy włączone, `0` = wyłączone (zero wywołań wFirmy z kolejki),
 * puste = tak jak cień (`CIEN_ODCZYT`). Lustro czyta tylko stany towarów (`goods/find`), bez danych klientów, ale
 * tym samym kluczem API, którym BL wystawia faktury — stąd osobny wyłącznik. Zła wartość = błąd, nie po cichu.
 */
export function lustroWfirmyZEnv(env: Record<string, string | undefined>): boolean {
  const v = (env.CIEN_LUSTRO_WFIRMY ?? '').trim()
  if (v === '') return cienOdczytZEnv(env)
  if (v === '1') return true
  if (v === '0') return false
  throw new Error('CIEN_LUSTRO_WFIRMY: 1 (włączone), 0 (wyłączone) albo puste (jak CIEN_ODCZYT)')
}

/**
 * `KATALOG_IMPORT_CO_GODZIN` (≥ 1; puste/0 = wyłączone) — import katalogu (tylko odczyt źródeł) co N godzin,
 * pierwszy zaraz po starcie workera. `KATALOG_IMPORT_DNI_SPRZEDAZY` (domyślnie 0 = bez odczytu zamówień BL,
 * czyli bez danych klientów) — okno sprzedaży do raportu mapowania. `CIEN_ODCZYT=0` zdejmuje zadania cienia
 * (`cienOdczytZEnv`), `CIEN_LUSTRO_WFIRMY=0` zdejmuje lustro stanów wFirmy (`lustroWfirmyZEnv`). Zła wartość = błąd na starcie, nie po cichu.
 */
export function harmonogramZEnv(env: Record<string, string | undefined>): ScheduleEntry[] {
  const cien = cienOdczytZEnv(env)
  const lustro = lustroWfirmyZEnv(env)
  const out = HARMONOGRAM_RDZENIA.filter((h) => (cien || !ZADANIA_CIENIA.includes(h.kind)) && (lustro || h.kind !== LUSTRO_WFIRMY_JOB))
  powiadomieniaZEnv(env) // zła wartość POWIADOMIENIA_WYSYLKA, ZULIP_DOZWOLONE_HOSTY, APP_PUBLIC_URL = błąd na starcie
  zapisKlientaZEnv(env) // zła wartość DANE_KLIENTA_ZAPIS = błąd na starcie (rdzeń traktuje ją jak wyłączone)
  const coGodzin = (env.KATALOG_IMPORT_CO_GODZIN ?? '').trim()
  if (coGodzin && coGodzin !== '0') {
    const h = Number(coGodzin)
    if (!Number.isFinite(h) || h < MIN_GODZIN) throw new Error(`KATALOG_IMPORT_CO_GODZIN: liczba godzin ≥ ${MIN_GODZIN} albo puste`)
    // Ta sama wartość jest sufitem w handlerze import-katalogu (lib/import/okno-sprzedazy.ts).
    const dni = dniSprzedazyZEnv(env)
    out.push({ kind: 'import-katalogu', everyMs: Math.round(h * 3600_000), payload: { salesDays: dni } })
  }
  return out
}
