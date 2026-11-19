// tryb sekcji karty zamówienia (odczyt albo edycja) i podsumowanie pozycji netto / VAT / brutto.
// Edycja sekcji jest w adresie (`?edytuj=pozycje`, `?edytuj=klient`), więc działa bez JavaScriptu; akcje zapisu kończą
// się przekierowaniem na kartę bez tego parametru, czyli zapis wraca do odczytu. Czyste funkcje, bez bazy.
import { grosze, normalizujStawke } from '@/lib/rdzen/edycja'
import { nettoGr } from '@/lib/dokumenty/pozycje'
import { wartoscCzesciGr } from '@/lib/rdzen/zamiana'

// kupujacy i faktura: dane zamówienia z kanału w kartach „Wysyłka” i „Dane do faktury” (lib/klienci/edycja-danych.ts)
export const SEKCJE_EDYCJI = ['pozycje', 'klient', 'kupujacy', 'faktura'] as const
export type SekcjaEdycji = (typeof SEKCJE_EDYCJI)[number]

/** Sekcja w trybie edycji z parametru adresu; nieznana wartość = odczyt. */
export function sekcjaEdycji(v: string | string[] | undefined): SekcjaEdycji | null {
  return typeof v === 'string' && (SEKCJE_EDYCJI as readonly string[]).includes(v) ? (v as SekcjaEdycji) : null
}

/** Kotwica sekcji karty, w której stoi formularz edycji. */
const KOTWICA_EDYCJI: Record<SekcjaEdycji, string> = { pozycje: 'pozycje', klient: 'klient', kupujacy: 'wysylka', faktura: 'dane-faktury' }

/** Adres karty z sekcją w trybie edycji (kotwica = sekcja, żeby przeglądarka została przy niej). */
export function adresEdycji(orderId: string, sekcja: SekcjaEdycji): string {
  return `/zamowienia/${orderId}?edytuj=${sekcja}#${KOTWICA_EDYCJI[sekcja]}`
}

/** Adres karty w trybie odczytu, przewinięty do sekcji. */
export function adresOdczytu(orderId: string, kotwica: string): string {
  return `/zamowienia/${orderId}#${kotwica}`
}

export interface LiniaPodsumowania {
  unitPriceGross: { toString(): string } | number
  qty: number
  qtyRejected: number
  /** Ile jednostek bazowych to sztuka oferty (cena jest za sztukę oferty); 1 bez oferty. */
  naOferte: number
  /** część rodziny zamian — jednostki bazowe części wcześniejszych (brak = 0). */
  przesuniecie?: number
  /** Stawka z pozycji, a gdy jej nie ma, z katalogu; null = nieznana (np. zestaw ze składnikami o różnych stawkach). */
  stawka: string | null
}

export interface Podsumowanie {
  bruttoGr: number
  /** null, gdy choć jedna pozycja nie ma znanej stawki VAT (nie zgadujemy). */
  nettoGr: number | null
  vatGr: number | null
  bezStawki: number
}

/**
 * Netto, VAT i brutto pozycji (bez wysyłki), w groszach. Brutto liczone tak samo jak `sumaPozycjiGr` karty
 * (`(qty − qtyRejected) / naOferte × cena`). Netto jak na dokumencie sprzedaży: suma brutto per
 * stawka, jedno zaokrąglenie na stawkę (`nettoGr` z lib/dokumenty/pozycje.ts), zw/np = brutto, VAT 0.
 */
export function podsumowaniePozycji(linie: LiniaPodsumowania[]): Podsumowanie {
  let brutto = 0
  let bezStawki = 0
  const doNetto: { bruttoGr: number; stawkaVat: string }[] = []
  for (const l of linie) {
    const b = wartoscCzesciGr(l.qty - l.qtyRejected, l.przesuniecie ?? 0, l.naOferte || 1, grosze(l.unitPriceGross))
    brutto += b
    const s = normalizujStawke(l.stawka)
    if (s === 'zw' || s === 'np' || (s !== null && /^\d{1,2}$/.test(s))) doNetto.push({ bruttoGr: b, stawkaVat: s })
    else bezStawki++
  }
  if (bezStawki > 0) return { bruttoGr: brutto, nettoGr: null, vatGr: null, bezStawki }
  const netto = nettoGr(doNetto)
  return { bruttoGr: brutto, nettoGr: netto, vatGr: brutto - netto, bezStawki: 0 }
}

/** Nazwa do porównania: małe litery, bez znaków przestankowych i podwójnych spacji. */
const doPorownania = (s: string) =>
  s
    .toLocaleLowerCase('pl')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * czy pokazać „w kanale: …” pod nazwą produktu. Tylko gdy nazwa z kanału naprawdę mówi coś innego: ta sama
 * nazwa z inną wielkością liter, interpunkcją albo bez dopisku na końcu (np. gramatury „50g” w nazwie produktu) nie.
 */
export function nazwaWKanaleInna(produkt: string, kanal: string | null | undefined): boolean {
  if (!kanal?.trim()) return false
  const p = doPorownania(produkt)
  const k = doPorownania(kanal)
  if (!k || p === k) return false
  return !(p.startsWith(`${k} `) || k.startsWith(`${p} `))
}
