// okres porównania raportu sprzedaży. Czyste funkcje (bez bazy), wspólne dla ekranu „Raporty”, eksportu
// XLSX, GET /api/v1/raporty/sprzedaz i narzędzia MCP `raport_sprzedazy`. Tryby (biała lista, parametr `porownaj`):
//  - poprzedni: tyle samo dni tuż przed zakresem (domyślnie, zachowanie);
//  - rok: te same daty rok wcześniej (29.02 → 28.02; zakres kończący się ostatnim dniem miesiąca kończy się ostatnim
//    dniem tego miesiąca rok wcześniej, więc luty do lutego jest zawsze całym lutym);
//  - miesiac: te same dni miesiąc wcześniej, tylko gdy zakres mieści się w jednym miesiącu (cały październik → cały
//    wrzesień, 1–25.11 → 1–25.10);
//  - tydzien: te same dni tygodnia tydzień wcześniej, tylko gdy zakres mieści się w jednym tygodniu (pon.–niedz.);
//  - wlasny: dowolny zakres `porownaj_od`–`porownaj_do` (najwyżej 366 dni, może mieć inną liczbę dni);
//  - brak: bez porównania.
import { addDays, type IsoDay } from '@/lib/rdzen/kalendarz'
import { ApiInputError } from './odpowiedzi'

export type TrybPorownania = 'poprzedni' | 'rok' | 'miesiac' | 'tydzien' | 'wlasny' | 'brak'
export const TRYBY_POROWNANIA: readonly TrybPorownania[] = ['poprzedni', 'rok', 'miesiac', 'tydzien', 'wlasny', 'brak']
export const POROWNANIE_MAKS_DNI = 366

/** Opis trybu do zdania „Porównanie z: …” (ekran, XLSX). */
export const OPIS_TRYBU: Record<TrybPorownania, string> = {
  poprzedni: 'tyle samo dni tuż przed',
  rok: 'ten sam okres rok wcześniej',
  miesiac: 'te same dni miesiąc wcześniej',
  tydzien: 'te same dni tydzień wcześniej',
  wlasny: 'własny zakres',
  brak: 'bez porównania',
}

const DZIEN_RE = /^\d{4}-\d{2}-\d{2}$/

export function poprawnyDzien(d: string): boolean {
  if (!DZIEN_RE.test(d)) return false
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}

function dniMiedzy(od: IsoDay, doDnia: IsoDay): number {
  return Math.round((Date.parse(`${doDnia}T00:00:00Z`) - Date.parse(`${od}T00:00:00Z`)) / 86_400_000) + 1
}

