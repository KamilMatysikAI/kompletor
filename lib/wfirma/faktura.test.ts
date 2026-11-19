// składanie faktury „przygotuj, nie wystawiaj”, mapowanie płatności, konfiguracja. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { type PozycjaZamowienia, type WejscieFaktury, zlozFakture } from './faktura'
import { parseKonfiguracjaFaktur } from './konfiguracja'
import { formaPlatnosci } from './platnosci'

const cfg = parseKonfiguracjaFaktur({ faktury: { seriaId: '77', kodyVat: { '23': 1001, '8': 1002, '5': 1003, '0': 1004 } } })

const poz = (o: Partial<PozycjaZamowienia> = {}): PozycjaZamowienia => ({
  sku: 'A1',
  rodzaj: 'STOCKED',
  nazwa: 'Towar testowy A1',
  jednostka: 'SZT',
  wfirmaGoodId: '500',
  qty: 2,
  qtyOdrzucone: 0,
  naOferte: 1,
  cenaBruttoGr: 2000,
  stawkaVat: '23',
  ...o,
})
const wej = (o: Partial<WejscieFaktury> = {}): WejscieFaktury => ({ idExternal: 'zam1/1/0', totalGross: 40, paymentMethod: 'BLIK', paymentState: 'PAID', pozycje: [poz()], konfiguracja: cfg, ...o })

const kody = (w: WejscieFaktury) => zlozFakture(w).problemy.map((p) => p.kod)
const pozycjeTresci = (f: ReturnType<typeof zlozFakture>) => Object.values(f.tresc!.invoices.invoice['invoicecontents'] as Record<string, { invoicecontent: Record<string, unknown> }>).map((x) => x.invoicecontent)

