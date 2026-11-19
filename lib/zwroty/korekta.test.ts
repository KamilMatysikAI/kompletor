// decyzja „czy Kompletor może zlecić korektę” dla każdego programu do faktur i stanu konta.
import { describe, expect, it } from 'vitest'
import { mozliwoscKorekty, type StanDoKorekty } from './korekta'
import { wierszKorektyKsef } from './korekta-ksef'

const baza: StanDoKorekty = { status: 'PRZYJETY', invoiceDocId: '7001', program: 'wfirma', fakturyWlaczone: true, korektyWlaczone: true, trybKonta: 'PRACA', maDokument: true }

describe('mozliwoscKorekty', () => {
  it('wFirma + „Wystawiaj faktury z Kompletora” + konto Aktywne: zlecenie aktywne (i zakończenie ręczne jako zapas)', () => {
    expect(mozliwoscKorekty(baza)).toEqual({ zlecenie: true, powod: null, recznie: true, szkicKsef: false })
  })
  it('wyłączone wystawianie, konto w podglądzie, inny program: przycisk nieaktywny z powodem, zakończenie poza Kompletorem', () => {
    expect(mozliwoscKorekty({ ...baza, fakturyWlaczone: false })).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/wyłączone/) })
    expect(mozliwoscKorekty({ ...baza, korektyWlaczone: false })).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/Korekty faktur z Kompletora są wyłączone/) })
    expect(mozliwoscKorekty({ ...baza, trybKonta: 'CIEN' })).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/Tylko podgląd/) })
    expect(mozliwoscKorekty({ ...baza, trybKonta: null })).toMatchObject({ zlecenie: false, recznie: true })
    expect(mozliwoscKorekty({ ...baza, program: 'brak' })).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/wFirmie/) })
  })
  it('„W trakcie”: korekta w kolejce albo po błędzie da się zakończyć poza Kompletorem, wysyłana nie', () => {
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: null })).toMatchObject({ zlecenie: false, recznie: true })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: 'FAILED' })).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/nie wyszła/) })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: 'SENDING' })).toMatchObject({ zlecenie: false, recznie: false })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: 'UNKNOWN' })).toMatchObject({ recznie: false })
  })
  it('faktura z korektą innego zwrotu = bez zlecenia i bez ponowienia, z powodem; zakończenie poza Kompletorem zostaje', () => {
    expect(mozliwoscKorekty({ ...baza, innaKorekta: 'wystawiona' })).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/ma już korektę z innego zwrotu/) })
    expect(mozliwoscKorekty({ ...baza, innaKorekta: 'w_drodze' })).toMatchObject({ zlecenie: false, recznie: true, powod: expect.stringMatching(/właśnie wysyłana/) })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: 'FAILED', innaKorekta: 'wystawiona' })).toMatchObject({ zlecenie: false, recznie: true, ponowienie: false, ostrzezenie: expect.stringMatching(/ma już korektę/) })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: null, innaKorekta: 'wystawiona' })).toMatchObject({ recznie: true, ostrzezenie: expect.stringMatching(/ma już korektę/) })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: 'FAILED' })).toMatchObject({ ponowienie: true })
  })
  it('korekta w kolejce po niewiadomej (timeout, wyszukiwanie nic nie znalazło) ostrzega przed dublem', () => {
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: null, poNiewiadomej: true })).toMatchObject({ recznie: true, ostrzezenie: expect.stringMatching(/sprawdź w wFirmie, czy ta korekta już nie istnieje/) })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: null }).ostrzezenie).toBeUndefined()
  })
  it('błąd po niewiadomej (3 nieudane wyszukiwania) = ponowienie tylko z potwierdzeniem, z ostrzeżeniem', () => {
    const m = mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: 'FAILED', poNiewiadomej: true })
    expect(m).toMatchObject({ ponowienie: true, potwierdzenie: true, recznie: true, ostrzezenie: expect.stringMatching(/czy ta korekta już nie istnieje/) })
    expect(mozliwoscKorekty({ ...baza, status: 'KOREKTA', correctionState: 'FAILED' }).potwierdzenie).toBeUndefined()
  })
  it('przed odbiorem paczki: najpierw odbiór; po korekcie nic', () => {
    expect(mozliwoscKorekty({ ...baza, status: 'ZGLOSZONY' })).toMatchObject({ zlecenie: false, recznie: false, powod: expect.stringMatching(/odbierz paczkę/) })
    expect(mozliwoscKorekty({ ...baza, status: 'ZAKONCZONY' })).toMatchObject({ zlecenie: false, recznie: false, powod: null })
  })
  it('stan Kompletora (bez faktury z rozchodem): brak programu = korekta niepotrzebna, KSeF = szkic, wFirma = korekta dokumentu w wFirmie', () => {
    const k = { ...baza, invoiceDocId: null }
    expect(mozliwoscKorekty({ ...k, program: 'brak' })).toMatchObject({ zlecenie: false, recznie: false, szkicKsef: false, powod: expect.stringMatching(/nie jest potrzebna/) })
    expect(mozliwoscKorekty({ ...k, maDokument: false })).toMatchObject({ powod: expect.stringMatching(/nie jest potrzebna/) })
    expect(mozliwoscKorekty({ ...k, program: 'ksef' })).toMatchObject({ szkicKsef: true, zlecenie: false })
    expect(mozliwoscKorekty({ ...k, program: 'wfirma' })).toMatchObject({ szkicKsef: false, zlecenie: false, powod: expect.stringMatching(/programie wFirma/) })
  })
})