function dniWMiesiacu(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * Dzień przesunięty o `n` miesięcy: ten sam dzień miesiąca, przycięty do długości miesiąca docelowego. Z `koniec`
 * ostatni dzień miesiąca zostaje ostatnim dniem (28.02.2025 → 29.02.2024 przy n = −12).
 */
export function przesunMiesiace(d: IsoDay, n: number, koniec = false): IsoDay {
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(5, 7))
  const dzien = Number(d.slice(8, 10))
  const t = y * 12 + (m - 1) + n
  const ny = Math.floor(t / 12)
  const nm = (t % 12) + 1
  const dl = dniWMiesiacu(ny, nm)
  const nd = koniec && dzien === dniWMiesiacu(y, m) ? dl : Math.min(dzien, dl)
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`
}

function poniedzialek(d: IsoDay): IsoDay {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
  return addDays(d, -((dow + 6) % 7))
}

/** Czy tryb da się zastosować do zakresu (miesiąc i tydzień tylko dla zakresu w jednym miesiącu albo tygodniu). */
export function trybPasuje(od: IsoDay, doDnia: IsoDay, tryb: TrybPorownania): boolean {
  if (tryb === 'miesiac') return od.slice(0, 7) === doDnia.slice(0, 7)
  if (tryb === 'tydzien') return poniedzialek(od) === poniedzialek(doDnia)
  return true
}

export interface WyborPorownania {
  porownaj: TrybPorownania
  /** tylko dla `wlasny` (inaczej null) */
  porownajOd: IsoDay | null
  porownajDo: IsoDay | null
}

/** Walidacja wyboru (biała lista trybów); daty własnego zakresu sprawdza `zakresPorownania`. */
export function zapytaniePorownania(v: { porownaj?: string | null; porownajOd?: string | null; porownajDo?: string | null }): WyborPorownania {
  const t = v.porownaj === null || v.porownaj === undefined || v.porownaj === '' ? 'poprzedni' : v.porownaj
  if (!(TRYBY_POROWNANIA as readonly string[]).includes(t)) throw new ApiInputError(`porownaj: ${TRYBY_POROWNANIA.join(', ')}`, 'porownaj')
  const porownaj = t as TrybPorownania
  if (porownaj !== 'wlasny') return { porownaj, porownajOd: null, porownajDo: null }
  return { porownaj, porownajOd: v.porownajOd || null, porownajDo: v.porownajDo || null }
}

/** Zakres porównania dla zakresu raportu; null = bez porównania. Błąd (tryb nie pasuje, zły własny zakres) z polem. */
export function zakresPorownania(v: { od: IsoDay; do: IsoDay; tryb: TrybPorownania; wlasnyOd?: string | null; wlasnyDo?: string | null }): { od: IsoDay; do: IsoDay } | null {
  const { od, do: doDnia, tryb } = v
  // koniec miesiąca zostaje końcem miesiąca tylko dla zakresu od 1. dnia (cały luty do całego lutego); zakres od środka
  // miesiąca przesuwa się dzień w dzień, żeby 1 dzień nie porównywał się z 2 (przegląd r1)
  const odPierwszego = od.slice(8) === '01'
  switch (tryb) {
    case 'brak':
      return null
    case 'poprzedni': {
      const dni = dniMiedzy(od, doDnia)
      return { od: addDays(od, -dni), do: addDays(od, -1) }
    }
    case 'rok':
      return { od: przesunMiesiace(od, -12), do: przesunMiesiace(doDnia, -12, odPierwszego) }
    case 'miesiac':
      if (!trybPasuje(od, doDnia, 'miesiac')) throw new ApiInputError('porownaj: „miesiąc wcześniej” tylko dla zakresu w jednym miesiącu', 'porownaj')
      return { od: przesunMiesiace(od, -1), do: przesunMiesiace(doDnia, -1, odPierwszego) }
    case 'tydzien':
      if (!trybPasuje(od, doDnia, 'tydzien')) throw new ApiInputError('porownaj: „tydzień wcześniej” tylko dla zakresu w jednym tygodniu (od poniedziałku do niedzieli)', 'porownaj')
      return { od: addDays(od, -7), do: addDays(doDnia, -7) }
    case 'wlasny': {
      const a = v.wlasnyOd ?? ''
      const b = v.wlasnyDo ?? ''
      if (!poprawnyDzien(a)) throw new ApiInputError('porownaj_od: data RRRR-MM-DD', 'porownaj_od')
      if (!poprawnyDzien(b)) throw new ApiInputError('porownaj_do: data RRRR-MM-DD', 'porownaj_do')
      if (b < a) throw new ApiInputError('porownaj_do: koniec porównania przed jego początkiem', 'porownaj_do')
      if (dniMiedzy(a, b) > POROWNANIE_MAKS_DNI) throw new ApiInputError(`porownaj_od: porównanie najwyżej ${POROWNANIE_MAKS_DNI} dni`, 'porownaj_od')
      return { od: a, do: b }
    }
  }
}

/**
 * Klucz okresu porównania przy każdym wierszu okresów raportu. Rok wcześniej po dniach i miesiącach: ta sama data
 * (29.02 bez pary); pozostałe: kolejno (pierwszy z pierwszym), wiersze ponad długość porównania bez pary.
 */
export function kluczePorownania(teraz: readonly IsoDay[], porownanie: readonly IsoDay[], tryb: TrybPorownania, grupuj: 'dzien' | 'tydzien' | 'miesiac'): (IsoDay | null)[] {
  if (tryb === 'rok' && grupuj !== 'tydzien') {
    const jest = new Set(porownanie)
    return teraz.map((k) => {
      const p = przesunMiesiace(k, -12)
      return p.slice(8) === k.slice(8) && jest.has(p) ? p : null
    })
  }
  return teraz.map((_, i) => porownanie[i] ?? null)
}

/** Krótki opis zakresu: „1–13.10”, „28.09–4.10”, z rokiem, gdy inny niż `rokRaportu` albo zakres przechodzi przez Nowy Rok. */
export function opisZakresu(od: IsoDay, doDnia: IsoDay, rokRaportu: string): string {
  const dz = (d: IsoDay) => String(Number(d.slice(8, 10)))
  const dm = (d: IsoDay) => `${dz(d)}.${d.slice(5, 7)}`
  const zRokiem = od.slice(0, 4) !== rokRaportu || doDnia.slice(0, 4) !== rokRaportu
  const rok = (d: IsoDay) => (zRokiem ? `.${d.slice(0, 4)}` : '')
  if (od === doDnia) return `${dm(od)}${rok(od)}`
  if (od.slice(0, 4) !== doDnia.slice(0, 4)) return `${dm(od)}.${od.slice(0, 4)}–${dm(doDnia)}.${doDnia.slice(0, 4)}`
  if (od.slice(0, 7) === doDnia.slice(0, 7)) return `${dz(od)}–${dm(doDnia)}${rok(doDnia)}`
  return `${dm(od)}–${dm(doDnia)}${rok(doDnia)}`
}

function dataPl(d: IsoDay): string {
  return `${Number(d.slice(8, 10))}.${d.slice(5, 7)}.${d.slice(0, 4)}`
}

/**
 * Zdanie o porównaniu sprzed początku danych (ekran i XLSX); null = porównanie pełne. Przy niepełnym porównaniu
 * zmiany w procentach się nie pokazują, bo zaniżona baza dałaby fałszywy wzrost.
 */
export function uwagaPorownania(p: { od: IsoDay; poczatekDanych: IsoDay | null; kontaBezDanych: readonly { nazwa: string; daneOd: IsoDay }[]; bezDanych: boolean }): string | null {
  if (p.bezDanych)
    return p.poczatekDanych
      ? `Brak danych za okres porównania: dane w Kompletorze (z archiwum) zaczynają się ${dataPl(p.poczatekDanych)}. Wybierz późniejszy okres porównania.`
      : 'Brak danych za okres porównania.'
  if (!p.kontaBezDanych.length) return null
  const lista = p.kontaBezDanych.slice(0, 4).map((k) => `${k.nazwa} od ${dataPl(k.daneOd)}`)
  const reszta = p.kontaBezDanych.length - lista.length
  return `Porównanie niepełne: Kompletor ma dane ${p.kontaBezDanych.length === 1 ? 'konta' : 'kont'} ${lista.join(', ')}${reszta > 0 ? ` i ${reszta} innych` : ''}, a porównanie zaczyna się ${dataPl(p.od)}. Zmiany w procentach pomijamy, żeby nie pokazywać fałszywego wzrostu.`
}

/** Porównanie, przy którym nie pokazujemy zmiany w procentach (brak danych albo dane niepełne). */
export function porownanieNiepelne(p: { kontaBezDanych: readonly unknown[]; bezDanych: boolean }): boolean {
  return p.bezDanych || p.kontaBezDanych.length > 0
}