describe('zlozFakture', () => {
  it('treść: typ, seria, id_external, płatność, towar z good.id i kodem VAT z konfiguracji; bez kontrahenta', () => {
    const f = zlozFakture(wej())
    expect(f.problemy).toEqual([])
    expect(f.tresc!.invoices.invoice).toMatchObject({ type: 'normal', price_type: 'brutto', paymentmethod: 'transfer', id_external: 'zam1/1/0', series: { id: '77' } })
    expect(f.tresc!.invoices.invoice).not.toHaveProperty('contractor')
    expect(pozycjeTresci(f)).toEqual([{ good: { id: 500 }, name: 'Towar testowy A1', count: '2.0000', unit: 'szt.', price: '20.00', vat_code: { id: 1001 } }])
    expect(f.bruttoGr).toBe(4000)
    expect(f.nettoGr).toBe(3252)
  })

  it('kontrahent tylko z argumentu', () => {
    expect(zlozFakture(wej({ kontrahent: { name: 'Firma Fikcyjna' } })).tresc!.invoices.invoice['contractor']).toEqual({ name: 'Firma Fikcyjna' })
  })

  it('wysyłka: różnica do kwoty zamówienia jako good.id=0 ze stawką z konfiguracji', () => {
    const f = zlozFakture(wej({ totalGross: 52.99 }))
    expect(f.linie.at(-1)).toMatchObject({ wysylka: true, goodId: 0, bruttoGr: 1299, stawkaVat: '23' })
    expect(pozycjeTresci(f).at(-1)).toMatchObject({ good: { id: 0 }, name: 'Wysyłka', price: '12.99' })
    expect(f.bruttoGr).toBe(5299)
  })

  it('bez wysyłki, gdy pozycje dają całą kwotę', () => {
    expect(zlozFakture(wej()).linie.some((l) => l.wysylka)).toBe(false)
  })

  it('zaokrąglenia: oferta na kilka sztuk bazowych dzieli się na dwie linie, suma co do grosza', () => {
    const f = zlozFakture(wej({ totalGross: 10, pozycje: [poz({ qty: 3, naOferte: 3, cenaBruttoGr: 1000 })] }))
    expect(f.problemy).toEqual([])
    expect(f.linie.map((l) => [l.ilosc, l.cenaBruttoGr])).toEqual([
      [2, 333],
      [1, 334],
    ])
    expect(f.bruttoGr).toBe(1000)
  })

  it('kilogramy: ilość w kg, cena za kg, oferta 50 g liczona za sztukę oferty', () => {
    const f = zlozFakture(wej({ totalGross: 25, pozycje: [poz({ jednostka: 'KG', qty: 100, naOferte: 50, cenaBruttoGr: 1250 })] }))
    expect(f.problemy).toEqual([])
    expect(f.linie[0]).toMatchObject({ ilosc: 0.1, jednostka: 'kg', cenaBruttoGr: 25000, bruttoGr: 2500, sztukOferty: 2 })
  })

  it('reszta ułamkowej ilości idzie do wysyłki, suma równa totalGross', () => {
    // 2,5 kg za 10,01 zł: żadna cena nie trafia w grosz (400 → 10,00; 401 → 10,03; 399 → 9,98), reszta 1 gr
    const towar = poz({ jednostka: 'KG', qty: 2500, naOferte: 2500, cenaBruttoGr: 1001 })
    const f = zlozFakture(wej({ totalGross: 15.01, pozycje: [towar] }))
    expect(f.problemy).toEqual([])
    expect(f.linie.map((l) => [l.ilosc, l.cenaBruttoGr, l.bruttoGr, !!l.wysylka])).toEqual([
      [2.5, 400, 1000, false],
      [1, 501, 501, true],
    ])
    expect(f.bruttoGr).toBe(1501)
  })

  it('reszta ułamkowej ilości bez wysyłki = problem, faktury nie ma', () => {
    const towar = poz({ jednostka: 'KG', qty: 2500, naOferte: 2500, cenaBruttoGr: 1001 })
    const f = zlozFakture(wej({ totalGross: 10.01, pozycje: [towar] }))
    expect(f.problemy.map((p) => [p.kategoria, p.kod, p.nasze])).toEqual([['ZAOKRAGLENIE', 'reszta-bez-wysylki', 1]])
    expect(f.tresc).toBeNull()
  })

  it('brak stawki VAT = problem jawny, także na składniku zestawu', () => {
    expect(zlozFakture(wej({ pozycje: [poz({ stawkaVat: null })] })).problemy).toEqual([{ kategoria: 'VAT', kod: 'brak-stawki', sku: 'A1' }])
    const skladniki = [{ sku: 'S1', nazwa: 'S', jednostka: 'SZT' as const, wfirmaGoodId: '601', qty: 1, cenaDetalicznaBrutto: 30, stawkaVat: null }]
    const f = zlozFakture(wej({ totalGross: 33, pozycje: [poz({ sku: 'Z1', rodzaj: 'BUNDLE', wfirmaGoodId: null, qty: 1, cenaBruttoGr: 3300, stawkaVat: null, skladniki })] }))
    expect(f.problemy).toEqual([{ kategoria: 'VAT', kod: 'brak-stawki', sku: 'S1' }])
    expect(f.tresc).toBeNull()
  })

  it('zestaw rozbity wg splitBundlePrice, VAT składników, suma równa cenie zestawu', () => {
    const skladniki = [
      { sku: 'S1', nazwa: 'Składnik 1', jednostka: 'SZT' as const, wfirmaGoodId: '601', qty: 1, cenaDetalicznaBrutto: 30, stawkaVat: '23' },
      { sku: 'S2', nazwa: 'Składnik 2', jednostka: 'SZT' as const, wfirmaGoodId: '602', qty: 1, cenaDetalicznaBrutto: 10, stawkaVat: '5' },
    ]
    const f = zlozFakture(wej({ totalGross: 66, pozycje: [poz({ sku: 'Z1', rodzaj: 'BUNDLE', wfirmaGoodId: null, qty: 2, cenaBruttoGr: 3300, stawkaVat: null, skladniki })] }))
    expect(f.problemy).toEqual([])
    expect(f.linie.map((l) => [l.sku, l.zestawSku, l.ilosc, l.cenaBruttoGr, l.stawkaVat])).toEqual([
      ['S1', 'Z1', 2, 2475, '23'],
      ['S2', 'Z1', 2, 825, '5'],
    ])
    expect(f.bruttoGr).toBe(6600)
  })

  it('zestaw bez ceny do rozbicia i składnik bez powiązania = problemy jawne', () => {
    const c = { sku: 'S1', nazwa: 'S', jednostka: 'SZT' as const, wfirmaGoodId: null, qty: 1, cenaDetalicznaBrutto: 30, stawkaVat: '23' }
    expect(kody(wej({ pozycje: [poz({ sku: 'Z1', rodzaj: 'BUNDLE', skladniki: [] })] }))).toContain('zestaw-bez-rozbicia')
    expect(kody(wej({ pozycje: [poz({ sku: 'Z1', rodzaj: 'BUNDLE', wfirmaGoodId: null, qty: 1, totalGross: 20, skladniki: [c] } as Partial<PozycjaZamowienia>)], totalGross: 20 }))).toContain('brak-towaru-wfirmy')
  })

  it('pozycja RECZNA z katalogu idzie jak każda inna; produkt bez stanu jako usługa', () => {
    const f = zlozFakture(wej({ totalGross: 60, pozycje: [poz(), poz({ sku: 'E1', rodzaj: 'DIGITAL', wfirmaGoodId: '900', qty: 1, stawkaVat: '5' })] }))
    expect(f.problemy).toEqual([])
    expect(f.linie[1]).toMatchObject({ usluga: true, goodId: 900, stawkaVat: '5' })
  })

  it('usługa bez odpowiednika w wFirmie: good.id=0 z nazwy pozycji, bez problemu (15.1)', () => {
    const f = zlozFakture(wej({ totalGross: 20, pozycje: [poz({ sku: 'E1', rodzaj: 'DIGITAL', wfirmaGoodId: null, qty: 1 })] }))
    expect(f.problemy).toEqual([])
    expect(f.linie[0]).toMatchObject({ goodId: 0, usluga: true })
  })

  it('brak powiązania z wFirmą i pozycja bez produktu: błąd jawny, treści nie ma', () => {
    const a = zlozFakture(wej({ pozycje: [poz({ wfirmaGoodId: null })] }))
    expect(a.tresc).toBeNull()
    expect(a.problemy).toEqual([{ kategoria: 'BRAK_POWIAZANIA', kod: 'brak-towaru-wfirmy', sku: 'A1' }])
    expect(kody(wej({ pozycje: [poz({ sku: null, rodzaj: null, wfirmaGoodId: null })] }))).toEqual(['pozycja-bez-produktu'])
  })

  it('stawki 0%, 5% i 8% mają swoje kody; stawka bez kodu = problem VAT', () => {
    for (const [s, id] of [['0', 1004], ['5.00', 1003], ['8', 1002]] as const) expect(pozycjeTresci(zlozFakture(wej({ pozycje: [poz({ stawkaVat: s })] })))[0]).toMatchObject({ vat_code: { id } })
    expect(zlozFakture(wej({ pozycje: [poz({ stawkaVat: '0' })] })).nettoGr).toBe(4000)
    expect(kody(wej({ pozycje: [poz({ stawkaVat: '7' })] }))).toEqual(['brak-kodu-vat'])
  })

  it('pozycja odrzucona nie wchodzi na fakturę ani do wysyłki', () => {
    const f = zlozFakture(wej({ totalGross: 52, pozycje: [poz({ qtyOdrzucone: 1 })] }))
    expect(f.problemy).toEqual([])
    expect(f.linie[0]).toMatchObject({ ilosc: 1 })
    expect(f.linie[1]).toMatchObject({ wysylka: true, bruttoGr: 1200 })
    expect(f.bruttoGr).toBe(3200)
  })

  it('pozycje droższe niż zamówienie (rabat na zamówieniu) i nieznana płatność = problemy', () => {
    expect(kody(wej({ totalGross: 30 }))).toEqual(['pozycje-drozsze-niz-zamowienie'])
    expect(kody(wej({ paymentMethod: 'Bitcoin' }))).toEqual(['nieznana-platnosc'])
    expect(kody(wej({ pozycje: [], totalGross: 0 }))).toContain('nic-do-faktury')
  })
})

