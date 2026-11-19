// Lista zbierania (BL: „zbieranie sortowane po lokalizacji”, koszyki A–J): pozycje zaznaczonych zamówień
// zsumowane po produkcie i ułożone po półkach (C-4-2 przed C-4-10), przy każdej rozpisanie na koszyki/zamówienia.
// Czysta funkcja — testy w zbieranie.test.ts; dane z lib/stanowisko/zamowienia.ts (te same ilości co stanowisko:
// po odjęciu braków, zestaw rozbity na składniki, bez produktów bez stanu).
import { sortujPoLokalizacji } from '@/lib/wydruki'
import type { ZamowienieStanowiska } from '@/lib/stanowisko/zamowienia'

export interface DoKoszyka {
  orderId: string
  numer: string
  koszyk: string | null
  ilosc: number
}

export interface PozycjaListyZbierania {
  klucz: string
  productId: string | null
  nazwa: string
  sku: string | null
  lokalizacja: string | null
  zdjecie: string | null
  jednostka: 'szt' | 'g'
  razem: number
  doKoszykow: DoKoszyka[]
}

type Zamowienie = Pick<ZamowienieStanowiska, 'id' | 'numer' | 'koszyk' | 'pozycje'>

export function listaZbierania(zamowienia: readonly Zamowienie[]): PozycjaListyZbierania[] {
  const poProdukcie = new Map<string, PozycjaListyZbierania>()
  for (const z of zamowienia) {
    for (const p of z.pozycje) {
      // pozycja bez produktu (niepowiązana) zostaje osobno: nie wiadomo, czy to ten sam towar
      const klucz = p.productId ? `p:${p.productId}:${p.jednostka}` : `l:${p.klucz}`
      let w = poProdukcie.get(klucz)
      if (!w) {
        w = { klucz, productId: p.productId, nazwa: p.nazwa, sku: p.sku, lokalizacja: p.lokalizacja, zdjecie: p.zdjecie ?? null, jednostka: p.jednostka, razem: 0, doKoszykow: [] }
        poProdukcie.set(klucz, w)
      }
      w.razem += p.ilosc
      const juz = w.doKoszykow.find((d) => d.orderId === z.id)
      if (juz) juz.ilosc += p.ilosc
      else w.doKoszykow.push({ orderId: z.id, numer: z.numer, koszyk: z.koszyk, ilosc: p.ilosc })
    }
  }
  return sortujPoLokalizacji([...poProdukcie.values()])
}
