// faktura w walucie zamówienia (wFirma). Treść żądania z polem `currency`, regresja bajt w bajt dla PLN,
// sprawdzenie faktury po odczycie, wyłącznik firmy i stan na karcie. Dane fikcyjne, bez bazy i bez sieci.
import { describe, expect, it } from 'vitest'
import { walutaZamowieniaWlaczona } from '../dokumenty/ustawienia'
import { dokumentyZFormularza } from '../dokumenty/zapis'
import { stanFaktury, type ZamowienieDoStanuFaktury } from '../karta/stan-faktury'
import { tekstWalutaSprzedWlaczenia } from '../rdzen/waluta'
import { odczytFakturyWaluty, rozjazdyFakturyWaluty, stawekVatWTresci } from './adapter-zapis'
import { type WejscieFaktury, zlozFakture } from './faktura'
import { parseKonfiguracjaFaktur } from './konfiguracja'

const cfg = parseKonfiguracjaFaktur({ faktury: { seriaId: '77', kodyVat: { '23': 1001, '8': 1002, '5': 1003, '0': 1004 } } })
const wej = (o: Partial<WejscieFaktury> = {}): WejscieFaktury => ({
  idExternal: 'zam1/1/0',
  totalGross: 52.99,
  paymentMethod: 'BLIK',
  paymentState: 'PAID',
  pozycje: [{ sku: 'A1', rodzaj: 'STOCKED', nazwa: 'Towar testowy A1', jednostka: 'SZT', wfirmaGoodId: '500', qty: 2, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 2000, stawkaVat: '23' }],
  konfiguracja: cfg,
  kontrahent: { name: 'Firma Fikcyjna' },
  zaplacono: 'CALOSC',
  dataWystawienia: '2026-11-23',
  ...o,
})

/** Treść żądania dla `wej()` (wydruk z `zlozFakture` z origin/produkcja 9cca37a9). */
const PLN_PRZED_ZMIANA =
  '{"invoices":{"invoice":{"type":"normal","price_type":"brutto","paymentmethod":"transfer","id_external":"zam1/1/0","alreadypaid_initial":"52.99","paymentdate":"2026-11-23","series":{"id":"77"},"contractor":{"name":"Firma Fikcyjna"},"invoicecontents":{"0":{"invoicecontent":{"good":{"id":500},"name":"Towar testowy A1","count":"2.0000","unit":"szt.","price":"20.00","vat_code":{"id":1001}}},"1":{"invoicecontent":{"good":{"id":0},"name":"Wysyłka","count":"1.0000","unit":"szt.","price":"12.99","vat_code":{"id":1001}}}}}}}'

describe('zlozFakture z walutą', () => {
  it('PLN i brak waluty: treść bajt w bajt jak przed zmianą', () => {
    expect(JSON.stringify(zlozFakture(wej()).tresc)).toBe(PLN_PRZED_ZMIANA)
    expect(JSON.stringify(zlozFakture(wej({ waluta: 'PLN' })).tresc)).toBe(PLN_PRZED_ZMIANA)
  })

  it('CZK: pole currency, ceny pozycji, wysyłka i zapłacono w koronach bez przeliczania, stawki VAT z konfiguracji', () => {
    const f = zlozFakture(wej({ waluta: 'CZK' }))
    expect(f.problemy).toEqual([])
    const inv = f.tresc!.invoices.invoice
    expect(inv['currency']).toBe('CZK')
    // jedyna różnica względem PLN to pole waluty zaraz po rodzaju ceny
    expect(JSON.stringify(f.tresc)).toBe(PLN_PRZED_ZMIANA.replace('"price_type":"brutto",', '"price_type":"brutto","currency":"CZK",'))
    expect(f.bruttoGr).toBe(5299)
    // kursu nie wysyłamy: pola kursu w API wFirmy są tylko do odczytu
    expect(Object.keys(inv).filter((k) => /exchange|currency_/.test(k))).toEqual([])
  })
})