describe('formaPlatnosci', () => {
  it.each([
    ['BLIK', 'transfer'],
    ['Płatność PayU', 'transfer'],
    ['PayPo', 'transfer'],
    ['PayPal', 'transfer'],
    ['Allegro Finance', 'transfer'],
    ['Przelew tradycyjny', 'transfer'],
    ['Przelewy24', 'transfer'],
    ['Pobranie', 'cod'],
    ['Płatność przy odbiorze', 'cod'],
    ['cod', 'cod'],
    ['Płatność z góry', 'transfer'],
  ])('%s → %s', (m, f) => expect(formaPlatnosci(m, 'PAID')).toBe(f))

  it('stan COD rozstrzyga, nieznana i pusta metoda = null', () => {
    expect(formaPlatnosci('Cokolwiek', 'COD')).toBe('cod')
    expect(formaPlatnosci('Bitcoin', 'PAID')).toBeNull()
    expect(formaPlatnosci('', 'PAID')).toBeNull()
  })

  it('reguła firmy dopisuje metodę i ma pierwszeństwo przed domyślną', () => {
    // metoda z adaptera Allegro „ONLINE (operator)” = zapłacone z góry
    expect(formaPlatnosci('ONLINE (AF)', 'PAID')).toBe('transfer')
    expect(formaPlatnosci('ONLINE (P24)', 'PAID')).toBe('transfer')
    expect(formaPlatnosci('ONLINE', 'UNPAID')).toBe('transfer')
    expect(formaPlatnosci('CASH_ON_DELIVERY', 'COD')).toBe('cod')
    expect(formaPlatnosci('ONLINE (AF)', 'PAID', parseKonfiguracjaFaktur({ faktury: { platnosci: [{ zawiera: 'online', forma: 'payment_card' }] } }).platnosci)).toBe('payment_card')
    const c = parseKonfiguracjaFaktur({ faktury: { platnosci: [{ zawiera: 'empik', forma: 'transfer' }, { zawiera: 'blik', forma: 'payment_card' }, { zawiera: 'x', forma: 'zła' }] } })
    expect(formaPlatnosci('Empik', 'PAID', c.platnosci)).toBe('transfer')
    expect(formaPlatnosci('BLIK', 'PAID', c.platnosci)).toBe('payment_card')
    expect(c.platnosci.some((r) => r.zawiera === 'x')).toBe(false)
  })
})

describe('parseKonfiguracjaFaktur', () => {
  it('puste ustawienia: bez serii i kodów VAT (dane konta nie są stałymi w kodzie), wysyłka 23%', () => {
    expect(parseKonfiguracjaFaktur(null)).toMatchObject({ seriaId: null, kodyVat: {}, wysylka: { nazwa: 'Wysyłka', stawkaVat: '23' } })
  })
})