describe('wierszKorektyKsef (jednostka i ilość jak na fakturze)', () => {
  const pozycja = { nazwa: 'Przyprawa', qty: 3, qtyChannel: null, unitPriceGross: 10, vatRate: '23', zwroconeBazowe: 2, wydaneBazowe: 3 }
  it('sztuki: ilość i wartość w proporcji zwrotu', () => {
    expect(wierszKorektyKsef({ ...pozycja, jednostka: 'SZT' })).toEqual({ nazwa: 'Przyprawa', jednostka: 'szt.', ilosc: -2, cenaBruttoGr: 1000, bruttoGr: -2000, stawka: '23' })
  })
  it('na wagę bez oferty: ilość bazowa w gramach idzie jako kg (wcześniej razy 1000)', () => {
    const w = wierszKorektyKsef({ ...pozycja, jednostka: 'KG', qty: 500, unitPriceGross: 0.08, zwroconeBazowe: 200, wydaneBazowe: 500 })
    expect(w).toMatchObject({ jednostka: 'kg', ilosc: -0.2, bruttoGr: -1600, cenaBruttoGr: 8000 })
  })
  it('na wagę z ofertą (sztuki oferty po 100 g): ilość w kg z gramów, wartość od sztuk oferty', () => {
    const w = wierszKorektyKsef({ ...pozycja, jednostka: 'KG', qty: 300, qtyChannel: 3, unitPriceGross: 25, zwroconeBazowe: 100, wydaneBazowe: 300 })
    expect(w).toMatchObject({ jednostka: 'kg', ilosc: -0.1, bruttoGr: -2500, cenaBruttoGr: 25000 })
  })
})

describe('wierszKorektyKsef: pozycja częściowo odrzucona', () => {
  it('pozycja pierwotna 2 szt. po 10,00 zł, 1 szt. zamieniona, wydana i zwrócona 1 szt. → −10,00 zł (było −20,00 zł)', () => {
    const w = wierszKorektyKsef({ nazwa: 'Pozycja', jednostka: 'SZT', qty: 2, qtyChannel: 2, qtyOdrzucone: 1, unitPriceGross: 10, vatRate: '23', zwroconeBazowe: 1, wydaneBazowe: 1 })
    expect(w).toMatchObject({ jednostka: 'szt.', ilosc: -1, cenaBruttoGr: 1000, bruttoGr: -1000 })
  })
  it('zamiennik 2 szt. po 10,00 zł, 1 szt. zabrakło przy pakowaniu, zwrot wydanej 1 szt. → −10,00 zł', () => {
    const w = wierszKorektyKsef({ nazwa: 'Zamiennik', jednostka: 'SZT', qty: 2, qtyChannel: null, qtyOdrzucone: 1, unitPriceGross: 10, vatRate: '23', zwroconeBazowe: 1, wydaneBazowe: 1, naOferte: 1 })
    expect(w.bruttoGr).toBe(-1000)
  })
  it('zamiennik 50 g z oferty 50 g za 3,75 zł, 21 g zabrakło, zwrot wydanych 29 g → −2,18 zł (jak faktura), było −3,75 zł', () => {
    const w = wierszKorektyKsef({ nazwa: 'Zamiennik', jednostka: 'KG', qty: 50, qtyChannel: null, qtyOdrzucone: 21, unitPriceGross: 3.75, vatRate: '5', zwroconeBazowe: 29, wydaneBazowe: 29, naOferte: 50 })
    expect(w).toMatchObject({ jednostka: 'kg', ilosc: -0.029, bruttoGr: -218 })
  })
  it('część rodziny zamian: zamiennik 21 g po pozycji pierwotnej 29 g (przesunięcie 29) → wartość części 1,57 zł, nie 1,58 zł', () => {
    const w = wierszKorektyKsef({ nazwa: 'Zamiennik', jednostka: 'KG', qty: 21, qtyChannel: null, unitPriceGross: 3.75, vatRate: '5', zwroconeBazowe: 21, wydaneBazowe: 21, naOferte: 50, przesuniecie: 29 })
    expect(w.bruttoGr).toBe(-157)
  })
  it('zwrot większy niż wydane nie przekracza wartości wydanej części', () => {
    const w = wierszKorektyKsef({ nazwa: 'Pozycja', jednostka: 'SZT', qty: 3, qtyChannel: 3, qtyOdrzucone: 1, unitPriceGross: 10, vatRate: '23', zwroconeBazowe: 5, wydaneBazowe: 2 })
    expect(w).toMatchObject({ ilosc: -2, bruttoGr: -2000 })
  })
})
