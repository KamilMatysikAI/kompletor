// Zamówienie kuriera DPD (DPDServices REST, `packagesPickupCall`): treść żądania i odczyt odpowiedzi. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { dostepnoscKuriera, odpowiedzZamowieniaKuriera, przedzialyZZakresu, sprawdzZamowienieKuriera, trescZamowieniaKuriera, zakresyDostepnosci, type ZamowienieKurieraDpd } from './zlecenie-kuriera-dpd'

const NADAWCA = { name: 'Firma Testowa', address: 'ul. Magazynowa 5', city: 'Poznań', postalCode: '60-001', phone: '611000000', email: 'sklep@example.invalid' }
const Z: ZamowienieKurieraDpd = { data: '2026-11-23', odMin: 13 * 60, doMin: 15 * 60, fid: '1495', nadawca: NADAWCA, paczki: [{ wagaKg: 1.2, wymiaryCm: [30, 20, 10] }, { wagaKg: 3.5, wymiaryCm: [40, 30, 25] }] }

describe('treść zamówienia kuriera DPD', () => {
  it('pola wymagane z dokumentacji: data, okno HH:MM, DOMESTIC, płatnik (FID), zamawiający, nadawca, paczki: liczba, suma i maksima', () => {
    expect(trescZamowieniaKuriera(Z)).toEqual({
      orderType: 'DOMESTIC',
      pickupDate: '2026-11-23',
      pickupTimeFrom: '13:00',
      pickupTimeTo: '15:00',
      waybillsReady: true,
      packagesForCollection: {
        payer: { number: 1495 },
        orderer: { name: 'Firma Testowa', fullName: 'Firma Testowa', phone: '611000000' },
        sender: { name: 'Firma Testowa', fullName: 'Firma Testowa', address: 'ul. Magazynowa 5', city: 'Poznań', postalCode: '60001', phone: '611000000' },
        packagesParams: { doxCount: 0, parcel: { count: 2, weight: 4.7, maxWeight: 3.5, maxDepth: 40, maxWidth: 30, maxHeight: 25 } },
      },
    })
  })

  it('braki przed żądaniem: bez paczek, zły FID, okno odwrócone, brak danych nadawcy = lista powodów', () => {
    expect(sprawdzZamowienieKuriera({ ...Z, paczki: [] })).toContain('brak paczek do odbioru')
    expect(sprawdzZamowienieKuriera({ ...Z, fid: 'abc' })).toContain('numer płatnika (FID) DPD')
    expect(sprawdzZamowienieKuriera({ ...Z, odMin: 900, doMin: 780 })).toContain('okno godzin odbioru')
    expect(sprawdzZamowienieKuriera({ ...Z, nadawca: { ...NADAWCA, phone: '' } })).toContain('telefon nadawcy')
    expect(sprawdzZamowienieKuriera(Z)).toEqual([])
  })
})

describe('odpowiedź DPD', () => {
  it('OK z numerem zlecenia i sumą kontrolną (do anulowania)', () => {
    expect(odpowiedzZamowieniaKuriera({ orderNumber: 'AD112345678901', checkSum: '12345678', status: { status: 'OK' }, traceId: 't' })).toEqual({ ok: true, numer: 'AD112345678901', sumaKontrolna: '12345678' })
  })
  it('odmowa: status DPD i opisy błędów, bez wartości z żądania', () => {
    const w = odpowiedzZamowieniaKuriera({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'E1', description: 'Pickup date in the past', fields: ['pickupDate'] }] }, traceId: 't' })
    expect(w).toMatchObject({ ok: false, powod: 'VALIDATION_ERROR: Pickup date in the past (pickupDate)' })
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'DISALLOWED_FID' } })).toMatchObject({ ok: false, powod: 'DISALLOWED_FID' })
    expect(odpowiedzZamowieniaKuriera(null)).toMatchObject({ ok: false, powod: 'nieczytelna odpowiedź DPD' })
    // OK bez numeru zlecenia to nie jest potwierdzenie
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'OK' } })).toMatchObject({ ok: false, powod: 'DPD nie zwrócił numeru zlecenia' })
    // numer z samych zer to brak numeru (adapter: niewiadoma), także bez statusu nie jest potwierdzeniem
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'OK' }, orderNumber: '0' })).toMatchObject({ ok: false, powod: 'DPD nie zwrócił numeru zlecenia' })
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'OK' }, orderNumber: '000' })).toMatchObject({ ok: false, powod: 'DPD nie zwrócił numeru zlecenia' })
    expect(odpowiedzZamowieniaKuriera({ orderNumber: '00' })).toMatchObject({ ok: false })
  })
  it('dostępność kuriera: zakresy godzin z liczbą minut `offset` (nie dni); zły offset = null', () => {
    expect(zakresyDostepnosci({ status: 'OK', ranges: [{ offset: 360, range: '09:00-17:00' }, { offset: 180, range: '14:00-17:00' }] })).toEqual([{ offsetMin: 360, zakres: '09:00-17:00' }, { offsetMin: 180, zakres: '14:00-17:00' }])
    expect(zakresyDostepnosci({ status: 'OK', ranges: [{ offset: -5, range: '09:00-17:00' }, { offset: 'x', range: '10:00-12:00' }, { range: '12:00-13:00' }] }).map((z) => z.offsetMin)).toEqual([null, null, null])
    expect(zakresyDostepnosci({ status: 'RANGE_NOT_FOUND' })).toEqual([])
  })
})

