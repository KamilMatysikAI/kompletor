'use server'
// Wyszukiwarka okna „Zamień produkt”. Zaczyna od requirePermission (sesja + uprawnienie, klient bazy firmy
// z sesji, RLS); pozycję, jej produkt i liczbę brakujących sztuk czyta z bazy po id pozycji, nie z przeglądarki.
// Tylko odczyt: zamianę wykonuje zapis sekcji „Pozycje” (lib/karta/zapis-pozycji.ts → zdecydujOBraku).
import { ID_RE } from '@/lib/karta/bramka'
import { type ProduktKatalogu, type ProduktZamiennika, szukajProduktuDoZamowienia, szukajZamiennika } from '@/lib/karta/szukaj-produktu'
import { requirePermission } from '@/lib/panel/kontekst'

type WynikSzukania = { produkty: ProduktZamiennika[]; blad: string | null }

export async function szukajZamiennikaKarta(pozycja: string, fraza: string): Promise<WynikSzukania> {
  const ctx = await requirePermission('braki.decyzje')
  const lineId = String(pozycja ?? '')
  if (!ID_RE.test(lineId)) return { produkty: [], blad: 'Nie ma takiej pozycji w zamówieniu.' }
  const l = await ctx.db.orderLine.findUnique({ where: { id: lineId }, select: { productId: true, shortages: { where: { state: 'OPEN' }, select: { qtyBase: true } } } })
  if (!l) return { produkty: [], blad: 'Nie ma takiej pozycji w zamówieniu.' }
  const p = l.productId ? await ctx.db.product.findUnique({ where: { id: l.productId }, select: { sku: true, unit: true } }) : null
  const potrzeba = l.shortages.reduce((s, x) => s + x.qtyBase, 0)
  return szukajZamiennika(ctx.db, fraza, { sku: p?.sku ?? null, jednostka: p?.unit ?? null, potrzeba })
}

/**
 * wyszukiwarka okna „Dodaj pozycję” (SKU, nazwa albo EAN). Tylko odczyt katalogu firmy; pozycję dodaje
 * `dodajPozycjeKarta` (bramka trybu PRACA, ustawienie firmy i rdzeń pod blokadą zamówienia).
 */
export async function szukajProduktuKarta(fraza: string): Promise<{ produkty: ProduktKatalogu[]; blad: string | null }> {
  const ctx = await requirePermission('zamowienia.edycja_pozycji')
  return szukajProduktuDoZamowienia(ctx.db, fraza)
}
