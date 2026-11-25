// sumy sprzedaży z zamówień w różnych walutach. `Order` nie ma waluty (kwoty to gołe liczby), a waluta
// zamówienia leży w kopii z kanału (`ChannelOrderSnapshot.currency`, lib/rdzen/waluta.ts). Zasada dla każdego ekranu,
// eksportu i API z sumą kwot zamówień: suma w złotych = zamówienia w PLN + zamówienia w innych walutach przeliczone po
// ostatnim znanym kursie średnim NBP (jeden kurs na walutę dla całego okresu; wartość informacyjna, nie księgowa; kursy
// pobiera worker, lib/kursy/nbp.ts). Waluta bez kursu nie wchodzi do sumy i jest pokazana osobno („+ 957,00 CZK”),
// nigdy 1:1. Liczba zamówień obejmuje każdą walutę. Zapytania podają wiersze (waluta, grosze, liczba zamówień), a ta
// jedna funkcja je sumuje; bez obcych walut wynik i tekst są te same co przed zmianą.
import { money } from './format'

export const WALUTA_PLN = 'PLN'
/** Dyskretny znacznik kwoty, w której jest przeliczenie kursem. */
export const ZNAK_PRZELICZENIA = '≈'

/** Kursy średnie NBP: dzień notowania, numer tabeli, PLN za 1 jednostkę waluty. */
export interface KursyWalut {
  /** dzień notowania RRRR-MM-DD */
  data: string
  tabela: string
  kursy: Record<string, number>
}

/** Kwota zamówień w jednej walucie innej niż PLN. */
export interface ObcaKwota {
  waluta: string
  /** kwota w setnych częściach waluty (grosze, halerze, centy) */
  grosze: number
  zamowien: number
  /** kurs średni NBP użyty do przeliczenia (PLN za 1 jednostkę); null = brak kursu, kwota poza sumą w złotych */
  kurs: number | null
  /** dzień notowania kursu RRRR-MM-DD; null = brak kursu */
  dataKursu: string | null
  /** kwota po przeliczeniu w groszach PLN (zaokrąglona do grosza); null = brak kursu */
  groszePln: number | null
}

export interface SumaWalut {
  /** wszystkie zamówienia (każda waluta) */
  zamowien: number
  /** zamówienia, których kwota jest w `grosze` (PLN i przeliczone), do średniej */
  zamowienWSumie: number
  /** zamówienia w PLN plus przeliczone obce waluty, w groszach */
  grosze: number
  /** pozostałe waluty, posortowane po kodzie */
  obce: ObcaKwota[]
}

export interface WierszWaluty {
  /** kod waluty z kopii kanału; brak = PLN */
  waluta?: string | null
  /** kwota w setnych częściach waluty */
  grosze: number
  /** liczba zamówień w wierszu (domyślnie 0: wiersz samych kwot, np. pozycji) */
  zamowien?: number
}

/** Kod waluty: wielkie litery bez spacji, brak = PLN (jak `normalizujWalute` w lib/rdzen/waluta.ts). */
export function kodWaluty(w: string | null | undefined): string {
  return (w ?? '').trim().toUpperCase() || WALUTA_PLN
}

/** Kwota z bazy (tekst Decimal, liczba, null) w groszach, bez błędów zaokrągleń przy dodawaniu. */
export function naGrosze(v: string | number | null | undefined): number {
  return v === null || v === undefined ? 0 : Math.round(Number(v) * 100)
}

/** Kurs waluty z tabeli (dodatni i skończony), inaczej null. */
export function kursWaluty(kursy: KursyWalut | null | undefined, waluta: string): number | null {
  const k = kursy?.kursy[kodWaluty(waluta)]
  return typeof k === 'number' && Number.isFinite(k) && k > 0 ? k : null
}

/** Grosze waluty × kurs → grosze PLN, do pełnego grosza (połówka w górę; bez śmieci zmiennoprzecinkowych). */
export function przeliczGrosze(grosze: number, kurs: number): number {
  return Math.round(Number((grosze * kurs).toFixed(6)))
}

/** Sumuje wiersze: PLN wprost, obce waluty po kursie (bez kursu: osobno, poza sumą). Jedna funkcja dla pulpitu, raportów i API. */
export function sumaWalut(wiersze: Iterable<WierszWaluty>, kursy?: KursyWalut | null): SumaWalut {
  let zamowien = 0
  let zamowienWSumie = 0
  let grosze = 0
  const obce = new Map<string, { waluta: string; grosze: number; zamowien: number }>()
  for (const w of wiersze) {
    const n = w.zamowien ?? 0
    zamowien += n
    const kod = kodWaluty(w.waluta)
    if (kod === WALUTA_PLN) {
      zamowienWSumie += n
      grosze += w.grosze
      continue
    }
    const o = obce.get(kod) ?? { waluta: kod, grosze: 0, zamowien: 0 }
    o.grosze += w.grosze
    o.zamowien += n
    obce.set(kod, o)
  }
  const lista: ObcaKwota[] = [...obce.values()]
    .sort((a, b) => a.waluta.localeCompare(b.waluta))
    .map((o) => {
      const kurs = kursWaluty(kursy, o.waluta)
      if (kurs === null) return { ...o, kurs: null, dataKursu: null, groszePln: null }
      const groszePln = przeliczGrosze(o.grosze, kurs)
      grosze += groszePln
      zamowienWSumie += o.zamowien
      return { ...o, kurs, dataKursu: kursy!.data, groszePln }
    })
  return { zamowien, zamowienWSumie, grosze, obce: lista }
}

