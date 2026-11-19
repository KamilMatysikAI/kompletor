// rabat na całe zamówienie (Woo) na dokumencie sprzedaży. Pełna droga bez bazy: odpowiedź WC REST v3
// w kształcie sklepu → `wooOrderFromApi` → pozycje dokumentu (jak `pozycjeZamowienia`) → `zlozPozycjeDokumentu` /
// `zlozFakture`. Dane fikcyjne. Liczby przypadku „ujemna opłata 10%” odtwarzają wzór z podglądu faktur (ceny
// 15,99 / 24,77 / 11,49 / 18,97 / 26,38 / 4,70 → BL 14,40 / 22,29 / 10,34 / 17,07 / 23,74 / 4,23).
import { describe, expect, it } from 'vitest'
import { wooOrderFromApi } from '../adaptery/woo'
import { cenaPoRabacieGr } from '../rdzen/ceny'
import { zlozFakture } from '../wfirma/faktura'
import { parseKonfiguracjaFaktur } from '../wfirma/konfiguracja'
import { porownajFakture, type PozycjaBl } from '../wfirma/porownanie'
import { type PozycjaZamowienia, towaryPoRabacieGr, zlozPozycjeDokumentu } from './pozycje'

/** Kwota brutto (grosze) jako para netto + VAT 23% w tekstach Woo (`total`, `total_tax`). */
function kwota(bruttoGr: number): { total: string; total_tax: string } {
  const netto = Math.round(bruttoGr / 1.23)
  return { total: (netto / 100).toFixed(2), total_tax: ((bruttoGr - netto) / 100).toFixed(2) }
}

interface Linia {
  qty: number
  /** wartość pozycji brutto PO kuponie WooCommerce (`total` + `total_tax`), grosze */
  poKuponieGr: number
  /** wartość przed kuponem (`subtotal` + `subtotal_tax`), grosze; brak = jak po kuponie */
  przedKuponemGr?: number
}

function woo(linie: Linia[], o: { wysylkaGr?: number; oplatyGr?: number[]; kupony?: string[] } = {}): Record<string, unknown> {
  const wys = o.wysylkaGr ?? 0
  const oplaty = o.oplatyGr ?? []
  const totalGr = linie.reduce((s, l) => s + l.poKuponieGr, 0) + wys + oplaty.reduce((s, x) => s + x, 0)
  const sw = kwota(wys)
  return {
    id: 9001,
    status: 'processing',
    currency: 'PLN',
    date_created_gmt: '2026-11-06T09:00:00',
    date_modified_gmt: '2026-11-06T09:05:00',
    date_paid_gmt: '2026-11-06T09:01:00',
    payment_method: 'blik',
    payment_method_title: 'Blik',
    total: (totalGr / 100).toFixed(2),
    shipping_total: sw.total,
    shipping_tax: sw.total_tax,
    discount_total: '0.00',
    line_items: linie.map((l, i) => {
      const po = kwota(l.poKuponieGr)
      const przed = kwota(l.przedKuponemGr ?? l.poKuponieGr)
      return { id: 100 + i, product_id: 10 + i, variation_id: 0, quantity: l.qty, subtotal: przed.total, subtotal_tax: przed.total_tax, total: po.total, total_tax: po.total_tax, sku: `T${i}`, name: `Towar ${i}`, meta_data: [] }
    }),
    fee_lines: oplaty.map((g, i) => ({ id: 500 + i, name: g < 0 ? 'Rabat' : 'Opłata', ...kwota(g) })),
    coupon_lines: (o.kupony ?? []).map((code, i) => ({ id: 600 + i, code })),
    shipping_lines: [{ method_title: 'Paczkomaty InPost', ...kwota(wys) }],
  }
}

