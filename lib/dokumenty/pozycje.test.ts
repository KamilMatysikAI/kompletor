// wspólne pozycje dokumentu (lib/dokumenty/pozycje.ts) — jedna funkcja linii dla wFirmy, KSeF i kolejnych
// programów; pole `dotyczyProgramu` zamiast listy kodów w KSeF; `zlozFakture` bez zmiany wyniku. Dane fikcyjne, bez bazy.
import { describe, expect, it } from 'vitest'
import { linieKsef } from '../ksef/linie'
import { zlozFakture } from '../wfirma/faktura'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import { type PozycjaZamowienia, problemyProgramu, type WejsciePozycji, zlozPozycjeDokumentu } from './pozycje'

const poz = (o: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({ sku: 'A1', rodzaj: 'STOCKED', nazwa: 'Towar A1', jednostka: 'SZT', wfirmaGoodId: null, qty: 2, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 2000, stawkaVat: '23', ...o })
const wej = (o: Partial<WejsciePozycji> = {}): WejsciePozycji => ({ totalGross: 52.99, pozycje: [poz()], wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' }, ...o })

describe('zlozPozycjeDokumentu', () => {
  it('towar bez powiązania z kartoteką wFirmy: problem tylko dla wFirmy, linie i suma takie same', () => {
    const p = zlozPozycjeDokumentu(wej())
    expect(p.problemy).toEqual([{ kategoria: 'BRAK_POWIAZANIA', kod: 'brak-towaru-wfirmy', sku: 'A1', dotyczyProgramu: 'wfirma' }])
    expect(problemyProgramu(p.problemy, 'ksef')).toEqual([])
    expect(problemyProgramu(p.problemy, 'brak')).toEqual([])
    expect(problemyProgramu(p.problemy, 'fakturownia.v1')).toEqual([])
    expect(problemyProgramu(p.problemy, 'wfirma').map((x) => x.kod)).toEqual(['brak-towaru-wfirmy'])
    expect(p.linie.map((l) => [l.nazwa, l.bruttoGr])).toEqual([['Towar A1', 4000], ['Wysyłka', 1299]])
    expect(p.bruttoGr).toBe(5299)
  })

  it('problem dokumentu (pozycja bez produktu) dotyczy każdego programu', () => {
    const p = zlozPozycjeDokumentu(wej({ pozycje: [poz({ sku: null, rodzaj: null })] }))
    const kod = p.problemy.find((x) => x.kod === 'pozycja-bez-produktu')!
    expect(kod.dotyczyProgramu).toBeUndefined()
    for (const prog of ['wfirma', 'ksef', 'brak', 'fakturownia.v1']) expect(problemyProgramu(p.problemy, prog).map((x) => x.kod)).toContain('pozycja-bez-produktu')
  })

  it('towarBezPowiazania (dokument bez rozchodu): bez problemu, goodId 0', () => {
    const p = zlozPozycjeDokumentu(wej({ towarBezPowiazania: true }))
    expect(p.problemy).toEqual([])
    expect(p.linie[0]!.goodId).toBe(0)
  })

  it('wFirma i KSeF biorą te same linie z jednego miejsca; faktura wFirmy bez pola dotyczyProgramu (wynik 1:1)', () => {
    const cfg = parseKonfiguracjaFaktur({ faktury: { kodyVat: { '23': 1001 } } })
    const f = zlozFakture({ idExternal: 'z/1/0', totalGross: 52.99, paymentMethod: 'BLIK', paymentState: 'PAID', pozycje: [poz()], konfiguracja: cfg })
    const k = linieKsef(wej())
    const p = zlozPozycjeDokumentu(wej())
    expect(f.linie).toEqual(p.linie)
    expect(k.wiersze.map((w) => w.bruttoGr)).toEqual(p.linie.map((l) => l.bruttoGr))
    expect(f.problemy).toEqual([{ kategoria: 'BRAK_POWIAZANIA', kod: 'brak-towaru-wfirmy', sku: 'A1' }])
    expect('dotyczyProgramu' in f.problemy[0]!).toBe(false)
    expect(k.problemy).toEqual([])
  })
})