describe('sprawdzenie faktury w obcej walucie po odczycie', () => {
  const get = (inv: Record<string, unknown>) => ({ invoices: { 0: { invoice: { id: '901', ...inv } }, parameters: {} }, status: { code: 'OK' } })

  it('odczyt pól: waluta, brutto w groszach waluty, kurs, data i tabela NBP', () => {
    expect(odczytFakturyWaluty(get({ currency: 'CZK', total: '957.00', currency_exchange: '0.1745', currency_date: '2026-11-20', currency_label: '226/A/NBP/2026' }))).toEqual({ waluta: 'CZK', bruttoGr: 95700, kurs: 0.1745, dataKursu: '2026-11-20', tabela: '226/A/NBP/2026' })
    expect(odczytFakturyWaluty({ invoices: {}, status: { code: 'NOT FOUND' } })).toBeNull()
  })

  it('zgodna: bez rozjazdów; różna waluta, brak kursu, inna kwota, brak dokumentu = rozjazdy z opisem', () => {
    const ok = odczytFakturyWaluty(get({ currency: 'CZK', total: '957.00', currency_exchange: '0.1745' }))
    expect(rozjazdyFakturyWaluty(ok, { waluta: 'CZK', bruttoGr: 95700 })).toEqual([])
    expect(rozjazdyFakturyWaluty(ok, { waluta: 'CZK', bruttoGr: 95701 })).toEqual([])
    expect(rozjazdyFakturyWaluty(ok, { waluta: 'CZK' })).toEqual([])
    expect(rozjazdyFakturyWaluty(odczytFakturyWaluty(get({ currency: 'PLN', total: '957.00', currency_exchange: '1' })), { waluta: 'CZK', bruttoGr: 95700 })).toEqual(['waluta faktury PLN, a zamówienia CZK'])
    expect(rozjazdyFakturyWaluty(odczytFakturyWaluty(get({ currency: 'CZK', total: '957.00', currency_exchange: '0' })), { waluta: 'CZK' })).toEqual(['brak kursu NBP na fakturze'])
    expect(rozjazdyFakturyWaluty(odczytFakturyWaluty(get({ currency: 'CZK', total: '950.00', currency_exchange: '0.17' })), { waluta: 'CZK', bruttoGr: 95700 })).toEqual(['kwota brutto w wFirmie 950.00 CZK, a wysłana 957.00 CZK'])
    // rozjazd kwoty podaje walutę odczytaną z wFirmy (nie zakładamy, że `total` jest w walucie zamówienia)
    expect(rozjazdyFakturyWaluty(odczytFakturyWaluty(get({ currency: 'PLN', total: '167.00', currency_exchange: '1' })), { waluta: 'CZK', bruttoGr: 95700 })).toContain('kwota brutto w wFirmie 167.00 PLN, a wysłana 957.00 CZK')
    expect(rozjazdyFakturyWaluty(null, { waluta: 'CZK' })).toEqual(['wFirma nie oddała faktury do sprawdzenia'])
  })
})

describe('tolerancja kwoty = 1 grosz na stawkę VAT na dokumencie', () => {
  const r = (total: string) => odczytFakturyWaluty({ invoices: { 0: { invoice: { id: '1', currency: 'CZK', total, currency_exchange: '0.17' } } } })
  it('jedna stawka: 1 gr mieści się, 2 gr nie; trzy stawki: 3 gr mieszczą się, 4 gr nie; brak liczby = 1 gr', () => {
    expect(rozjazdyFakturyWaluty(r('957.01'), { waluta: 'CZK', bruttoGr: 95700, stawekVat: 1 })).toEqual([])
    expect(rozjazdyFakturyWaluty(r('957.02'), { waluta: 'CZK', bruttoGr: 95700, stawekVat: 1 })).toHaveLength(1)
    expect(rozjazdyFakturyWaluty(r('956.97'), { waluta: 'CZK', bruttoGr: 95700, stawekVat: 3 })).toEqual([])
    expect(rozjazdyFakturyWaluty(r('957.04'), { waluta: 'CZK', bruttoGr: 95700, stawekVat: 3 })).toHaveLength(1)
    expect(rozjazdyFakturyWaluty(r('957.02'), { waluta: 'CZK', bruttoGr: 95700, stawekVat: 0 })).toHaveLength(1)
    expect(rozjazdyFakturyWaluty(r('957.02'), { waluta: 'CZK', bruttoGr: 95700 })).toHaveLength(1)
  })

  it('liczba stawek z treści faktury: różne kody vat_code, najmniej 1', () => {
    expect(stawekVatWTresci(zlozFakture(wej({ waluta: 'CZK' })).tresc!)).toBe(1)
    const dwie = zlozFakture(wej({ waluta: 'CZK', pozycje: [...wej().pozycje, { sku: 'B2', rodzaj: 'STOCKED', nazwa: 'Towar testowy B2', jednostka: 'SZT', wfirmaGoodId: '501', qty: 1, qtyOdrzucone: 0, naOferte: 1, cenaBruttoGr: 1080, stawkaVat: '8' }], totalGross: 63.79 }))
    expect(dwie.problemy).toEqual([])
    expect(stawekVatWTresci(dwie.tresc!)).toBe(2)
    expect(stawekVatWTresci({ invoices: { invoice: {} } })).toBe(1)
  })
})