/** Pozycje dokumentu z zamówienia kanału (tak jak `pozycjeZamowienia` z wierszy bazy: cena = OrderLine.unitPriceGross). */
function dokument(raw: Record<string, unknown>, opts: { bezKosztu?: boolean } = {}) {
  const o = wooOrderFromApi(raw)
  const pozycje: PozycjaZamowienia[] = o.lines.map((l, i) => ({ sku: `T${i}`, rodzaj: 'STOCKED', nazwa: `Towar ${i}`, jednostka: 'SZT', wfirmaGoodId: String(1000 + i), qty: l.qty, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: Math.round(l.unitPriceGross * 100), stawkaVat: '23' }))
  const d = zlozPozycjeDokumentu({ totalGross: o.totalGross, pozycje, wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' }, kosztWysylki: opts.bezKosztu ? null : (o.shippingCostGross ?? null) })
  return { o, pozycje, d, totalGr: Math.round(o.totalGross * 100) }
}

const wartosciPozycji = (d: ReturnType<typeof zlozPozycjeDokumentu>) => {
  const m = new Map<number, number>()
  for (const l of d.linie) if (!l.wysylka) m.set(l.pozycja, (m.get(l.pozycja) ?? 0) + l.bruttoGr)
  return [...m.values()]
}
const wysylka = (d: ReturnType<typeof zlozPozycjeDokumentu>) => d.linie.filter((l) => l.wysylka).reduce((s, l) => s + l.bruttoGr, 0)

describe('rabat na zamówienie Woo na dokumencie', () => {
  it('kupon WooCommerce 10% na wszystko: cena pozycji już po kuponie (total), dokument = kwota zapłacona', () => {
    const { o, d, totalGr } = dokument(woo([{ qty: 1, poKuponieGr: 1439, przedKuponemGr: 1599 }, { qty: 1, poKuponieGr: 2229, przedKuponemGr: 2477 }], { kupony: ['JESIEN10'] }))
    expect(o.lines.map((l) => l.unitPriceGross)).toEqual([14.39, 22.29])
    expect(d.problemy.filter((p) => p.kod !== 'brak-towaru-wfirmy')).toEqual([])
    expect(d.bruttoGr).toBe(totalGr)
    expect(wysylka(d)).toBe(0)
  })

  it('kupon na część pozycji z resztą groszy (3 szt. za 64,75 zł): bez groszowej „wysyłki”, reszta na pierwszej pozycji', () => {
    const { d, totalGr } = dokument(woo([{ qty: 3, poKuponieGr: 6475, przedKuponemGr: 7191 }, { qty: 1, poKuponieGr: 4797 }], { kupony: ['KUPON5'] }))
    expect(d.problemy).toEqual([])
    expect(d.linie.some((l) => l.wysylka)).toBe(false)
    expect(wartosciPozycji(d)).toEqual([6475, 4797])
    expect(d.bruttoGr).toBe(totalGr)
  })

  it('ujemna opłata −10% (rabat spoza pozycji): ceny po rabacie, reszta 1 gr na pierwszej pozycji — jak faktura BL', () => {
    const ceny = [1599, 2477, 1149, 1897, 2638, 470]
    const { o, d, totalGr } = dokument(woo(ceny.map((c) => ({ qty: 1, poKuponieGr: c })), { oplatyGr: [-1023] }))
    expect(totalGr).toBe(9207)
    expect(o.lines.map((l) => l.unitPriceGross)).toEqual([14.39, 22.29, 10.34, 17.07, 23.74, 4.23])
    expect(o.warnings.join(' ')).toContain('rabat na zamówienie 10.23 zł')
    expect(d.problemy).toEqual([])
    expect(wartosciPozycji(d)).toEqual([1440, 2229, 1034, 1707, 2374, 423])
    expect(wysylka(d)).toBe(0)
    expect(d.bruttoGr).toBe(9207)
  })

  it('ujemna opłata −4% z wysyłką: wysyłka = koszt z kanału, towary = kwota − wysyłka (wzór 0,96)', () => {
    const { d, totalGr } = dokument(woo([{ qty: 1, poKuponieGr: 3491 }, { qty: 1, poKuponieGr: 4670 }, { qty: 1, poKuponieGr: 2090 }], { oplatyGr: [-410], wysylkaGr: 1299 }))
    expect(d.problemy).toEqual([])
    expect(wartosciPozycji(d)).toEqual([3352, 4483, 2006])
    expect(wysylka(d)).toBe(1299)
    expect(d.bruttoGr).toBe(totalGr)
  })

  it('rabat kwotowy 15 zł na pozycje po kilka sztuk: suma co do grosza, cena reszty rozpisana na dwie linie', () => {
    const { o, d, totalGr } = dokument(woo([{ qty: 2, poKuponieGr: 5000 }, { qty: 3, poKuponieGr: 5997 }], { oplatyGr: [-1500], wysylkaGr: 1299 }))
    expect(o.lines.map((l) => l.unitPriceGross)).toEqual([21.59, 17.26])
    expect(d.problemy).toEqual([])
    expect(wartosciPozycji(d)).toEqual([4319, 5178])
    expect(d.linie.filter((l) => l.pozycja === 0).map((l) => [l.ilosc, l.cenaBruttoGr])).toEqual([[1, 2159], [1, 2160]])
    expect(wysylka(d)).toBe(1299)
    expect(d.bruttoGr).toBe(totalGr)
  })

  it('darmowa wysyłka z kuponu (shipping_total 0): bez linii wysyłki, dokument = kwota', () => {
    const { d, totalGr } = dokument(woo([{ qty: 1, poKuponieGr: 8670 }, { qty: 1, poKuponieGr: 2590 }], { wysylkaGr: 0, kupony: ['DARMOWA'] }))
    expect(d.problemy).toEqual([])
    expect(d.linie.some((l) => l.wysylka)).toBe(false)
    expect(d.bruttoGr).toBe(totalGr)
  })

  it('mały rabat przy wysyłce (wzór 76,90 / 24,60 → 76,50 / 24,20 u nas): wysyłka zostaje kosztem z kanału', () => {
    const { d, totalGr } = dokument(woo([{ qty: 1, poKuponieGr: 7690 }, { qty: 2, poKuponieGr: 1998 }], { oplatyGr: [-40], wysylkaGr: 2460 }))
    expect(d.problemy).toEqual([])
    expect(wysylka(d)).toBe(2460)
    expect(d.bruttoGr).toBe(totalGr)
  })

  it('opłata dodatnia (pobranie 5 zł): ceny bez zmian, opłata idzie z wysyłką jak dotąd', () => {
    const { o, d, totalGr } = dokument(woo([{ qty: 1, poKuponieGr: 3000 }], { oplatyGr: [500], wysylkaGr: 1299 }))
    expect(o.lines[0]!.unitPriceGross).toBe(30)
    expect(d.problemy).toEqual([])
    expect(wartosciPozycji(d)).toEqual([3000])
    expect(wysylka(d)).toBe(1799)
    expect(d.bruttoGr).toBe(totalGr)
  })

  it('koszt wysyłki nieznany (kanał go nie podał, stare zamówienie): zachowanie', () => {
    const ceny = [1599, 2477]
    const raw = woo(ceny.map((c) => ({ qty: 1, poKuponieGr: c })), { oplatyGr: [-408] })
    // stare zamówienie: cena pozycji sprzed rabatu zapisana, bez kosztu wysyłki → problem jak dotąd
    const pozycje: PozycjaZamowienia[] = ceny.map((c, i) => ({ sku: `T${i}`, rodzaj: 'STOCKED', nazwa: `Towar ${i}`, jednostka: 'SZT', wfirmaGoodId: '1', qty: 1, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: c, stawkaVat: '23' }))
    const bez = zlozPozycjeDokumentu({ totalGross: Number(raw['total']), pozycje, wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' } })
    expect(bez.problemy.map((p) => p.kod)).toContain('pozycje-drozsze-niz-zamowienie')
    // to samo stare zamówienie z kosztem wysyłki zapisanym w Order.shippingCostGross: rabat rozłożony na dokumencie
    const z = zlozPozycjeDokumentu({ totalGross: Number(raw['total']), pozycje, wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' }, kosztWysylki: 0 })
    expect(z.problemy).toEqual([])
    expect(z.bruttoGr).toBe(Math.round(Number(raw['total']) * 100))
  })

  it('zamiennik („Zamień produkt”) przy rabacie: ta sama cena po rabacie co pozycja pierwotna, suma = kwota', () => {
    const w = { nazwa: 'Wysyłka', stawkaVat: '23' }
    const pozycje: PozycjaZamowienia[] = [
      { sku: 'P', rodzaj: 'STOCKED', nazwa: 'Pierwotna', jednostka: 'SZT', wfirmaGoodId: '1', qty: 2, qtyOdrzucone: 1, naOferte: 1, cenaBruttoGr: 2000, stawkaVat: '23', pokryte: 2 },
      { sku: 'Z', rodzaj: 'STOCKED', nazwa: 'Zamiennik', jednostka: 'SZT', wfirmaGoodId: '2', qty: 1, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 2000, stawkaVat: '23', zamiennik: null, przesuniecie: 1 },
      { sku: 'B', rodzaj: 'STOCKED', nazwa: 'Inna', jednostka: 'SZT', wfirmaGoodId: '3', qty: 1, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 1000, stawkaVat: '23' },
    ]
    const d = zlozPozycjeDokumentu({ totalGross: 45, pozycje, wysylka: w, kosztWysylki: 0 })
    expect(d.problemy).toEqual([])
    expect(d.linie.map((l) => [l.sku, l.bruttoGr])).toEqual([['P', 1800], ['Z', 1800], ['B', 900]])
    expect(d.bruttoGr).toBe(4500)
    // zamiennik z inną ceną niż pierwotna nadal zatrzymuje dokument (bezpiecznik liczony po rabacie)
    const inna = zlozPozycjeDokumentu({ totalGross: 45, pozycje: pozycje.map((p) => (p.sku === 'Z' ? { ...p, cenaBruttoGr: 2500 } : p)), wysylka: w, kosztWysylki: 0 })
    expect(inna.problemy.map((p) => p.kod)).toContain('suma-rozna-od-zamowienia')
  })

  it('faktura wFirmy z rabatem zgodna z fakturą BL w porównaniu podglądu', () => {
    const ceny = [1599, 2477, 1149, 1897, 2638, 470]
    const { o, pozycje } = dokument(woo(ceny.map((c) => ({ qty: 1, poKuponieGr: c })), { oplatyGr: [-1023] }))
    const cfg = parseKonfiguracjaFaktur({ faktury: { kodyVat: { '23': 222 } } })
    const f = zlozFakture({ idExternal: 'z/1/0', totalGross: o.totalGross, paymentMethod: 'Blik', paymentState: 'PAID', pozycje, konfiguracja: cfg, kosztWysylki: o.shippingCostGross ?? null })
    expect(f.problemy).toEqual([])
    const bl: PozycjaBl[] = [1440, 2229, 1034, 1707, 2374, 423].map((g, i) => ({ sku: `T${i}`, qty: 1, bruttoGr: g, stawkaVat: '23', wysylka: false }))
    expect(porownajFakture(f, { pozycje: bl, bruttoGr: 9207, nettoGr: f.nettoGr, forma: 'transfer' }).wynik).toBe('ZGODNA')
  })
})

describe('reguła rozkładu rabatu (cenaPoRabacieGr, towaryPoRabacieGr)', () => {
  it('cena × po / przed, do grosza; bez rabatu bez zmian', () => {
    expect(cenaPoRabacieGr(1599, 10230, 9207)).toBe(1439)
    expect(cenaPoRabacieGr(2001, 11230, 10556)).toBe(1881)
    expect(cenaPoRabacieGr(1234, 0, 0)).toBe(1234)
    expect(cenaPoRabacieGr(1234, 5000, 5000)).toBe(1234)
  })

  it('towary po rabacie: koszt nieznany = null; nadwyżka do pół grosza na sztukę = reszta; większa = dopłata (null)', () => {
    expect(towaryPoRabacieGr({ totalGross: 92.07, kosztWysylki: null }, 10230, 6)).toBeNull()
    expect(towaryPoRabacieGr({ totalGross: 92.07 }, 10230, 6)).toBeNull()
    expect(towaryPoRabacieGr({ totalGross: 92.07, kosztWysylki: 0 }, 10230, 6)).toBe(9207)
    expect(towaryPoRabacieGr({ totalGross: 102.3, kosztWysylki: 0 }, 10230, 6)).toBeNull()
    expect(towaryPoRabacieGr({ totalGross: 102.33, kosztWysylki: 0 }, 10230, 6)).toBe(10233)
    expect(towaryPoRabacieGr({ totalGross: 102.34, kosztWysylki: 0 }, 10230, 6)).toBeNull()
    expect(towaryPoRabacieGr({ totalGross: 10, kosztWysylki: 12.99 }, 10230, 6)).toBeNull()
  })

  it('losowo 5000 zamówień z rabatem: dokument zawsze = kwota co do grosza, wysyłka = koszt, bez problemów', () => {
    let ziarno = 239
    const los = (n: number) => {
      ziarno = (ziarno * 1103515245 + 12345) % 2147483648
      return ziarno % n
    }
    for (let k = 0; k < 5000; k++) {
      const linie = Array.from({ length: 1 + los(8) }, () => {
        const qty = 1 + los(5)
        return { qty, poKuponieGr: qty * (100 + los(20000)) + (los(3) === 0 ? los(qty) : 0) }
      })
      const suma = linie.reduce((s, l) => s + l.poKuponieGr, 0)
      const rabat = los(2) ? Math.min(suma - 1, 1 + los(Math.max(1, Math.floor(suma / 3)))) : 0
      const wys = los(3) ? 0 : 999 + los(2000)
      const { d, totalGr } = dokument(woo(linie, { oplatyGr: rabat ? [-rabat] : [], wysylkaGr: wys }))
      expect(d.problemy, `zamówienie ${k}`).toEqual([])
      expect(d.bruttoGr, `zamówienie ${k}`).toBe(totalGr)
      expect(wysylka(d), `zamówienie ${k}`).toBe(wys)
    }
  })
})
