// (R12 z przeglądu TwojOMS): kompletność danych produktów — liczniki kafli nad listą produktów i ten
// sam zbiór dla filtrów listy (`/produkty?filtr=bez_ean` itd.), więc licznik kafla i liczba wierszy po kliknięciu
// zgadzają się z konstrukcji. Jedno zapytanie po produkty (aktywne, z liczbą aktywnych ofert) plus reguły i strefy
// firmy (strefa z reguł to wyrażenie regularne z `lib/pakowanie/strefy.ts`, której Postgres nie policzy tak samo).
// Tylko odczyt. Produkty bez stanu (e-book, usługa) nie wchodzą do kompletności: nie mają wagi, strefy ani EAN-u
// do wysyłki; kafel „bez stanu” jest informacją, celem jest ekran `/produkty/bez-stanu`.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { productZone } from '@/lib/pakowanie/strefy'

export const BRAKI_PRODUKTU = ['bez_ean', 'bez_wagi', 'bez_oferty', 'bez_strefy'] as const
export type BrakProduktu = (typeof BRAKI_PRODUKTU)[number]

export const ETYKIETA_BRAKU: Record<BrakProduktu, string> = {
  bez_ean: 'bez SKU albo EAN',
  bez_wagi: 'bez wagi i wymiarów',
  bez_oferty: 'bez powiązania z ofertą',
  bez_strefy: 'bez strefy magazynu',
}

export function isBrakProduktu(v: string | undefined): v is BrakProduktu {
  return !!v && (BRAKI_PRODUKTU as readonly string[]).includes(v)
}

export interface ProduktDoOceny {
  id: string
  sku: string
  ean: string | null
  title: string
  kind: 'STOCKED' | 'BUNDLE' | 'DIGITAL'
  weightG: number | null
  lengthCm: unknown
  widthCm: unknown
  heightCm: unknown
  packingZone: string | null
  oferty: number
}

export interface Kompletnosc {
  /** aktywne produkty fizyczne (towar i zestawy), czyli mianownik „kompletnych N/M” */
  razem: number
  kompletne: number
  braki: Record<BrakProduktu, string[]>
  /** aktywne produkty bez stanu (e-book, usługa) */
  bezStanu: number
  /** czy firma ma strefy magazynu; bez stref brak strefy nie jest brakiem (kafel prowadzi do ustawień stref) */
  maStrefy: boolean
}

const puste = (v: string | null | undefined) => !v || !v.trim()

/**
 * Czysta ocena (test jednostkowy): które braki ma produkt. Strefa tylko dla towaru magazynowego (zestaw zbiera się
 * ze składników), i tylko gdy firma ma strefy; waga i wymiary dla towaru i zestawu (oba jadą w paczce).
 */
export function brakiProduktu(p: ProduktDoOceny, kontekst: { maStrefy: boolean; reguly: Parameters<typeof productZone>[1] }): BrakProduktu[] {
  if (p.kind === 'DIGITAL') return []
  const out: BrakProduktu[] = []
  if (puste(p.sku) || puste(p.ean)) out.push('bez_ean')
  if (p.weightG === null || p.lengthCm === null || p.widthCm === null || p.heightCm === null) out.push('bez_wagi')
  if (p.oferty === 0) out.push('bez_oferty')
  if (kontekst.maStrefy && p.kind === 'STOCKED' && productZone(p, kontekst.reguly).zone === null) out.push('bez_strefy')
  return out
}

export function policzKompletnosc(produkty: readonly ProduktDoOceny[], kontekst: { maStrefy: boolean; reguly: Parameters<typeof productZone>[1] }): Kompletnosc {
  const braki: Record<BrakProduktu, string[]> = { bez_ean: [], bez_wagi: [], bez_oferty: [], bez_strefy: [] }
  let razem = 0
  let kompletne = 0
  let bezStanu = 0
  for (const p of produkty) {
    if (p.kind === 'DIGITAL') {
      bezStanu++
      continue
    }
    razem++
    const b = brakiProduktu(p, kontekst)
    if (!b.length) kompletne++
    for (const k of b) braki[k].push(p.id)
  }
  return { razem, kompletne, braki, bezStanu, maStrefy: kontekst.maStrefy }
}

/** Kompletność katalogu firmy (klient firmy, RLS). */
export async function kompletnoscProduktow(db: PrismaClient): Promise<Kompletnosc> {
  organizationIdOf(db)
  const [rows, reguly, strefy] = await Promise.all([
    db.product.findMany({
      where: { active: true },
      select: { id: true, sku: true, ean: true, title: true, kind: true, weightG: true, lengthCm: true, widthCm: true, heightCm: true, packingZone: true, _count: { select: { offers: { where: { active: true } } } } },
    }),
    db.productZoneRule.findMany({ orderBy: { priority: 'asc' }, select: { priority: true, pattern: true, zone: true } }),
    db.packingZoneDef.count(),
  ])
  return policzKompletnosc(
    rows.map(({ _count, ...r }) => ({ ...r, oferty: _count.offers })),
    { maStrefy: strefy > 0, reguly },
  )
}
