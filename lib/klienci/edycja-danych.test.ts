// Edycja danych kupującego i danych do faktury na karcie zamówienia z kanału: walidacja formularzy i rekord po zmianie.
// Czyste funkcje, bez bazy. Dane fikcyjne, NIP fikcyjny z poprawną sumą kontrolną.
import { describe, expect, it } from 'vitest'
import { BladDanychKlienta, fakturaZFormularza, kupujacyZFormularza, NIP_ZAGRANICZNY, polaFaktury, polaKupujacego, rekordZFaktura, rekordZKupujacym, rodzajFaktury } from './edycja-danych'
import { PUSTY_REKORD, type RekordKlienta } from './rekord'

const NIP = '1234563218'

const f = (o: Record<string, string>): FormData => {
  const x = new FormData()
  for (const [k, v] of Object.entries(o)) x.set(k, v)
  return x
}

const KANAL: RekordKlienta = {
  ...PUSTY_REKORD,
  nabywca: { imieNazwisko: 'Ewa Fikcyjna', firma: null },
  dostawa: { imieNazwisko: 'Ewa Fikcyjna', firma: null, ulica: 'ul. Atrapowa', numerDomu: '7', numerLokalu: null, kodPocztowy: '60-003', miasto: 'Poznań', kraj: 'PL' },
  punktOdbioru: { kod: 'TST01M', nazwa: null },
  telefon: '+48 511 222 444',
  email: 'ewa@example.test',
  login: 'ewa_fikcyjna',
}

describe('kupujacyZFormularza', () => {
  it('pola z formularza, puste = null', () => {
    expect(kupujacyZFormularza(f({ imie: ' Adam Kupujący ', firma: '', telefon: '511 222 333', email: 'adam@example.test' }))).toEqual({ imieNazwisko: 'Adam Kupujący', firma: null, telefon: '511 222 333', email: 'adam@example.test' })
  })
  it('bez imienia i firmy: odmowa z nazwą pola, bez wartości', () => {
    expect(() => kupujacyZFormularza(f({ imie: '', firma: '', telefon: '511222333' }))).toThrow(BladDanychKlienta)
    expect(() => kupujacyZFormularza(f({ imie: '', firma: '' }))).toThrow(/imię i nazwisko albo firmę kupującego/)
  })
  it('zły e-mail i za krótki telefon: odmowa', () => {
    expect(() => kupujacyZFormularza(f({ imie: 'Adam', email: 'adam@' }))).toThrow(/E-mail/)
    expect(() => kupujacyZFormularza(f({ imie: 'Adam', telefon: '12345' }))).toThrow(/Telefon/)
  })
  it('komunikat nie powtarza wartości', () => {
    try {
      kupujacyZFormularza(f({ imie: 'Adam', email: 'zly-adres-xyz' }))
    } catch (e) {
      expect((e as Error).message).not.toContain('zly-adres-xyz')
    }
  })
})

