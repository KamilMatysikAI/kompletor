// zamiennik („Zamień produkt”) na dokumencie, w linii rdzenia i na karcie: przelicznik pozycji pierwotnej,
// zamiennik poza wartością pełną zamówienia, błąd zamiany zatrzymuje dokument z komunikatem dla biura. Plus i
// (jedna reguła wartości pozycji, połówka grosza). Dane fikcyjne, bez bazy.
import { describe, expect, it } from 'vitest'
import { KOMUNIKAT_ZAMIENNIKA, komunikatZamiennika, type PozycjaZamowienia, type WejsciePozycji, zlozPozycjeDokumentu } from '../dokumenty/pozycje'
import { linieKsef } from '../ksef/linie'
import { kwotaPaczkiDodatkowej } from '../wfirma/adapter-zapis'
import { podsumowaniePozycji } from '../karta/uklad'
import { rozpiszNaJednostkiBazowe, wartoscPozycjiGr } from './ceny'
import { czyZamiennik, type LiniaDoPrzeliczenia, pozycjaPierwotnaZamiany, przelicznikiPozycji, zrodloZamiany } from './zamiana'

const linia = (o: Partial<LiniaDoPrzeliczenia> & { id: string; externalLineId: string }): LiniaDoPrzeliczenia => ({ productId: 'p', offerId: null, qty: 1, qtyRejected: 0, removed: false, ...o })
const poz = (o: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({ sku: 'A1', rodzaj: 'STOCKED', nazwa: 'Towar A1', jednostka: 'SZT', wfirmaGoodId: '1', qty: 1, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 1250, stawkaVat: '23', ...o })
const wej = (pozycje: PozycjaZamowienia[], totalGross: number): WejsciePozycji => ({ totalGross, pozycje, wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' } })

describe('nazwy pozycji zamiennika', () => {
  it('pozycja pierwotna, źródło i zamiennik w łańcuchu zamian', () => {
    expect(czyZamiennik('L1#zamiana-1')).toBe(true)
    expect(czyZamiennik('L1#zamiana-1#zamiana-2')).toBe(true)
    expect(czyZamiennik('L1#zamiana-1#dosle')).toBe(false)
    expect(czyZamiennik('L1')).toBe(false)
    expect(pozycjaPierwotnaZamiany('L1#zamiana-1#zamiana-2')).toBe('L1')
    expect(zrodloZamiany('L1#zamiana-1#zamiana-2')).toBe('L1#zamiana-1')
    expect(zrodloZamiany('L1#zamiana-1#dosle')).toBeNull()
    expect(pozycjaPierwotnaZamiany('L1#dosle')).toBeNull()
  })
})

describe('przelicznikiPozycji', () => {
  const oferty = (o: string) => ({ W50: 50, K3: 3 })[o]

  it('zamiennik dziedziczy przelicznik pozycji pierwotnej, także przy zamianie zamiennika', () => {
    const r = przelicznikiPozycji(
      [
        linia({ id: 'a', externalLineId: 'L1', offerId: 'W50', qty: 100, qtyRejected: 50 }),
        linia({ id: 'b', externalLineId: 'L1#zamiana-1', qty: 50, qtyRejected: 20 }),
        linia({ id: 'c', externalLineId: 'L1#zamiana-1#zamiana-2', qty: 20 }),
        linia({ id: 'd', externalLineId: 'L2', offerId: 'K3', qty: 3 }),
        linia({ id: 'e', externalLineId: 'L3', offerId: 'NIEZNANA' }),
      ],
      oferty,
    )
    expect(Object.fromEntries(r.naOferte)).toEqual({ a: 50, b: 50, c: 50, d: 3 })
    expect(Object.fromEntries(r.zamienniki)).toEqual({ b: null, c: null })
  })

  it('pozycja pierwotna usunięta albo nieobecna (dosłanie zamiennika w innej paczce): błąd zamiany', () => {
    const r = przelicznikiPozycji(
      [linia({ id: 'a', externalLineId: 'L1', offerId: 'W50', qty: 50, qtyRejected: 50, removed: true }), linia({ id: 'b', externalLineId: 'L1#zamiana-1', qty: 50 }), linia({ id: 'c', externalLineId: 'L9#zamiana-1#dosle', qty: 1 })],
      oferty,
    )
    expect(Object.fromEntries(r.zamienniki)).toEqual({ b: 'bez-pozycji-pierwotnej', c: 'bez-pozycji-pierwotnej' })
  })

  it('zamieniono więcej sztuk, niż pozycja ma odrzuconych: błąd zamiany', () => {
    const r = przelicznikiPozycji([linia({ id: 'a', externalLineId: 'L1', qty: 2, qtyRejected: 1 }), linia({ id: 'b', externalLineId: 'L1#zamiana-1', qty: 2 })], oferty)
    expect(r.zamienniki.get('b')).toBe('wiecej-niz-odrzucono')
  })

  it('przelicznik oferty 0 albo ułamkowy traktujemy jak brak oferty (1)', () => {
    const r = przelicznikiPozycji([linia({ id: 'a', externalLineId: 'L1', offerId: 'X' })], () => 0)
    expect(r.naOferte.has('a')).toBe(false)
  })
})

// runda 2: pozycja pierwotna niesie `pokryte` (jednostki pokryte przez rodzinę zamian, z `pozycjeZamowienia`); bez niego
// bezpiecznik liczy cel bez zamiennika i dokument staje — wejście ręczne musi je podać
describe('dokument z zamiennikiem (zlozPozycjeDokumentu)', () => {
  it('przykład 1 z przeglądu: 12,50 zł + wysyłka 12,99 zł → 25,49 zł, zamiennik nie zjada wysyłki', () => {
    const d = zlozPozycjeDokumentu(wej([poz({ qtyOdrzucone: 1, pokryte: 1 }), poz({ sku: 'B1', nazwa: 'Towar B1', zamiennik: null })], 25.49))
    expect(d.problemy).toEqual([])
    expect(d.linie.map((l) => [l.sku, l.bruttoGr])).toEqual([['B1', 1250], [null, 1299]])
    expect(d.bruttoGr).toBe(2549)
  })

  it('przykład 3: oferta 50 g za 12,50 zł, zamiana 50 g → 0,05 kg za 12,50 zł', () => {
    const d = zlozPozycjeDokumentu(wej([poz({ jednostka: 'KG', qty: 50, qtyOdrzucone: 50, naOferte: 50, pokryte: 50 }), poz({ sku: 'B1', jednostka: 'KG', qty: 50, naOferte: 50, zamiennik: null })], 25.49))
    expect(d.problemy).toEqual([])
    expect(d.linie.map((l) => [l.sku, l.ilosc, l.bruttoGr])).toEqual([['B1', 0.05, 1250], [null, 1, 1299]])
  })

  it('błąd zamiany: problem dla każdego programu, komunikat dla biura po polsku zamiast kodu', () => {
    const d = zlozPozycjeDokumentu(wej([poz({ sku: 'B1', zamiennik: 'bez-pozycji-pierwotnej' })], 25.49))
    expect(d.problemy.map((p) => p.kod)).toContain('zamiennik-bez-pozycji-pierwotnej')
    expect(komunikatZamiennika(d.problemy)).toBe(KOMUNIKAT_ZAMIENNIKA)
    expect(KOMUNIKAT_ZAMIENNIKA).toContain('„Ponów fakturę”')
    expect(linieKsef(wej([poz({ sku: 'B1', zamiennik: 'wiecej-niz-odrzucono' })], 25.49)).problemy.map((p) => p.tekst)).toContain(KOMUNIKAT_ZAMIENNIKA)
    expect(komunikatZamiennika(zlozPozycjeDokumentu(wej([poz()], 25.49)).problemy)).toBeNull()
  })

  it('paczka dodatkowa: kwota bez zamienników (ich sztuki są w pozycji pierwotnej)', () => {
    expect(kwotaPaczkiDodatkowej([poz({ qty: 2, qtyOdrzucone: 1 }), poz({ zamiennik: null })])).toBe(25)
  })
})

describe('jedna reguła wartości pozycji', () => {
  it('29 g z oferty 50 g za 3,75 zł = 217,5 gr → 218 gr (rdzeń, dokument, karta)', () => {
    expect(wartoscPozycjiGr(29, 50, 375)).toBe(218)
    const d = zlozPozycjeDokumentu(wej([poz({ jednostka: 'KG', qty: 29, naOferte: 50, cenaBruttoGr: 375 })], 2.18))
    expect(d.bruttoGr).toBe(218)
    expect(d.problemy).toEqual([])
    expect(podsumowaniePozycji([{ unitPriceGross: 3.75, qty: 29, qtyRejected: 0, naOferte: 50, stawka: '5' }]).bruttoGr).toBe(218)
  })

  it('suma linii rdzenia (rozpiszNaJednostkiBazowe) = wartość pozycji = suma dokumentu, 20 000 losowych pozycji', () => {
    let seed = 236
    const los = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 20_000; i++) {
      const n = [1, 1, 2, 3, 50, 100, 1000][los(7)]!
      const qty = 1 + los(n * 4)
      const cena = 1 + los(20_000)
      const kg = n >= 50
      const w = wartoscPozycjiGr(qty, n, cena)
      expect(rozpiszNaJednostkiBazowe(qty, w).reduce((s, x) => s + x.qty * x.unitGrossGr, 0)).toBe(w)
      const d = zlozPozycjeDokumentu(wej([poz({ jednostka: kg ? 'KG' : 'SZT', qty, naOferte: n, cenaBruttoGr: cena })], (w + 999) / 100))
      expect(d.bruttoGr).toBe(w + 999)
      expect(d.linie.filter((l) => !l.wysylka).reduce((s, l) => s + l.bruttoGr, 0) + (d.linie.find((l) => l.wysylka)?.bruttoGr ?? 0)).toBe(w + 999)
      expect(podsumowaniePozycji([{ unitPriceGross: cena / 100, qty, qtyRejected: 0, naOferte: n, stawka: '23' }]).bruttoGr).toBe(w)
    }
  })
})
