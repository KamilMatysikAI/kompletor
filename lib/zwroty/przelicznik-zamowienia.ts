// przelicznik pozycji dla kwot PO WYSYŁCE (korekta KSeF przy zwrocie, lista
// „Do zwrotu” za brak). Po wysyłce przelicznik oferty wolno zmienić (`sprawdzZmianePrzelicznika`, lib/produkty/powiazania.ts
// blokuje tylko przy otwartych zamówieniach), a pozycji wysłanych zamówień nikt nie przelicza. Kwota zwrotu liczona z
// AKTUALNEJ oferty rozjeżdża się wtedy z zapłaconą kwotą i wystawioną fakturą (oferta 50 g za 12,50 zł, qty 50,
// qtyChannel 1; po zmianie przelicznika na 100 korekta −6,25 zł zamiast −12,50 zł, po zmianie na 25 −25,00 zł).
//
// Reguła: pozycja z kanału z `qtyChannel > 0` = `qty / qtyChannel` (zapis z chwili zamówienia; edycja z karty trzyma tę
// proporcję, lib/rdzen/edycja.ts). Zamiennik („Zamień produkt”) = proporcja pozycji pierwotnej. Aktualna oferta
// (`przelicznikiPozycji`) tylko wtedy, gdy zamówienie proporcji nie zapisało (`qtyChannel` null: pozycje `#dosle`/`#paczka`,
// pozycje sprzed migracji). Rodziny zamian, przesunięcia i błędy bez zmian z `przelicznikiPozycji`.
import { type LiniaDoPrzeliczenia, type PrzelicznikiPozycji, pozycjaPierwotnaZamiany, przelicznikiPozycji } from '../rdzen/zamiana'

export type LiniaZamowienia = LiniaDoPrzeliczenia & { qtyChannel: number | null }

/** Proporcja zapisana w zamówieniu (jednostki bazowe na sztukę oferty) albo undefined, gdy jej nie ma. */
export function proporcjaZamowienia(l: { qty: number; qtyChannel: number | null }): number | undefined {
  if (!l.qtyChannel || l.qtyChannel <= 0 || !(l.qty > 0)) return undefined
  const n = l.qty / l.qtyChannel
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Jak `przelicznikiPozycji`, ale `naOferte` najpierw z proporcji zamówienia (opis wyżej). */
export function przelicznikiZZamowienia(linie: readonly LiniaZamowienia[], przelicznikOferty: (offerId: string) => number | undefined): PrzelicznikiPozycji {
  const prz = przelicznikiPozycji(linie, przelicznikOferty)
  const poExt = new Map(linie.map((l) => [l.externalLineId, l]))
  const naOferte = new Map(prz.naOferte)
  for (const l of linie) {
    const ext = pozycjaPierwotnaZamiany(l.externalLineId)
    if (ext === null) {
      const n = proporcjaZamowienia(l)
      if (n !== undefined) naOferte.set(l.id, n)
      continue
    }
    if (prz.zamienniki.get(l.id) === 'bez-pozycji-pierwotnej') continue
    const pierwotna = poExt.get(ext)
    const n = pierwotna ? proporcjaZamowienia(pierwotna) : undefined
    if (n !== undefined) naOferte.set(l.id, n)
  }
  return { ...prz, naOferte }
}
