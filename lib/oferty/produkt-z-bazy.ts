// Produkt z bazy Kompletora → wejście ofert. Czysta funkcja: wołający (ekran „Publikacja”, zadanie
// „Przygotuj oferty”) czyta `Product` z `images` i stan z magazynu, a tu tylko składa `ProduktDoOferty`.
// Zdjęcia: kolejność `position`; adres publiczny = `adresZdjecia` (np. przyszły publiczny adres plików), potem
// `sourceUrl` po https (zdjęcie z feedu albo sklepu), na końcu adres panelu `/api/produkty/zdjecia/<id>` (wymaga
// sesji, więc podgląd oznaczy go ostrzeżeniem „bez publicznego adresu”). Kategorie sklepu i cechy z `details`
// (`kategorieSklepu: string[]`, `cechy: {nazwa, wartosc}[]`), gdy import je zapisał; inaczej z argumentów.
import { zdjecieUrl } from '@/lib/produkty/zdjecia-url'
import type { ProduktDoOferty } from './typy'

/** Pola `Product` potrzebne do oferty (Decimal z Prismy przyjmujemy jako cokolwiek z `toString`). */
export interface ProduktZBazy {
  id: string
  sku: string
  title: string
  ean: string | null
  description: string | null
  weightG: number | null
  priceGross: { toString(): string } | number | string | null
  details: unknown
}

export interface ZdjecieZBazy {
  id: string
  position: number
  sourceUrl: string | null
}

export interface OpcjeProduktuDoOferty {
  /** Dostępna ilość (suma stanów magazynów firmy, liczy wołający). */
  stan: number
  kategorieSklepu?: string[]
  atrybuty?: { nazwa: string; wartosc: string }[]
  /** Publiczny adres zdjęcia; null = brak (wtedy `sourceUrl` po https albo adres panelu). */
  adresZdjecia?: (z: ZdjecieZBazy) => string | null
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

function kwota(v: ProduktZBazy['priceGross']): number | null {
  if (v === null || v === undefined) return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

function kategorieZDetails(d: unknown): string[] {
  const v = rec(d)['kategorieSklepu']
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []
}

function cechyZDetails(d: unknown): { nazwa: string; wartosc: string }[] {
  const v = rec(d)['cechy']
  if (!Array.isArray(v)) return []
  return v
    .map(rec)
    .filter((c) => typeof c['nazwa'] === 'string' && typeof c['wartosc'] === 'string' && (c['nazwa'] as string).trim() && (c['wartosc'] as string).trim())
    .map((c) => ({ nazwa: (c['nazwa'] as string).trim(), wartosc: (c['wartosc'] as string).trim() }))
}

export function produktDoOferty(p: ProduktZBazy, zdjecia: readonly ZdjecieZBazy[], o: OpcjeProduktuDoOferty): ProduktDoOferty {
  const adresy = [...zdjecia]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((z) => {
      const publiczny = o.adresZdjecia?.(z)?.trim()
      if (publiczny) return publiczny
      if (z.sourceUrl && /^https:\/\//i.test(z.sourceUrl.trim())) return z.sourceUrl.trim()
      return zdjecieUrl(z.id, 'o')
    })
  const ean = p.ean?.replace(/\s+/g, '') || null
  return {
    id: p.id,
    nazwa: p.title.trim(),
    sku: p.sku.trim(),
    ean,
    opis: p.description?.trim() ? p.description : null,
    wagaG: typeof p.weightG === 'number' && p.weightG > 0 ? p.weightG : null,
    cenaBrutto: kwota(p.priceGross),
    stan: Number.isFinite(o.stan) ? Math.max(0, Math.floor(o.stan)) : 0,
    zdjecia: [...new Set(adresy)],
    kategorieSklepu: o.kategorieSklepu ?? kategorieZDetails(p.details),
    atrybuty: o.atrybuty ?? cechyZDetails(p.details),
  }
}
