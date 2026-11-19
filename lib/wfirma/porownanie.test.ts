// porównanie naszej faktury z fakturą BL. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { type LiniaFaktury, type Problem, type ZlozonaFaktura } from './faktura'
import { type FakturaBl, PROG_ZGODNOSCI_PROCENT, porownajFakture, procentZgodnych, progSpelniony } from './porownanie'

const linia = (o: Partial<LiniaFaktury> = {}): LiniaFaktury => ({ sku: 'A1', pozycja: 0, sztukOferty: 2, goodId: 500, nazwa: 'x', ilosc: 2, jednostka: 'szt.', cenaBruttoGr: 2000, bruttoGr: 4000, stawkaVat: '23', ...o })
const wys = (o: Partial<LiniaFaktury> = {}) => linia({ sku: null, pozycja: -1, sztukOferty: 1, goodId: 0, ilosc: 1, cenaBruttoGr: 1200, bruttoGr: 1200, wysylka: true, ...o })
const nasza = (linie: LiniaFaktury[], o: Partial<ZlozonaFaktura> = {}): ZlozonaFaktura => ({ tresc: null, linie, problemy: [], forma: 'transfer', bruttoGr: linie.reduce((s, l) => s + l.bruttoGr, 0), nettoGr: 4228, ...o })
const bl = (o: Partial<FakturaBl> = {}): FakturaBl => ({
  pozycje: [
    { sku: 'A1', qty: 2, bruttoGr: 4000, stawkaVat: '23', wysylka: false },
    { sku: null, qty: 1, bruttoGr: 1200, stawkaVat: '23', wysylka: true },
  ],
  bruttoGr: 5200,
  nettoGr: 4228,
  forma: 'transfer',
  ...o,
})
const kody = (r: { roznice: Problem[] }) => r.roznice.map((x) => [x.kategoria, x.kod])

