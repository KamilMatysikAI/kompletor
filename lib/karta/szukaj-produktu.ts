// Wyszukiwarka produktów okna „Zamień produkt” na karcie zamówienia (wzór: BL „Operacje na produktach →
// zamień”). Fraza w SKU, nazwie albo EAN (dokładnie), tylko aktywne produkty magazynowe (zamiana działa wyłącznie na
// takich, lib/rdzen/brakuje.ts `swapProduct`), stan dostępny (na półce − zarezerwowane) z księgi stanu. Każdy wynik
// mówi, czy nadaje się na zamiennik tej pozycji (ta sama jednostka, inny produkt, dość sztuk na stanie); ostateczną
// kontrolę i tak robi rdzeń pod blokadą przy zapisie. Klient bazy jednej firmy (RLS), bez danych klientów.
import type { PrismaClient, Unit } from '@prisma/client'
import { searchProducts } from '@/lib/api/produkty'
import { readStock } from '@/lib/api/stany'

type Db = PrismaClient

export const MIN_FRAZY = 2
const LIMIT = 15

export interface ProduktZamiennika {
  sku: string
  nazwa: string
  ean: string | null
  jednostka: Unit
  /** Stan dostępny w jednostce bazowej; null = produkt bez stanu. */
  dostepne: number | null
  /** Powód, dla którego produkt nie nadaje się na zamiennik tej pozycji; null = można wybrać. */
  powod: string | null
}

export interface DlaPozycji {
  /** Produkt pozycji (nie może być zamiennikiem sam dla siebie). */
  sku: string | null
  jednostka: Unit | null
  /** Ile jednostek brakuje (otwarty brak): zamiennika musi być co najmniej tyle. */
  potrzeba: number
}

export async function szukajZamiennika(db: Db, fraza: unknown, dla: DlaPozycji): Promise<{ produkty: ProduktZamiennika[]; blad: string | null }> {
  const f = String(fraza ?? '').trim().slice(0, 100)
  if (f.length < MIN_FRAZY) return { produkty: [], blad: 'Wpisz co najmniej 2 znaki SKU, nazwy albo EAN.' }
  const { produkty } = await searchProducts(db, { phrase: f, active: true, kinds: ['STOCKED'], limit: LIMIT, after: null })
  if (!produkty.length) return { produkty: [], blad: null }
  const stany = await readStock(db, { skus: produkty.map((p) => p.sku), page: 1 })
  const stan = new Map(stany.pozycje.map((s) => [s.sku, 'bezStanu' in s ? null : s.dostepne]))
  const potrzeba = Math.max(1, Math.floor(dla.potrzeba))
  return {
    blad: null,
    produkty: produkty.map((p) => {
      const dostepne = stan.get(p.sku) ?? null
      let powod: string | null = null
      if (p.sku === dla.sku) powod = 'to ten sam produkt'
      else if (dla.jednostka && p.jednostka !== dla.jednostka) powod = 'inna jednostka (sztuki i gramy)'
      else if (dostepne === null || dostepne < potrzeba) powod = `za mało na stanie (potrzeba ${potrzeba})`
      return { sku: p.sku, nazwa: p.nazwa, ean: p.ean, jednostka: p.jednostka, dostepne, powod }
    }),
  }
}

/** Produkt z katalogu firmy do „Dodaj pozycję” na karcie i do „Dodaj zamówienie”. */
export interface ProduktKatalogu {
  id: string
  sku: string
  nazwa: string
  bezStanu: boolean
  /** Sztuki dostępne (fizycznie − zarezerwowane; zestaw z minimum składników); null = produkt bez stanu. */
  dostepne: number | null
  /** Cena detaliczna brutto z katalogu; null = produkt bez ceny. */
  cena: number | null
}

/**
 * wyszukiwarka „Dodaj pozycję” na karcie zamówienia; ta sama co w „Dodaj zamówienie” (jedno źródło).
 * Fraza w SKU, nazwie albo EAN, tylko aktywne produkty, stan dostępny z księgi stanu, cena z katalogu. Klient bazy jednej
 * firmy (RLS), bez danych klientów. Dodanie pozycji i tak sprawdza rdzeń pod blokadą zamówienia.
 */
export async function szukajProduktuDoZamowienia(db: Db, fraza: unknown): Promise<{ produkty: ProduktKatalogu[]; blad: string | null }> {
  const f = String(fraza ?? '').trim().slice(0, 100)
  if (f.length < MIN_FRAZY) return { produkty: [], blad: 'Wpisz co najmniej 2 znaki SKU, nazwy albo EAN.' }
  const { produkty } = await searchProducts(db, { phrase: f, active: true, limit: LIMIT, after: null })
  if (!produkty.length) return { produkty: [], blad: null }
  const skus = produkty.map((p) => p.sku)
  const [stany, wiersze] = await Promise.all([
    readStock(db, { skus, page: 1 }),
    db.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, priceGross: true } }),
  ])
  const stan = new Map(stany.pozycje.map((s) => [s.sku, 'bezStanu' in s ? null : s.dostepne]))
  const wiersz = new Map(wiersze.map((w) => [w.sku, w]))
  return {
    blad: null,
    produkty: produkty
      .filter((p) => wiersz.has(p.sku))
      .map((p) => {
        const w = wiersz.get(p.sku)!
        return { id: w.id, sku: p.sku, nazwa: p.nazwa, bezStanu: p.rodzaj === 'DIGITAL', dostepne: stan.get(p.sku) ?? null, cena: w.priceGross === null ? null : Number(w.priceGross.toFixed(2)) }
      }),
  }
}
