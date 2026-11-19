// czyste części toru wystawiania — kontrola zgodności faktury z paczką, kontrahent do wystawienia,
// moment wystawienia z ustawień. Bez bazy i bez sieci.
import { describe, expect, it } from 'vitest'
import type { OrderRecipient } from '../adaptery/kontrakt'
import { momentDlaZrodla, parseUstawieniaDokumentow, statusyMomentu } from '../dokumenty/ustawienia'
import { kontrahentDoWystawienia } from '../odbiorca/przejscia'
import { rozniceIlosci } from './adapter-zapis'

describe('rozniceIlosci', () => {
  const sku = new Map([
    ['p1', 'A'],
    ['p2', 'B'],
  ])
  it('zgodne: rozbicie groszowe (dwie linie), kg na gramy, wysyłka pominięta', () => {
    const f = [
      { sku: 'A', ilosc: 2, jednostka: 'szt.' as const },
      { sku: 'A', ilosc: 1, jednostka: 'szt.' as const },
      { sku: 'B', ilosc: 0.25, jednostka: 'kg' as const },
      { sku: null, ilosc: 1, jednostka: 'szt.' as const, wysylka: true as const },
    ]
    expect(rozniceIlosci(f, [{ productId: 'p1', qty: 3, unitGrossGr: 100, vatRate: '23' }, { productId: 'p2', qty: 250, unitGrossGr: 1, vatRate: '5' }], sku)).toEqual([])
  })
  it('różnica: brak przy pakowaniu (faktura z zamówienia ma więcej) i pozycja spoza faktury', () => {
    expect(rozniceIlosci([{ sku: 'A', ilosc: 3, jednostka: 'szt.' }], [{ productId: 'p1', qty: 2, unitGrossGr: 100, vatRate: '23' }, { productId: 'p2', qty: 1, unitGrossGr: 100, vatRate: '23' }], sku)).toEqual(['A: faktura 3, paczka 2', 'B: faktura 0, paczka 1'])
  })
})

describe('kontrahentDoWystawienia', () => {
  const dostawa = { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: '2', kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: '500', email: 'a@b.pl' }
  const r = (over: Partial<OrderRecipient>): OrderRecipient => ({ dostawa, punktOdbioru: null, faktura: null, problemy: [], ...over })
  it('konsument bez danych do faktury: z dostawy, bez NIP, bez telefonu i e-maila', () => {
    expect(kontrahentDoWystawienia(r({}), false)).toEqual({ ok: true, wartosc: { name: 'Jan Testowy', tax_id_type: 'none', street: 'Testowa 1/2', zip: '00-001', city: 'Testowo', country: 'PL' } })
  })
  it('klient prosi o fakturę, a danych do faktury brak: braki, bez wystawiania na dane z dostawy', () => {
    expect(kontrahentDoWystawienia(r({}), true)).toEqual({ ok: false, braki: ['faktura'] })
  })
  it('dane do faktury z NIP wygrywają', () => {
    const k = kontrahentDoWystawienia(r({ faktura: { nazwa: 'Firma', nip: '123', ulica: 'Biurowa 1', kodPocztowy: '00-002', miasto: 'Miasto', kraj: null } }), true)
    expect(k).toMatchObject({ ok: true, wartosc: { name: 'Firma', nip: '123', tax_id_type: 'nip' } })
  })
  it('niekompletne dane do faktury nie przechodzą na dostawę', () => {
    expect(kontrahentDoWystawienia(r({ faktura: { nazwa: 'Firma', nip: null, ulica: null, kodPocztowy: null, miasto: null, kraj: null } }), false)).toEqual({ ok: false, braki: ['ulica', 'kod_pocztowy', 'miasto'] })
  })
  it('bez adresu dostawy: braki', () => {
    expect(kontrahentDoWystawienia(r({ dostawa: null }), false)).toEqual({ ok: false, braki: ['faktura', 'dostawa'] })
  })
})

describe('moment wystawienia', () => {
  it('statusy od momentu do klienta', () => {
    expect(statusyMomentu('SPAKOWANE')).toEqual(['SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE'])
    expect(statusyMomentu('WYSLANE')).toEqual(['WYSLANE', 'ODEBRANE'])
  })
  it('źródło wFirmy: zawsze po spakowaniu i dla każdego zamówienia (faktura zdejmuje towar)', () => {
    expect(momentDlaZrodla('WFIRMA', { wystawiajPrzy: 'WYSLANE', tylkoNaZadanie: true })).toEqual({ wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: false })
    expect(momentDlaZrodla('KOMPLETOR', { wystawiajPrzy: 'WYSLANE', tylkoNaZadanie: true })).toEqual({ wystawiajPrzy: 'WYSLANE', tylkoNaZadanie: true })
  })
  it('wyłącznik: domyślnie wyłączony; chwila tylko przy włączonym i poprawnej dacie', () => {
    expect(parseUstawieniaDokumentow({})).toMatchObject({ fakturyWlaczone: false, fakturyWlaczoneOd: null })
    expect(parseUstawieniaDokumentow({ faktury: { fakturyWlaczone: true, fakturyWlaczoneOd: '2026-11-06T08:00:00.000Z' } })).toMatchObject({ fakturyWlaczone: true, fakturyWlaczoneOd: '2026-11-06T08:00:00.000Z' })
    expect(parseUstawieniaDokumentow({ faktury: { fakturyWlaczone: 'tak', fakturyWlaczoneOd: 'x' } })).toMatchObject({ fakturyWlaczone: false, fakturyWlaczoneOd: null })
  })
})