describe('wyłącznik „Faktury w walucie zamówienia”', () => {
  it('tylko jawne true przy programie wFirma; domyślnie wyłączony', () => {
    expect(walutaZamowieniaWlaczona(null)).toBe(false)
    expect(walutaZamowieniaWlaczona({ faktury: { program: 'wfirma' } })).toBe(false)
    expect(walutaZamowieniaWlaczona({ faktury: { program: 'wfirma', walutaZamowienia: true } })).toBe(true)
    expect(walutaZamowieniaWlaczona({ faktury: { program: 'ksef', walutaZamowienia: true } })).toBe(false)
    expect(walutaZamowieniaWlaczona({ faktury: { walutaZamowienia: true } })).toBe(false)
    expect(walutaZamowieniaWlaczona({ faktury: { program: 'wfirma', walutaZamowienia: 'tak' } })).toBe(false)
  })

  it('formularz: pole tylko, gdy ekran je pokazał', () => {
    const f = new FormData()
    expect(dokumentyZFormularza(f)).not.toHaveProperty('walutaZamowienia')
    f.set('walutaZamowieniaPole', 'tak')
    expect(dokumentyZFormularza(f).walutaZamowienia).toBe(false)
    f.set('walutaZamowienia', 'tak')
    expect(dokumentyZFormularza(f).walutaZamowienia).toBe(true)
  })
})

describe('karta: zamówienie zatrzymane przed włączeniem', () => {
  const zam = (o: Partial<ZamowienieDoStanuFaktury> = {}): { o: ZamowienieDoStanuFaktury } => ({ o: { packageNo: 1, status: 'SPAKOWANE', mode: 'PRACA', flags: {}, wantInvoiceNip: false, parentOrderId: null, invoices: [], ...o } })
  const PO = { wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: false }

  it('bez „wystaw ręcznie”: ostrzeżenie z „Ponów fakturę” (blad), dopóki kolejka mogłaby je wziąć', () => {
    const s = stanFaktury(zam(), 'x', PO, { tylkoSpakowane: true, walutaZatrzymana: 'CZK' })
    expect(s).toMatchObject({ ton: 'ostrzezenie', blad: true, wToku: false })
    expect(s.tekst).toBe(tekstWalutaSprzedWlaczenia('CZK'))
    expect(s.tekst).toContain('Wystawione ręcznie? Jeśli nie, kliknij „Ponów fakturę”')
    expect(s.tekst).not.toMatch(/wystaw fakturę ręcznie/)
  })

  it('włączone bez zatrzymania: zwykły stan („W kolejce”); wystawiona i anulowane bez zmian', () => {
    expect(stanFaktury(zam(), 'x', PO, { tylkoSpakowane: true, dokumentPoza: false }).tekst).toBe('W kolejce')
    expect(stanFaktury(zam({ invoices: [{ packageNo: 1, attemptNo: 1, state: 'ISSUED', number: 'FV 3/2026', wfirmaDocId: '901' }] }), 'x', PO, { walutaZatrzymana: 'CZK' })).toMatchObject({ wystawiona: true, numer: 'FV 3/2026' })
    expect(stanFaktury(zam({ status: 'ANULOWANE' }), 'x', PO, { walutaZatrzymana: 'CZK' }).tekst).toBe('Bez faktury (anulowane)')
    // status poza torem faktury (np. wysłane po „Wyślij bez faktury”): bez przycisku ponowienia
    expect(stanFaktury(zam({ status: 'WYSLANE' }), 'x', PO, { tylkoSpakowane: true, walutaZatrzymana: 'CZK' }).blad).toBe(false)
  })
})
