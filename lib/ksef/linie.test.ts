// linie faktury KSeF = wspólne linie dokumentu (lib/dokumenty/pozycje.ts: wysyłka, zestaw, DIGITAL,
// zaokrąglenia), bez problemów istniejących tylko przy wFirmie (pole `dotyczyProgramu`). Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import type { PozycjaZamowienia, WejsciePozycji } from '../dokumenty/pozycje'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import { zbudujFa3 } from './fa3/builder'
import { linieKsef } from './linie'

// firma bez wFirmy: brak kodów VAT i serii wFirmy, towary bez goodId
const cfg = parseKonfiguracjaFaktur({})
const poz = (o: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({ sku: 'A1', rodzaj: 'STOCKED', nazwa: 'Przyprawa A1', jednostka: 'SZT', wfirmaGoodId: null, qty: 2, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 2000, stawkaVat: '23', ...o })
const wej = (o: Partial<WejsciePozycji> = {}): WejsciePozycji => ({ totalGross: 40, pozycje: [poz()], wysylka: cfg.wysylka, ...o })
const SPRZEDAWCA = { nip: '1111111111', nazwa: 'Sprzedawca Testowy', adres: { kodKraju: 'PL', linia1: 'ul. Fikcyjna 1' } }
const fa = (l: ReturnType<typeof linieKsef>) =>
  zbudujFa3({ numer: 'SZKIC-1', dataWystawienia: '2026-11-02', wytworzono: new Date('2026-11-02T10:00:00Z'), waluta: 'PLN', rodzaj: 'VAT', sprzedawca: SPRZEDAWCA, nabywca: { nip: null, nazwa: 'N' }, wiersze: l.wiersze, podstawaZwolnienia: 'art. 43 ust. 1 pkt 1 ustawy o VAT' })

describe('linieKsef', () => {
  it('bez goodId, kodów VAT i formy płatności wFirmy: brak problemów (odfiltrowane tylko te z wFirmy)', () => {
    const l = linieKsef(wej())
    expect(l.problemy).toEqual([])
    expect(l.wiersze).toEqual([{ nazwa: 'Przyprawa A1', jednostka: 'szt.', ilosc: 2, cenaBruttoGr: 2000, bruttoGr: 4000, stawka: '23' }])
    expect(fa(l).problemy).toEqual([])
  })

  it('pozycja bez produktu zostaje problemem (nie wiadomo, co sprzedano)', () => {
    expect(linieKsef(wej({ pozycje: [poz({ sku: null, rodzaj: null })] })).problemy.map((p) => p.kod)).toEqual(['pozycja-bez-produktu'])
  })

  it('wysyłka: różnica do totalGross, suma faktury = totalGross', () => {
    const l = linieKsef(wej({ totalGross: 52.99 }))
    expect(l.wiersze.at(-1)).toEqual({ nazwa: 'Wysyłka', jednostka: 'szt.', ilosc: 1, cenaBruttoGr: 1299, bruttoGr: 1299, stawka: '23' })
    const f = fa(l)
    expect(f.sumy.bruttoGr).toBe(5299)
    expect(f.xml).toContain('<P_15>52.99</P_15>')
  })

  it('zestaw rozbity na składniki z różnymi stawkami, suma = totalGross', () => {
    const skladniki = [
      { sku: 'S1', nazwa: 'Przyprawa S1', jednostka: 'SZT' as const, wfirmaGoodId: null, qty: 1, cenaDetalicznaBrutto: 20, stawkaVat: '5' },
      { sku: 'S2', nazwa: 'Kubek S2', jednostka: 'SZT' as const, wfirmaGoodId: null, qty: 1, cenaDetalicznaBrutto: 20, stawkaVat: '23' },
    ]
    const l = linieKsef(wej({ totalGross: 33, pozycje: [poz({ sku: 'Z1', rodzaj: 'BUNDLE', qty: 1, cenaBruttoGr: 3300, stawkaVat: null, skladniki })] }))
    expect(l.problemy).toEqual([])
    expect(l.wiersze.map((w) => [w.nazwa, w.stawka, w.bruttoGr])).toEqual([
      ['Przyprawa S1', '5', 1650],
      ['Kubek S2', '23', 1650],
    ])
    const f = fa(l)
    expect(f.sumy.bruttoGr).toBe(3300)
    expect(f.xml).toContain('<P_13_1>13.41</P_13_1><P_14_1>3.09</P_14_1><P_13_3>15.71</P_13_3><P_14_3>0.79</P_14_3><P_15>33.00</P_15>')
  })

  it('DIGITAL (e-book) jako zwykła pozycja ze stawką produktu', () => {
    const l = linieKsef(wej({ totalGross: 60, pozycje: [poz(), poz({ sku: 'E1', rodzaj: 'DIGITAL', nazwa: 'E-book E1', qty: 1, stawkaVat: '5' })] }))
    expect(l.problemy).toEqual([])
    expect(l.wiersze.at(-1)).toMatchObject({ nazwa: 'E-book E1', stawka: '5', bruttoGr: 2000 })
    expect(fa(l).sumy.bruttoGr).toBe(6000)
  })

  it('stawki 8, 0 i zw z produktów oraz oferta na kilka sztuk (zaokrąglenie bez zawyżenia)', () => {
    const l = linieKsef(
      wej({
        totalGross: 40,
        pozycje: [poz({ sku: 'B8', stawkaVat: '8', qty: 1, cenaBruttoGr: 1000 }), poz({ sku: 'B0', stawkaVat: '0', qty: 1, cenaBruttoGr: 1000 }), poz({ sku: 'BZ', stawkaVat: 'zw', qty: 1, cenaBruttoGr: 1000 }), poz({ sku: 'P3', qty: 3, naOferte: 3, cenaBruttoGr: 1000 })],
      }),
    )
    expect(l.problemy).toEqual([])
    expect(l.bruttoGr).toBe(4000)
    const f = fa(l)
    expect(f.problemy).toEqual([])
    expect([...f.xml!.matchAll(/<P_12>([^<]+)<\/P_12>/g)].map((m) => m[1])).toEqual(['8', '0 KR', 'zw', '23', '23'])
    expect(f.sumy.bruttoGr).toBe(4000)
  })

  it('produkt bez stawki = problem jawny', () => {
    expect(linieKsef(wej({ pozycje: [poz({ stawkaVat: null })] })).problemy.map((p) => p.kod)).toEqual(['brak-stawki'])
  })
})