describe('fakturaZFormularza', () => {
  const ADRES = { f_ulica: 'ul. Fikcyjna 1', f_kod: '60-001', f_miasto: 'Poznań' }
  it('bez danych do faktury: dane puste, potwierdzenie usunięcia z pola f_usun', () => {
    expect(fakturaZFormularza(f({ f_rodzaj: 'brak', f_nazwa: 'Firma Atrapa', f_nip: NIP }))).toEqual({ rodzaj: 'BRAK', faktura: null, usunPotwierdzone: false })
    expect(fakturaZFormularza(f({ f_rodzaj: 'brak', f_usun: 'tak' }))).toEqual({ rodzaj: 'BRAK', faktura: null, usunPotwierdzone: true })
  })
  it('bez wyboru rodzaju: odmowa', () => {
    expect(() => fakturaZFormularza(f({ f_nazwa: 'Atrapa' }))).toThrow(/rodzaj/)
  })
  it('na firmę: nazwa, NIP (bez PL, spacji i myślników), adres', () => {
    const w = fakturaZFormularza(f({ f_rodzaj: 'firma', f_nazwa: 'Atrapa sp. z o.o.', f_nip: 'PL 123-456-32-18', ...ADRES }))
    expect(w).toEqual({ rodzaj: 'FIRMA', faktura: { nazwa: 'Atrapa sp. z o.o.', nip: NIP, ulica: 'ul. Fikcyjna 1', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' } })
  })
  it('na firmę bez NIP-u albo ze złą sumą kontrolną: odmowa', () => {
    const baza = { f_rodzaj: 'firma', f_nazwa: 'Atrapa', ...ADRES }
    expect(() => fakturaZFormularza(f({ ...baza, f_nip: '' }))).toThrow(/NIP/)
    expect(() => fakturaZFormularza(f({ ...baza, f_nip: '1234563219' }))).toThrow(/sumą kontrolną/)
  })
  it('NIP zagraniczny albo numer VAT UE: czytelna odmowa (poprawka w programie do faktur)', () => {
    expect(() => fakturaZFormularza(f({ f_rodzaj: 'firma', f_nazwa: 'Atrapa GmbH', f_nip: 'DE 123456789', ...ADRES }))).toThrow(NIP_ZAGRANICZNY)
  })
  it('na firmę bez nazwy albo adresu: odmowa (faktura bez adresu nie wyjdzie)', () => {
    expect(() => fakturaZFormularza(f({ f_rodzaj: 'firma', f_nip: NIP, ...ADRES }))).toThrow(/nazwę/)
    expect(() => fakturaZFormularza(f({ f_rodzaj: 'firma', f_nazwa: 'Atrapa', f_nip: NIP, f_kod: '60-001', f_miasto: 'Poznań' }))).toThrow(/ulica z numerem, kod pocztowy i miasto/)
    expect(() => fakturaZFormularza(f({ f_rodzaj: 'firma', f_nazwa: 'Atrapa', f_nip: NIP, ...ADRES, f_kod: '60001' }))).toThrow(/NN-NNN/)
  })
  it('faktura imienna: nazwa i adres wymagane, NIP pusty', () => {
    expect(fakturaZFormularza(f({ f_rodzaj: 'imienna', f_nazwa: 'Ewa Fikcyjna', f_nip: '', ...ADRES }))).toEqual({ rodzaj: 'IMIENNA', faktura: { nazwa: 'Ewa Fikcyjna', nip: null, ulica: 'ul. Fikcyjna 1', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' } })
    expect(() => fakturaZFormularza(f({ f_rodzaj: 'imienna', ...ADRES }))).toThrow(/imię i nazwisko/)
    expect(() => fakturaZFormularza(f({ f_rodzaj: 'imienna', f_nazwa: 'Ewa Fikcyjna', f_ulica: 'ul. Fikcyjna 1' }))).toThrow(/ulica z numerem, kod pocztowy i miasto/)
    expect(() => fakturaZFormularza(f({ f_rodzaj: 'imienna', f_nazwa: 'Ewa Fikcyjna', f_nip: NIP, ...ADRES }))).toThrow(/bez NIP-u/)
  })
})

describe('rodzajFaktury (stan początkowy formularza z rekordu)', () => {
  it('NIP = na firmę, dane bez NIP-u = imienna, sam znacznik = na firmę, nic = bez danych', () => {
    expect(rodzajFaktury({ nazwa: 'A', nip: NIP, ulica: null, kodPocztowy: null, miasto: null, kraj: 'PL' }, false)).toBe('FIRMA')
    expect(rodzajFaktury({ nazwa: 'Ewa', nip: null, ulica: 'u', kodPocztowy: '60-001', miasto: 'P', kraj: 'PL' }, true)).toBe('IMIENNA')
    expect(rodzajFaktury(null, true)).toBe('FIRMA')
    expect(rodzajFaktury(null, false)).toBe('BRAK')
  })
})

describe('rekord po zmianie', () => {
  it('kupujący: nabywca i kontakt nowe, dostawa, punkt, faktura i login bez zmian; źródło problemów kontaktu zdjęte', () => {
    const stary = { ...KANAL, problemy: ['brak_telefon', 'adres_bez_podzialu'] }
    const r = rekordZKupujacym(stary, { imieNazwisko: 'Adam Kupujący', firma: 'Atrapa', telefon: '511 222 333', email: 'adam@example.test' })
    expect(r.nabywca).toEqual({ imieNazwisko: 'Adam Kupujący', firma: 'Atrapa' })
    expect(r.telefon).toBe('511 222 333')
    expect(r.email).toBe('adam@example.test')
    expect(r.dostawa).toEqual(KANAL.dostawa)
    expect(r.punktOdbioru).toEqual(KANAL.punktOdbioru)
    expect(r.login).toBe('ewa_fikcyjna')
    expect(r.problemy).toEqual(['adres_bez_podzialu'])
  })
  it('kupujący: nazwy zmienionych pól (bez wartości)', () => {
    expect(polaKupujacego(KANAL, { imieNazwisko: 'Ewa Fikcyjna', firma: null, telefon: '+48 511 222 444', email: 'ewa@example.test' })).toEqual([])
    expect(polaKupujacego(KANAL, { imieNazwisko: 'Adam', firma: null, telefon: '+48 511 222 444', email: 'nowy@example.test' })).toEqual(['nabywca_imie_nazwisko', 'email'])
  })
  it('faktura: dane do faktury nowe, reszta bez zmian; pola z przełącznikiem', () => {
    const fa = { nazwa: 'Atrapa', nip: NIP, ulica: 'ul. Fikcyjna 1', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' }
    const r = rekordZFaktura(KANAL, fa)
    expect(r.faktura).toEqual(fa)
    expect(r.dostawa).toEqual(KANAL.dostawa)
    expect(polaFaktury(KANAL, false, { rodzaj: 'FIRMA', faktura: fa })).toEqual(['faktura_nazwa', 'faktura_nip', 'faktura_ulica', 'faktura_kod_pocztowy', 'faktura_miasto', 'faktura_rodzaj'])
    expect(polaFaktury(r, true, { rodzaj: 'FIRMA', faktura: fa })).toEqual([])
    expect(polaFaktury(r, true, { rodzaj: 'BRAK', faktura: null })).toEqual(['faktura_nazwa', 'faktura_nip', 'faktura_ulica', 'faktura_kod_pocztowy', 'faktura_miasto', 'faktura_rodzaj'])
    // faktura imienna: poprawka ulicy zmienia samą ulicę, rodzaj zostaje
    const im = { ...fa, nip: null }
    expect(polaFaktury(rekordZFaktura(KANAL, im), true, { rodzaj: 'IMIENNA', faktura: { ...im, ulica: 'ul. Fikcyjna 2' } })).toEqual(['faktura_ulica'])
  })
})
