// Stan faktury bieżącej paczki na karcie zamówienia: w tym stan po „Ponów fakturę”, zanim kolejka podejmie nową próbę.
import type { InvoiceState } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { stanFaktury, type ZamowienieDoStanuFaktury } from './stan-faktury'

const proba = (attemptNo: number, state: InvoiceState, extra: Partial<ZamowienieDoStanuFaktury['invoices'][number]> = {}) => ({ packageNo: 1, attemptNo, state, number: null, wfirmaDocId: null, ...extra })
const zam = (o: Partial<ZamowienieDoStanuFaktury> = {}): { o: ZamowienieDoStanuFaktury } => ({
  o: { packageNo: 1, status: 'SPAKOWANE', mode: 'PRACA', flags: {}, wantInvoiceNip: false, parentOrderId: null, invoices: [], ...o },
})
const PO_SPAKOWANIU = { wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: false }
const PRZY_DO_WYSYLKI = { wystawiajPrzy: 'DO_WYSLANIA', tylkoNaZadanie: false }

describe('stanFaktury', () => {
  it('błąd faktury: czerwony stan z ponowieniem', () => {
    const s = stanFaktury(zam({ flags: { fakturaBlad: true }, invoices: [proba(1, 'FAILED'), proba(2, 'FAILED'), proba(3, 'FAILED')] }))
    expect(s).toMatchObject({ blad: true, ton: 'blad', wToku: false })
  })

  it('po „Ponów fakturę” (flaga zdjęta, ostatnia próba sprzed ponowienia): W kolejce, bez błędu', () => {
    const s = stanFaktury(zam({ flags: { fakturaBlad: false, fakturaPonowionaPo: 3 }, invoices: [proba(1, 'FAILED'), proba(2, 'FAILED'), proba(3, 'FAILED')] }))
    expect(s).toEqual({ tekst: 'W kolejce: system wystawi fakturę w ciągu kilku minut', ton: 'info', numer: null, blad: false, wystawiona: false, wToku: true })
  })

  it('po ponowieniu dokument bez rozchodu przy „Do wysyłki”: W kolejce także w statusie Do wysyłki', () => {
    const s = stanFaktury(zam({ status: 'DO_WYSLANIA', flags: { fakturaPonowionaPo: 1 }, invoices: [proba(1, 'FAILED')] }), 'x', PRZY_DO_WYSYLKI)
    expect(s).toMatchObject({ wToku: true, blad: false })
  })

  it('nowa próba po ponowieniu nieudana: znowu błąd; udana: wystawiona z numerem', () => {
    expect(stanFaktury(zam({ flags: { fakturaPonowionaPo: 3 }, invoices: [proba(3, 'FAILED'), proba(4, 'FAILED')] }))).toMatchObject({ blad: true, wToku: false })
    expect(stanFaktury(zam({ flags: { fakturaPonowionaPo: 3 }, invoices: [proba(3, 'FAILED'), proba(4, 'ISSUED', { number: 'FV 1/2026' })] }))).toMatchObject({ wystawiona: true, numer: 'FV 1/2026', wToku: false })
    expect(stanFaktury(zam({ flags: { fakturaPonowionaPo: 3 }, invoices: [proba(3, 'FAILED'), proba(4, 'SENDING')] }))).toMatchObject({ tekst: 'W kolejce', wToku: true })
  })

  it('ponowione, ale kolejka tego nie podejmie: stan jak dotąd (błąd)', () => {
    const ponowione = { flags: { fakturaPonowionaPo: 1 }, invoices: [proba(1, 'FAILED')] }
    // wystawianie wyłączone w ustawieniach
    expect(stanFaktury(zam(ponowione), 'x', PO_SPAKOWANIU, { wystawianieWylaczone: true })).toMatchObject({ blad: true, wToku: false })
    // zamówienie anulowane
    expect(stanFaktury(zam({ ...ponowione, status: 'ANULOWANE' }))).toMatchObject({ blad: true, wToku: false })
    // konto w podglądzie (kolejka bierze tylko tryb pracy)
    expect(stanFaktury(zam({ ...ponowione, mode: 'CIEN' }))).toMatchObject({ blad: true, wToku: false })
    // status przed momentem wystawiania
    expect(stanFaktury(zam({ ...ponowione, status: 'SPAKOWANE' }), 'x', PRZY_DO_WYSYLKI)).toMatchObject({ blad: true, wToku: false })
    // faktura z rozchodem (lustro wFirmy) idzie tylko ze statusu Spakowane
    expect(stanFaktury(zam({ ...ponowione, status: 'DO_WYSLANIA' }), 'x', PO_SPAKOWANIU, { tylkoSpakowane: true })).toMatchObject({ blad: true, wToku: false })
    // tylko na żądanie, klient nie prosił
    expect(stanFaktury(zam(ponowione), 'x', { wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: true })).toMatchObject({ blad: true, wToku: false })
    // spakowane przed włączeniem wystawiania
    expect(stanFaktury(zam(ponowione), 'x', PO_SPAKOWANIU, { spakowanePrzedWlaczeniem: true })).toMatchObject({ blad: true, wToku: false })
  })

  it('flaga ponowienia z wcześniejszej serii nie dotyczy późniejszej nieudanej próby', () => {
    expect(stanFaktury(zam({ flags: { fakturaPonowionaPo: 1 }, invoices: [proba(1, 'FAILED'), proba(2, 'FAILED')] }))).toMatchObject({ blad: true })
  })

  it('obca waluta: powód faktury ręcznej zamiast „W kolejce” i bez ponowienia', () => {
    const s = stanFaktury(zam(), 'x', PO_SPAKOWANIU, { obcaWaluta: 'CZK' })
    expect(s).toEqual({ tekst: 'Zamówienie w CZK: wystaw fakturę ręcznie w programie do faktur. Jeśli Kompletor wystawił WZ przy wysyłce, wystaw fakturę do tego WZ, bez drugiego wydania towaru.', ton: 'ostrzezenie', numer: null, blad: false, wystawiona: false, wToku: false })
    // błąd z wcześniejszej próby: nadal powód, bez czerwonego stanu z „Ponów fakturę”
    expect(stanFaktury(zam({ flags: { fakturaBlad: true }, invoices: [proba(1, 'FAILED')] }), 'x', PO_SPAKOWANIU, { obcaWaluta: 'CZK' })).toMatchObject({ blad: false, ton: 'ostrzezenie', wToku: false })
  })

  it('obca waluta nie zasłania faktury wystawionej ani stanu zamówienia anulowanego', () => {
    expect(stanFaktury(zam({ invoices: [proba(1, 'ISSUED', { number: 'FV 2/2026' })] }), 'x', PO_SPAKOWANIU, { obcaWaluta: 'CZK' })).toMatchObject({ tekst: 'Wystawiona', wystawiona: true, numer: 'FV 2/2026' })
    const anul = { status: 'ANULOWANE' as const, flags: { fakturaBlad: true }, invoices: [proba(1, 'FAILED')] }
    expect(stanFaktury(zam(anul), 'x', PO_SPAKOWANIU, { obcaWaluta: 'CZK' })).toEqual(stanFaktury(zam(anul)))
  })

  it('obca waluta z dokumentem spoza Kompletora (faktura BL, dokument po wysyłce): stan jak przed zmianą', () => {
    for (const o of [zam(), zam({ status: 'WYSLANE' as const }), zam({ flags: { fakturaBlad: true }, invoices: [proba(1, 'FAILED')] })])
      expect(stanFaktury(o, 'x', PO_SPAKOWANIU, { obcaWaluta: 'CZK', dokumentPoza: true })).toEqual(stanFaktury(o, 'x', PO_SPAKOWANIU))
    expect(stanFaktury(zam(), 'x', PO_SPAKOWANIU, { obcaWaluta: 'CZK', dokumentPoza: false }).tekst).toMatch(/^Zamówienie w CZK/)
  })

  it('spakowane w trybie pracy bez próby: W kolejce (bez zmian)', () => {
    expect(stanFaktury(zam())).toMatchObject({ tekst: 'W kolejce', ton: 'info', wToku: false })
  })
})