/** Waluta w odpowiedzi API i eksporcie: kwota w walucie, użyty kurs i jego data, kwota w złotych (null = brak kursu). */
export interface WalutaApi {
  waluta: string
  zamowien: number
  /** wartość brutto w walucie zamówień */
  brutto: number
  kurs: number | null
  dataKursu: string | null
  /** wartość brutto po przeliczeniu na złote (wliczona do pól kwot w złotych); null = brak kursu, poza sumą */
  bruttoPln: number | null
}

export function obceDoApi(obce: readonly ObcaKwota[]): WalutaApi[] {
  return obce.map((o) => ({ waluta: o.waluta, zamowien: o.zamowien, brutto: o.grosze / 100, kurs: o.kurs, dataKursu: o.dataKursu, bruttoPln: o.groszePln === null ? null : o.groszePln / 100 }))
}

/** Odwrotność `obceDoApi` (raport sprzedaży podaje kwoty w jednostkach waluty) do formatowania na ekranie. */
export function obceZApi(inne: readonly Partial<WalutaApi>[] | undefined): ObcaKwota[] {
  return (inne ?? []).map((x) => ({
    waluta: x.waluta ?? '',
    grosze: naGrosze(x.brutto),
    zamowien: x.zamowien ?? 0,
    kurs: x.kurs ?? null,
    dataKursu: x.dataKursu ?? null,
    groszePln: x.bruttoPln === null || x.bruttoPln === undefined ? null : naGrosze(x.bruttoPln),
  }))
}

type Obca = Pick<ObcaKwota, 'waluta' | 'grosze'> & Partial<Pick<ObcaKwota, 'kurs' | 'dataKursu'>>

const maKurs = (o: Obca) => typeof o.kurs === 'number'

/** Czy w sumie jest przeliczenie kursem (znacznik „≈” i objaśnienie). */
export function jestPrzeliczenie(obce: readonly Obca[] | undefined): boolean {
  return !!obce?.some(maKurs)
}

/** Waluty bez kursu, poza sumą: „957,00 CZK + 12,50 EUR”; pusty tekst, gdy takich nie ma. */
export function opisBezKursu(obce: readonly Obca[] | undefined): string {
  return (obce ?? [])
    .filter((o) => !maKurs(o))
    .map((o) => money(o.grosze / 100, o.waluta))
    .join(' + ')
}

/**
 * Kwota sumy w złotych: „≈ 1 339,19 zł”, gdy wliczono przeliczenie, z dopiskiem walut bez kursu („… zł + 957,00 CZK”).
 * Bez obcych walut dokładnie `money(zl)`, więc ekran bez takich zamówień wygląda jak przed zmianą.
 */
export function kwotaZObcymi(zl: number | null | undefined, obce: readonly Obca[] | undefined): string {
  if (!obce?.length) return money(zl)
  const bez = opisBezKursu(obce)
  return `${jestPrzeliczenie(obce) ? `${ZNAK_PRZELICZENIA} ` : ''}${money(zl ?? 0)}${bez ? ` + ${bez}` : ''}`
}

/** Kurs do tekstu: „0,1712” (4–6 miejsc jak w tabeli NBP). */
export function formatKursu(k: number): string {
  return k.toLocaleString('pl-PL', { minimumFractionDigits: 4, maximumFractionDigits: 6, useGrouping: false })
}

/** „2026-11-21” → „21.11”. */
export function dzienKursu(d: string): string {
  return `${d.slice(8, 10)}.${d.slice(5, 7)}`
}

/**
 * Jedno zdanie objaśnienia pod sumą, tylko gdy w sumie są obce waluty; pusty tekst bez nich. Przeliczenie: „W sumie są
 * zamówienia w innych walutach przeliczone na złote po kursie średnim NBP z 21.11 (CZK 0,1712); to wartość informacyjna.”
 * Waluty bez kursu: zdanie, że są podane osobno i nie wchodzą do sumy.
 */
export function notkaWalut(obce: readonly Obca[] | undefined): string {
  const z = (obce ?? []).filter(maKurs)
  const bez = (obce ?? []).filter((o) => !maKurs(o))
  const out: string[] = []
  if (z.length) {
    const daty = [...new Set(z.map((o) => o.dataKursu ?? ''))]
    const kursy =
      daty.length === 1
        ? `z ${dzienKursu(daty[0] ?? '')} (${z.map((o) => `${o.waluta} ${formatKursu(o.kurs!)}`).join(', ')})`
        : `(${z.map((o) => `${o.waluta} ${formatKursu(o.kurs!)} z ${dzienKursu(o.dataKursu ?? '')}`).join(', ')})`
    out.push(`W sumie są zamówienia w innych walutach przeliczone na złote po kursie średnim NBP ${kursy}; to wartość informacyjna.`)
  }
  if (bez.length) out.push(`Brak kursu NBP dla ${[...new Set(bez.map((o) => o.waluta))].join(', ')}: te kwoty są podane osobno i nie wchodzą do sumy w złotych.`)
  return out.join(' ')
}

/**
 * Rozbicie do eksportu (jedna komórka tekstu): „957,00 CZK × 0,1712 (21.11) = 163,84 zł”, waluta bez kursu „12,00 XYZ
 * (brak kursu, poza sumą)”; kilka walut po „; ”. Pusty tekst bez obcych walut.
 */
export function opisWalut(obce: readonly Obca[] | undefined): string {
  return (obce ?? [])
    .map((o) =>
      maKurs(o)
        ? `${money(o.grosze / 100, o.waluta)} × ${formatKursu(o.kurs!)} (${dzienKursu(o.dataKursu ?? '')}) = ${money(przeliczGrosze(o.grosze, o.kurs!) / 100)}`
        : `${money(o.grosze / 100, o.waluta)} (brak kursu, poza sumą)`,
    )
    .join('; ')
}