describe('odmowa przy HTTP 200 i dostępność kuriera', () => {
  it('HTTP 200 z odmową: `fields` jako tekst (specyfikacja) i tablica; opis z danymi z żądania albo cyframi wypada, kod zostaje', () => {
    const tresc = trescZamowieniaKuriera(Z)
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'INCORRECT_VALUE', fields: 'pickupTimeFrom / pickupTimeTo', description: 'Time frame not allowed.' }] } }, tresc)).toMatchObject({
      ok: false,
      powod: 'VALIDATION_ERROR: INCORRECT_VALUE: Time frame not allowed. (pickupTimeFrom / pickupTimeTo)',
    })
    const w = odpowiedzZamowieniaKuriera({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'INCORRECT_VALUE', fields: ['sender.phone'], description: `zły telefon ${NADAWCA.phone}` }] } }, tresc)
    expect(w).toMatchObject({ ok: false, powod: 'VALIDATION_ERROR: INCORRECT_VALUE: zły telefon *** (sender.phone)' })
    // echo po normalizacji DPD (telefon z prefiksem) spoza żądania też wypada, bo opis ma cyfry
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'INCORRECT_VALUE', description: 'phone +48611000000 invalid' }] } }, tresc)).toMatchObject({ ok: false, powod: 'VALIDATION_ERROR: INCORRECT_VALUE' })
    // `fields` i `code` przez ten sam filtr: wartość z cyfrą albo `@` spoza żądania wypada, nazwa pola bez cyfr zostaje
    expect(
      odpowiedzZamowieniaKuriera({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'jan@przyklad.pl', fields: ['sender.email', 'anna@przyklad.pl', '+48600111222'], description: 'bad 123' }] } }, tresc),
    ).toMatchObject({ ok: false, powod: 'VALIDATION_ERROR: (sender.email)' })
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'E 600111222', fields: '600111222' }] } }, tresc)).toMatchObject({ ok: false, powod: 'VALIDATION_ERROR' })
    expect(odpowiedzZamowieniaKuriera({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'E3', description: 'Sender Firma Testowa rejected' }] } }, tresc)).toMatchObject({ ok: false, powod: 'VALIDATION_ERROR: Sender *** rejected' })
  })

  it('przedziały z tekstu `range`: jeden, kilka, z sekundami, z myślnikiem; nieznany format = null', () => {
    expect(przedzialyZZakresu('08:00-16:00')).toEqual([{ odMin: 480, doMin: 960 }])
    expect(przedzialyZZakresu('08:00 - 12:00, 12:00 – 16:00')).toEqual([{ odMin: 480, doMin: 720 }, { odMin: 720, doMin: 960 }])
    expect(przedzialyZZakresu('9:00:00-17:30:00')).toEqual([{ odMin: 540, doMin: 1050 }])
    expect(przedzialyZZakresu('16:00-08:00')).toBeNull()
    expect(przedzialyZZakresu('cały dzień')).toBeNull()
  })

  it('dostępność: OK = przedziały bez dni (posortowane, bez powtórzeń), RANGE_NOT_FOUND albo OK bez zakresów = BRAK, inny status albo format = BLAD', () => {
    expect(dostepnoscKuriera({ status: 'OK', ranges: [{ offset: 180, range: '12:00-16:00' }, { offset: 0, range: '10:00-16:00' }, { offset: 180, range: '08:00-12:00' }, { offset: 60, range: '08:00-12:00' }], traceId: 't' })).toEqual({
      stan: 'OK',
      przedzialy: [
        { odMin: 480, doMin: 720, offsetMin: 180 },
        { odMin: 600, doMin: 960, offsetMin: 0 },
        { odMin: 720, doMin: 960, offsetMin: 180 },
      ],
    })
    // surowa odpowiedź z produkcji (24.11): offset w minutach, trzy przedziały, wcześniej odrzucane jako „brak przedziałów”
    expect(dostepnoscKuriera({ status: 'OK', ranges: [{ offset: 360, range: '09:00-17:00' }, { offset: 180, range: '11:00-14:00' }, { offset: 180, range: '14:00-17:00' }] })).toEqual({
      stan: 'OK',
      przedzialy: [
        { odMin: 540, doMin: 1020, offsetMin: 360 },
        { odMin: 660, doMin: 840, offsetMin: 180 },
        { odMin: 840, doMin: 1020, offsetMin: 180 },
      ],
    })
    expect(dostepnoscKuriera({ status: 'RANGE_NOT_FOUND', traceId: 't' })).toEqual({ stan: 'BRAK' })
    expect(dostepnoscKuriera({ status: 'OK', ranges: [] })).toEqual({ stan: 'BRAK' })
    expect(dostepnoscKuriera({ status: { status: 'OK' }, ranges: [{ offset: 0, range: '10:00-12:00' }] })).toMatchObject({ stan: 'OK' })
    expect(dostepnoscKuriera({ status: 'POSTAL_CODE_NOT_FOUND' })).toEqual({ stan: 'BLAD', powod: 'POSTAL_CODE_NOT_FOUND' })
    expect(dostepnoscKuriera({ status: 'OK', ranges: [{ offset: 0, range: 'rano' }] })).toEqual({ stan: 'BLAD', powod: 'przedział DPD w nieznanym formacie' })
    expect(dostepnoscKuriera(null)).toMatchObject({ stan: 'BLAD' })
    expect(dostepnoscKuriera({ ranges: [] })).toEqual({ stan: 'BLAD', powod: 'odpowiedź DPD bez statusu' })
  })
})
