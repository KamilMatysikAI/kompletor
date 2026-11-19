// Pozycje zamówień do listy „Zamówienia”: część bez dostępu do bazy, importowana też przez komponent
// klienta (`app/(panel)/zamowienia/_lista/produkty.tsx`), więc tylko importy typów. Zapytanie: `./lista-zamowien`.
import type { Unit } from '@prisma/client'
import type { ProductInfo } from './dane'

export interface ListLine {
  title: string
  qty: number
  unit: Unit
  bundle: boolean
  /** Produkt cyfrowy: pozycja bez stanu magazynowego (nie zbiera się jej z półki). */
  digital: boolean
  /** Brakująca ilość w jednostce bazowej produktu pozycji (0 = towar jest). Przy zestawie liczba zestawów nie wynika
   *  wprost z braków składników, więc zostaje 0, a brakujące składniki są w `missingParts`. */
  missing: number
  /** Zestaw (albo każda linia, której brak dotyczy innego produktu): nazwy brakujących składników. */
  missingParts: string[]
  /** główne zdjęcie produktu pozycji (id zdjęcia); brak = miniatura z inicjałami */
  zdjecie?: string | null
}

type LineIn = { orderId: string; productId: string | null; channelName?: string | null; qty: number; shortages: { productId: string; qtyBase: number }[] }

const UNMAPPED = 'pozycja bez powiązania z produktem'

/** Czysta część (testy jednostkowe): pozycje zamówienia z produktami i otwartymi brakami. */
export function buildListLines(lines: LineIn[], prods: Map<string, Pick<ProductInfo, 'title' | 'unit' | 'kind'>>, zdjecia?: ReadonlyMap<string, string>): Map<string, ListLine[]> {
  const out = new Map<string, ListLine[]>()
  for (const l of lines) {
    const p = l.productId ? prods.get(l.productId) : undefined
    const bundle = p?.kind === 'BUNDLE'
    const own = l.shortages.filter((s) => s.productId === l.productId)
    // każda linia, nie tylko rozpoznany zestaw: brak nie może zniknąć, gdy produktu zestawu nie ma w productInfo
    const parts = l.shortages.filter((s) => s.productId !== l.productId)
    const item: ListLine = {
      // pozycja bez produktu pokazuje nazwę z kanału z dopiskiem, żeby było widać, co klient kupił
      title: p ? p.title : l.channelName ? `${l.channelName} (bez powiązania)` : UNMAPPED,
      qty: l.qty,
      unit: p?.unit ?? 'SZT',
      bundle,
      digital: p?.kind === 'DIGITAL',
      missing: own.reduce((s, x) => s + x.qtyBase, 0),
      missingParts: [...new Set(parts.map((s) => prods.get(s.productId)?.title ?? 'składnik'))],
      zdjecie: l.productId ? (zdjecia?.get(l.productId) ?? null) : null,
    }
    const arr = out.get(l.orderId)
    if (arr) arr.push(item)
    else out.set(l.orderId, [item])
  }
  return out
}

export const isMissing = (l: ListLine): boolean => l.missing > 0 || l.missingParts.length > 0
