// Oś statusów przesyłki: jeden słownik dla wszystkich przewoźników (InPost, DPD, Wysyłam z Allegro, Poczta Polska;
// mapowanie kodów każdego z nich leży przy jego module w lib/adaptery). Tu: lista stanów, polskie opisy, stany
// końcowe, odstępy odpytywania zależne od stanu i odczyt czasu zdarzenia u przewoźnika. Czyste funkcje, bez bazy.
//
// Stan na osi nie zastępuje `StanPrzesylki` z kontraktu (czy paczka pojechała, z niego magazyn przenosi zamówienie do
// „Wysłane”); to druga, dokładniejsza informacja o drodze paczki do historii, widoku i późniejszych reguł firmy.
import type { StanDrogi, StanPrzesylki } from '../adaptery/kontrakt'

export type { StanDrogi }

export const STANY_DROGI: readonly StanDrogi[] = [
  'UTWORZONA',
  'PRZEKAZANA',
  'W_DRODZE',
  'W_DORECZENIU',
  'W_PUNKCIE',
  'DORECZONA',
  'NIEUDANE_DORECZENIE',
  'ZWROT',
  'PROBLEM',
  'ANULOWANA',
  'NIEZNANY',
]

/** Opisy dla ludzi (historia przesyłki, karta, lista). */
export const OPIS_STANU_DROGI: Record<StanDrogi, string> = {
  UTWORZONA: 'Utworzona, czeka na kuriera',
  PRZEKAZANA: 'Przekazana przewoźnikowi',
  W_DRODZE: 'W drodze',
  W_DORECZENIU: 'Wydana do doręczenia',
  W_PUNKCIE: 'Czeka na odbiór w punkcie',
  DORECZONA: 'Doręczona',
  NIEUDANE_DORECZENIE: 'Nieudane doręczenie (awizo)',
  ZWROT: 'Zwrot do nadawcy',
  PROBLEM: 'Problem z przesyłką',
  ANULOWANA: 'Anulowana u przewoźnika',
  NIEZNANY: 'Stan nieznany',
}

const KONCOWE: ReadonlySet<StanDrogi> = new Set(['DORECZONA', 'ZWROT', 'ANULOWANA'])
const PRZED_PRZEKAZANIEM: ReadonlySet<StanDrogi> = new Set(['UTWORZONA', 'ANULOWANA', 'NIEZNANY'])

/** Stan końcowy: przesyłka po nim nie jest już pytana. */
export const jestKoncowy = (s: StanDrogi): boolean => KONCOWE.has(s)

/** Paczka jest (albo była) u przewoźnika: od tego stanu liczy się data przekazania. */
export const poPrzekazaniu = (s: StanDrogi): boolean => !PRZED_PRZEKAZANIEM.has(s)

/** Najdłużej tyle dni od utworzenia przesyłki pytamy o nią po „Wysłane” (paczka, która nie doszła przez miesiąc, to sprawa dla biura). */
export const SLEDZENIE_DO_KONCA_DNI = 30

const MIN = 60_000
const GODZ = 60 * MIN
/**
 * Odstęp do następnego odczytu wg stanu (null = stan końcowy). Przed odbiorem i przy nieznanym stanie częściej (pierwszy
 * odczyt rozstrzyga „Wysłane”), w doręczeniu co godzinę (doręczenie w ciągu dnia), w drodze i po nieudanym doręczeniu
 * co 3 h, w punkcie i przy problemie co 6 h (paczka leży dniami). Przy ok. 1 000 paczek w drodze w grudniu to ok.
 * 300 odczytów na godzinę na wszystkie konta.
 */
const ODSTEP: Record<StanDrogi, number | null> = {
  UTWORZONA: 30 * MIN,
  PRZEKAZANA: 3 * GODZ,
  W_DRODZE: 3 * GODZ,
  W_DORECZENIU: GODZ,
  W_PUNKCIE: 6 * GODZ,
  NIEUDANE_DORECZENIE: 3 * GODZ,
  PROBLEM: 6 * GODZ,
  NIEZNANY: 2 * GODZ,
  DORECZONA: null,
  ZWROT: null,
  ANULOWANA: null,
}

export function odstepSledzenia(s: StanDrogi | null): number | null {
  return s === null ? ODSTEP.UTWORZONA : ODSTEP[s]
}

/** Stan na osi z dawnego kontraktu, gdy moduł przewoźnika nie podaje osi. */
export function stanDrogiZeStanu(stan: StanPrzesylki): StanDrogi {
  if (stan === 'PRZED_NADANIEM') return 'UTWORZONA'
  return stan
}

const ISO_ZE_STREFA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/
const BEZ_STREFY = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,6})?$/
const NAJWCZESNIEJ = Date.UTC(2000, 0, 1)
/** Czas z przyszłości dopuszczamy z tym zapasem (rozjazd zegarów); dalej = zły czas, liczy się chwila odczytu. */
const ZAPAS_PRZYSZLOSCI = GODZ

/** Przesunięcie strefy Europe/Warsaw (ms) w danej chwili UTC. */
function przesuniecieWarszawy(utc: number): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utc))
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value)
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(utc / 1000) * 1000
}

/**
 * Czas zdarzenia u przewoźnika: ISO ze strefą wprost, bez strefy jako czas polski (DPD, Poczta). Pusty, nieczytelny,
 * sprzed 2000 r. albo z przyszłości (ponad godzinę) = null (wtedy liczy się chwila odczytu).
 */
export function czasPrzewoznika(s: string | null | undefined, now: Date): Date | null {
  if (!s) return null
  const t = s.trim()
  let ms: number
  if (ISO_ZE_STREFA.test(t)) {
    ms = Date.parse(t)
  } else {
    const m = BEZ_STREFY.exec(t)
    if (!m) return null
    const [r, mc, d, g, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number]
    if (mc < 1 || mc > 12 || d < 1 || d > 31 || g > 23 || mi > 59 || se > 59) return null
    const lokalny = Date.UTC(r, mc - 1, d, g, mi, se)
    if (new Date(lokalny).getUTCDate() !== d) return null
    // dwa przybliżenia: przesunięcie z chwili po pierwszym przeliczeniu (zmiana czasu w nocy)
    const pierwsze = lokalny - przesuniecieWarszawy(lokalny)
    ms = lokalny - przesuniecieWarszawy(pierwsze)
  }
  if (!Number.isFinite(ms) || ms < NAJWCZESNIEJ || ms > now.getTime() + ZAPAS_PRZYSZLOSCI) return null
  return new Date(ms)
}