describe('porownajFakture', () => {
  it('zgodna: pozycje, ilości, VAT, sumy, płatność', () => {
    expect(porownajFakture(nasza([linia(), wys()]), bl())).toEqual({ wynik: 'ZGODNA', zakres: 'PELNY', roznice: [], kategorie: [] })
  })

  it('tolerancja 0,01 zł na sumach', () => {
    expect(porownajFakture(nasza([linia(), wys()]), bl({ bruttoGr: 5201, nettoGr: 4227 })).wynik).toBe('ZGODNA')
  })

  it('zaokrąglenie: 2 gr różnicy netto przy zgodnym brutto', () => {
    const r = porownajFakture(nasza([linia(), wys()]), bl({ nettoGr: 4226 }))
    expect(kody(r)).toEqual([['ZAOKRAGLENIE', 'suma-netto']])
  })

  it('VAT: inna stawka pozycji i duża różnica netto', () => {
    const r = porownajFakture(nasza([linia(), wys()]), bl({ pozycje: [{ sku: 'A1', qty: 2, bruttoGr: 4000, stawkaVat: '8', wysylka: false }, { sku: null, qty: 1, bruttoGr: 1200, stawkaVat: '23', wysylka: true }], nettoGr: 4679 }))
    expect(kody(r)).toEqual([
      ['VAT', 'stawka'],
      ['VAT', 'suma-netto'],
    ])
    expect(r.roznice[0]).toMatchObject({ sku: 'A1', nasze: '23', bl: '8' })
  })

  it('wysyłka: inna kwota i stawka; suma przypisana do wysyłki', () => {
    const r = porownajFakture(nasza([linia(), wys()]), bl({ pozycje: [{ sku: 'A1', qty: 2, bruttoGr: 4000, stawkaVat: '23', wysylka: false }, { sku: null, qty: 1, bruttoGr: 1500, stawkaVat: '8', wysylka: true }], bruttoGr: 5500 }))
    expect(r.kategorie).toEqual(['WYSYLKA'])
    expect(r.roznice.map((x) => x.kod)).toEqual(['kwota-wysylki', 'vat-wysylki', 'suma-brutto'])
  })

  it('ilość, pozycja tylko po jednej stronie, pozycja BL bez SKU, liczba pozycji', () => {
    const a = porownajFakture(nasza([linia(), wys()]), bl({ pozycje: [{ sku: 'A1', qty: 3, bruttoGr: 4000, stawkaVat: '23', wysylka: false }, { sku: null, qty: 1, bruttoGr: 1200, stawkaVat: '23', wysylka: true }] }))
    expect(kody(a)).toEqual([['INNE', 'ilosc']])
    const b = porownajFakture(nasza([linia(), wys()]), bl({ pozycje: [{ sku: 'B2', qty: 2, bruttoGr: 4000, stawkaVat: '23', wysylka: false }, { sku: null, qty: 1, bruttoGr: 1200, stawkaVat: '23', wysylka: true }] }))
    expect(kody(b)).toEqual([
      ['INNE', 'pozycja-tylko-u-nas'],
      ['INNE', 'pozycja-tylko-w-bl'],
    ])
    const c = porownajFakture(nasza([linia(), wys()]), bl({ pozycje: [{ sku: 'A1', qty: 2, bruttoGr: 2000, stawkaVat: '23', wysylka: false }, { sku: null, qty: 1, bruttoGr: 2000, stawkaVat: '23', wysylka: false }, { sku: null, qty: 1, bruttoGr: 1200, stawkaVat: '23', wysylka: true }] }))
    expect(kody(c)).toEqual([
      ['INNE', 'pozycja-bl-bez-sku'],
      ['INNE', 'liczba-pozycji'],
      ['INNE', 'kwota-pozycji'],
    ])
  })

  it('kwota pozycji: kompensujące się różnice dwóch SKU to nie zgodność, tolerancja jak na sumach', () => {
    const n = nasza([linia({ sztukOferty: 1, ilosc: 1, cenaBruttoGr: 2000, bruttoGr: 2000 }), linia({ sku: 'B2', pozycja: 1, sztukOferty: 1, ilosc: 1, cenaBruttoGr: 1000, bruttoGr: 1000 })], { nettoGr: 2439 })
    const bl2 = (a: number, b: number): FakturaBl => ({ pozycje: [{ sku: 'A1', qty: 1, bruttoGr: a, stawkaVat: '23', wysylka: false }, { sku: 'B2', qty: 1, bruttoGr: b, stawkaVat: '23', wysylka: false }], bruttoGr: 3000, nettoGr: 2439, forma: 'transfer' })
    const r = porownajFakture(n, bl2(1500, 1500))
    expect(kody(r)).toEqual([
      ['INNE', 'kwota-pozycji'],
      ['INNE', 'kwota-pozycji'],
    ])
    expect(r.roznice[0]).toMatchObject({ sku: 'A1', nasze: 2000, bl: 1500 })
    expect(porownajFakture(n, bl2(2001, 999)).wynik).toBe('ZGODNA')
  })

  it('kwota pozycji: zestaw składany do jednej linii BL porównuje sumę składników', () => {
    const n = nasza([linia({ sku: 'S1', zestawSku: 'Z1', ilosc: 2, sztukOferty: 2, bruttoGr: 3000 }), linia({ sku: 'S2', zestawSku: 'Z1', ilosc: 2, sztukOferty: 2, bruttoGr: 1000, stawkaVat: '5' })], { nettoGr: 3391 })
    const r = porownajFakture(n, { pozycje: [{ sku: 'Z1', qty: 2, bruttoGr: 3900, stawkaVat: '23', wysylka: false }, { sku: null, qty: 1, bruttoGr: 100, stawkaVat: '23', wysylka: true }], bruttoGr: 4000, nettoGr: 3391, forma: 'transfer' })
    expect(r.roznice[0]).toMatchObject({ kod: 'kwota-pozycji', sku: 'Z1', nasze: 4000, bl: 3900 })
  })

  it('oferta dzielona na dwie linie groszowe i sztuki oferty liczą się raz', () => {
    const l = [linia({ ilosc: 2, sztukOferty: 1, cenaBruttoGr: 333, bruttoGr: 666 }), linia({ ilosc: 1, sztukOferty: 1, cenaBruttoGr: 334, bruttoGr: 334 })]
    const r = porownajFakture(nasza(l, { nettoGr: 813 }), { pozycje: [{ sku: 'A1', qty: 1, bruttoGr: 1000, stawkaVat: '23', wysylka: false }], bruttoGr: 1000, nettoGr: 813, forma: 'transfer' })
    expect(r.wynik).toBe('ZGODNA')
  })

  it('zestaw: BL jedną linią po SKU zestawu = zgodne; BL po składnikach też', () => {
    const l = [linia({ sku: 'S1', zestawSku: 'Z1', ilosc: 2, sztukOferty: 2, bruttoGr: 3000 }), linia({ sku: 'S2', zestawSku: 'Z1', ilosc: 2, sztukOferty: 2, bruttoGr: 1000, stawkaVat: '5' })]
    const n = nasza(l, { nettoGr: 3391 })
    expect(porownajFakture(n, { pozycje: [{ sku: 'Z1', qty: 2, bruttoGr: 4000, stawkaVat: '23', wysylka: false }], bruttoGr: 4000, nettoGr: 3391, forma: 'transfer' }).wynik).toBe('ZGODNA')
    expect(porownajFakture(n, { pozycje: [{ sku: 'S1', qty: 2, bruttoGr: 3000, stawkaVat: '23', wysylka: false }, { sku: 'S2', qty: 2, bruttoGr: 1000, stawkaVat: '5', wysylka: false }], bruttoGr: 4000, nettoGr: 3391, forma: 'transfer' }).wynik).toBe('ZGODNA')
  })

  it('brak powiązania z naszej strony to różnica w swojej kategorii, bez dubla pozycji', () => {
    const n = nasza([linia({ goodId: null }), wys()], { problemy: [{ kategoria: 'BRAK_POWIAZANIA', kod: 'brak-towaru-wfirmy', sku: 'A1' }] })
    expect(porownajFakture(n, bl())).toMatchObject({ wynik: 'ROZNICA', kategorie: ['BRAK_POWIAZANIA'] })
  })

  it('forma płatności: inna = INNE; nieznana po stronie BL nie jest różnicą', () => {
    expect(kody(porownajFakture(nasza([linia(), wys()], { forma: 'cod' }), bl()))).toEqual([['INNE', 'forma-platnosci']])
    expect(porownajFakture(nasza([linia(), wys()]), bl({ forma: null })).wynik).toBe('ZGODNA')
  })

  it('kopia BL bez pozycji: tylko sumy; bez sum: BEZ_DANYCH', () => {
    expect(porownajFakture(nasza([linia(), wys()]), bl({ pozycje: null }))).toMatchObject({ wynik: 'ZGODNA', zakres: 'SUMY' })
    expect(porownajFakture(nasza([linia(), wys()]), bl({ pozycje: null, bruttoGr: 7000 }))).toMatchObject({ wynik: 'ROZNICA', zakres: 'SUMY', kategorie: ['INNE'] })
    expect(porownajFakture(nasza([linia(), wys()]), { pozycje: null, bruttoGr: null, nettoGr: null, forma: null })).toMatchObject({ wynik: 'BEZ_DANYCH', zakres: 'BRAK' })
  })
})

describe('próg zgodności', () => {
  it('domyślnie 99%, liczony bez BEZ_DANYCH', () => {
    expect(PROG_ZGODNOSCI_PROCENT).toBe(99)
    expect(progSpelniony(procentZgodnych(99, 1))).toBe(true)
    expect(progSpelniony(procentZgodnych(98, 2))).toBe(false)
    expect(procentZgodnych(0, 0)).toBeNull()
    expect(progSpelniony(null)).toBe(false)
  })
})
