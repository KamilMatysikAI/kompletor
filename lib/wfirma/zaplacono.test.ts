// faktura zamówienia opłaconego z góry wychodzi do wFirmy jako opłacona (`alreadypaid_initial` = kwota
// faktury, `paymentdate` = dzień wystawienia), pobranie i nieopłacone zostają „do zapłaty”, wpłata częściowa = kwota
// wpłacona. Pole z dokumentacji API wFirmy, moduł `invoices`: „alreadypaid_initial — Kwota zapłacono określona przy
// dodawaniu i modyfikowaniu faktury. Kwota jest widoczna na wydruku faktury.” Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { type PozycjaZamowienia, type WejscieFaktury, zlozFakture } from './faktura'
import { parseKonfiguracjaFaktur } from './konfiguracja'
import { dzienWystawienia, zaplaconoDoFaktury } from './platnosci'

const cfg = parseKonfiguracjaFaktur({ faktury: { kodyVat: { '23': 1001 } } })
const poz: PozycjaZamowienia = { sku: 'A1', rodzaj: 'STOCKED', nazwa: 'Towar testowy A1', jednostka: 'SZT', wfirmaGoodId: '500', qty: 2, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 2000, stawkaVat: '23' }
const wej = (o: Partial<WejscieFaktury> = {}): WejscieFaktury => ({ idExternal: 'zam1/1/1', totalGross: 40, paymentMethod: 'BLIK', paymentState: 'PAID', pozycje: [poz], konfiguracja: cfg, ...o })
const inv = (w: WejscieFaktury) => zlozFakture(w).tresc!.invoices.invoice

describe('zlozFakture: kwota zapłacona przy wystawieniu', () => {
  it('PAID, zapłacone w całości: alreadypaid_initial = brutto faktury, termin płatności = dzień wystawienia', () => {
    const i = inv(wej({ zaplacono: 'CALOSC', dataWystawienia: '2026-11-20' }))
    expect(i).toMatchObject({ paymentmethod: 'transfer', alreadypaid_initial: '40.00', paymentdate: '2026-11-20' })
  })

  it('wpłata większa niż faktura (np. paczka 1 przy podziale) liczy się do kwoty faktury', () => {
    expect(inv(wej({ zaplacono: 9999, dataWystawienia: '2026-11-20' }))).toMatchObject({ alreadypaid_initial: '40.00', paymentdate: '2026-11-20' })
  })

  it('PARTIAL: kwota wpłacona, termin płatności zostaje domyślny wFirmy', () => {
    const i = inv(wej({ paymentState: 'PARTIAL', zaplacono: 1500, dataWystawienia: '2026-11-20' }))
    expect(i['alreadypaid_initial']).toBe('15.00')
    expect(i).not.toHaveProperty('paymentdate')
  })

  it('UNPAID (0 zł) i brak informacji: bez pól zapłaty (jak przed zmianą)', () => {
    for (const w of [wej({ paymentState: 'UNPAID', zaplacono: 0, dataWystawienia: '2026-11-20' }), wej()]) {
      const i = inv(w)
      expect(i).not.toHaveProperty('alreadypaid_initial')
      expect(i).not.toHaveProperty('paymentdate')
    }
  })

  it('COD: forma „pobranie”, do zapłaty w całości, nawet gdy ktoś poda zapłatę', () => {
    const i = inv(wej({ paymentState: 'COD', paymentMethod: 'Za pobraniem', zaplacono: 'CALOSC', dataWystawienia: '2026-11-20' }))
    expect(i['paymentmethod']).toBe('cod')
    expect(i).not.toHaveProperty('alreadypaid_initial')
    expect(i).not.toHaveProperty('paymentdate')
  })

  it('zapłacone w całości bez daty wystawienia: kwota jest, terminu nie zgadujemy', () => {
    const i = inv(wej({ zaplacono: 'CALOSC' }))
    expect(i['alreadypaid_initial']).toBe('40.00')
    expect(i).not.toHaveProperty('paymentdate')
  })

  it('wynik składania podaje kwotę zapłaconą w groszach (podgląd, log)', () => {
    expect(zlozFakture(wej({ zaplacono: 'CALOSC' })).zaplaconoGr).toBe(4000)
    expect(zlozFakture(wej({ paymentState: 'COD', zaplacono: 'CALOSC' })).zaplaconoGr).toBe(0)
    expect(zlozFakture(wej()).zaplaconoGr).toBe(0)
  })
})

describe('zaplaconoDoFaktury: ile zapłacono przed wystawieniem (dane zamówienia w Kompletorze)', () => {
  const o = (paymentState: WejscieFaktury['paymentState'], over: { totalGross?: number; flags?: unknown; parentOrderId?: string | null } = {}) => ({ paymentState, totalGross: 40, flags: {}, parentOrderId: null, ...over })
  it('PAID bez edycji i bez wpisów płatności: w całości', () => {
    expect(zaplaconoDoFaktury(o('PAID'), [])).toBe('CALOSC')
  })
  it('COD i UNPAID bez wpisów: 0', () => {
    expect(zaplaconoDoFaktury(o('COD'), [])).toBe(0)
    expect(zaplaconoDoFaktury(o('UNPAID'), [])).toBe(0)
  })
  it('PARTIAL: tylko wpłaty zapisane w Kompletorze (kwoty niedopłaty z kanału Kompletor nie przechowuje)', () => {
    expect(zaplaconoDoFaktury(o('PARTIAL'), [])).toBe(0)
    expect(zaplaconoDoFaktury(o('PARTIAL'), [{ kind: 'WPLATA', amount: 10 }])).toBe(1000)
  })
  it('PAID po edycji karty: kwota sprzed edycji plus dopłaty minus zwroty', () => {
    expect(zaplaconoDoFaktury(o('PAID', { totalGross: 50, flags: { kwotaZaplacona: '40.00' } }), [])).toBe(4000)
    expect(zaplaconoDoFaktury(o('PAID', { totalGross: 50, flags: { kwotaZaplacona: '40.00' } }), [{ kind: 'DOPLATA', amount: 10 }])).toBe(5000)
    expect(zaplaconoDoFaktury(o('PAID', { totalGross: 30, flags: { kwotaZaplacona: '40.00' } }), [{ kind: 'ZWROT', amount: 10 }])).toBe(3000)
  })
  it('druga paczka (podział, „dośle później”) opłaconego zamówienia: w całości; pobranie: 0', () => {
    expect(zaplaconoDoFaktury(o('PAID', { totalGross: 0, parentOrderId: 'matka' }), [])).toBe('CALOSC')
    expect(zaplaconoDoFaktury(o('COD', { totalGross: 0, parentOrderId: 'matka' }), [])).toBe(0)
  })
})

describe('dzienWystawienia: data w strefie Warszawy', () => {
  it('po północy czasu polskiego to już następny dzień', () => {
    expect(dzienWystawienia(new Date('2026-11-20T23:30:00Z'))).toBe('2026-11-21')
    expect(dzienWystawienia(new Date('2026-11-20T10:00:00Z'))).toBe('2026-11-20')
    expect(dzienWystawienia(new Date('2026-07-31T22:30:00Z'))).toBe('2026-08-01')
  })
})
