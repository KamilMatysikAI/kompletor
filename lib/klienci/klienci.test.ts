// szyfr danych klienta (osobny pierścień, AAD, rotacja), skróty HMAC i normalizacja, rekord, terminy
// retencji. Bez bazy; dane wyłącznie fikcyjne.
import { describe, expect, it } from 'vitest'
import { encryptionKeysFromEnv } from '../sekrety'
import { odbiorcaZRekordu, parseRekord, PUSTY_REKORD, rekordZOdbiorcy, skrotRekordu, skrotTekst } from './rekord'
import { terminRetencji } from './retencja'
import { kluczSkrotowZEnv, normalizujEmail, normalizujNip, normalizujTelefon, rozpoznajFraze, skrot, skrotyRekordu } from './skroty'
import { BladSzyfruKlienta, BrakKluczaKlientow, kluczeKlientowZEnv, odszyfrujKlienta, zaszyfrujKlienta } from './szyfr'
import { isNonRetryable } from '../bledy'
import type { OrderRecipient } from '../adaptery/kontrakt'

const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const LOOKUP = 'a'.repeat(64)

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'ul. Fikcyjna 1', numerDomu: null, numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48 500 000 000', email: 'Jan@Example.test' },
  punktOdbioru: { kod: 'POZ01M', nazwa: 'Paczkomat testowy' },
  faktura: { nazwa: 'Testowa Sp. z o.o.', nip: 'PL 526-000-12-46', ulica: 'ul. Fikcyjna 1', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' },
  problemy: ['adres_bez_podzialu'],
}

describe('szyfr danych klienta', () => {
  it('osobny pierścień CUSTOMER_DATA_KEYS: brak = BrakKluczaKlientow (nieponawialny, bez danych), zły format = błąd', () => {
    expect(() => kluczeKlientowZEnv({})).toThrow(BrakKluczaKlientow)
    expect(isNonRetryable(new BrakKluczaKlientow())).toBe(true)
    // klucz sekretów integracji nie jest kluczem danych klientów
    expect(() => kluczeKlientowZEnv({ APP_ENCRYPTION_KEY: K1, APP_ENCRYPTION_KEYS: `1:${K1}` })).toThrow(BrakKluczaKlientow)
    expect(() => kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: K1 })).toThrow(/CUSTOMER_DATA_KEYS w formacie/)
    expect(() => kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: `1:${K1},2:${K2}` })).toThrow(/malejąco/)
    expect(() => kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: '1:abc' })).toThrow(BladSzyfruKlienta)
    expect(kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: `2:${K2},1:${K1}` }).current).toBe(2)
    // parser wspólny z sekretami: zachowanie APP_ENCRYPTION_KEYS bez zmian
    expect(encryptionKeysFromEnv({ APP_ENCRYPTION_KEY: K1 }).current).toBe(1)
    expect(() => encryptionKeysFromEnv({})).toThrow(/Brak APP_ENCRYPTION_KEY albo APP_ENCRYPTION_KEYS/)
  })

  it('szyfrogram bez jawnych wartości; odczyt kluczem wersji wpisu; zły AAD (inne zamówienie, inna firma) = błąd', () => {
    const ring = kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: `1:${K1}` })
    const rekord = rekordZOdbiorcy(ODBIORCA)
    const s = zaszyfrujKlienta(ring, 'firma_a', 'zam1', rekord)
    expect(Buffer.from(s.ciphertext).toString('utf8')).not.toContain('Testowy')
    expect(s.keyVersion).toBe(1)
    expect(odszyfrujKlienta(ring, 'firma_a', 'zam1', s)).toEqual(rekord)
    expect(() => odszyfrujKlienta(ring, 'firma_a', 'zam2', s)).toThrow(BladSzyfruKlienta)
    expect(() => odszyfrujKlienta(ring, 'firma_b', 'zam1', s)).toThrow(BladSzyfruKlienta)
    const e = (() => {
      try {
        odszyfrujKlienta(ring, 'firma_b', 'zam1', s)
      } catch (x) {
        return x as Error
      }
    })()!
    expect(e.message).not.toMatch(/Testowy|Fikcyjna|500/)
  })

  it('rotacja: stara wersja czytelna po dodaniu nowej, zapis najnowszą; bez starej wersji = błąd z numerem wersji', () => {
    const stary = kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: `1:${K1}` })
    const nowy = kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: `2:${K2},1:${K1}` })
    const s1 = zaszyfrujKlienta(stary, 'f', 'z', PUSTY_REKORD)
    expect(odszyfrujKlienta(nowy, 'f', 'z', s1)).toEqual(PUSTY_REKORD)
    expect(zaszyfrujKlienta(nowy, 'f', 'z', PUSTY_REKORD).keyVersion).toBe(2)
    expect(() => odszyfrujKlienta(kluczeKlientowZEnv({ CUSTOMER_DATA_KEYS: `2:${K2}` }), 'f', 'z', s1)).toThrow(/kluczem v1/)
  })
})

describe('skróty i normalizacja', () => {
  it('telefon: +48, 0048, spacje i 9 cyfr to ten sam numer; za krótki = brak', () => {
    for (const t of ['+48 500 000 000', '0048500000000', '500-000-000', '48500000000', '(+48) 500 000 000']) expect(normalizujTelefon(t)).toBe('48500000000')
    expect(normalizujTelefon('+49 30 1234567')).toBe('49301234567')
    expect(normalizujTelefon('12345')).toBeNull()
    expect(normalizujTelefon(null)).toBeNull()
  })

  it('e-mail: małe litery i trim, bez usuwania kropek; NIP same cyfry', () => {
    expect(normalizujEmail('  Jan.Testowy@Example.TEST ')).toBe('jan.testowy@example.test')
    expect(normalizujEmail('jan.testowy@example.test')).not.toBe(normalizujEmail('jantestowy@example.test'))
    expect(normalizujEmail('bez-malpy')).toBeNull()
    expect(normalizujNip('PL 526-000-12-46')).toBe('5260001246')
    expect(normalizujNip('123')).toBeNull()
  })

  it('HMAC z kluczem i firmą: ten sam telefon w dwóch firmach = różne skróty; inny klucz = inny skrót; brak klucza = null', () => {
    const key = kluczSkrotowZEnv({ CUSTOMER_LOOKUP_KEY: LOOKUP })!
    const a = skrot(key, 'firma_a', 'telefon', '48500000000')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(skrot(key, 'firma_b', 'telefon', '48500000000')).not.toBe(a)
    expect(skrot(kluczSkrotowZEnv({ CUSTOMER_LOOKUP_KEY: 'b'.repeat(64) })!, 'firma_a', 'telefon', '48500000000')).not.toBe(a)
    expect(kluczSkrotowZEnv({})).toBeNull()
    expect(() => kluczSkrotowZEnv({ CUSTOMER_LOOKUP_KEY: 'krotki' })).toThrow(/32 bajty/)
    const sk = skrotyRekordu(key, 'firma_a', rekordZOdbiorcy(ODBIORCA))
    expect(sk.phoneHash).toBe(a)
    expect(sk.emailHash).toBe(skrot(key, 'firma_a', 'email', 'jan@example.test'))
    expect(sk.nipHash).toBe(skrot(key, 'firma_a', 'nip', '5260001246'))
    // maskowany e-mail Allegro też dostaje skrót (szukanie po prawdziwym adresie go nie znajdzie)
    expect(skrotyRekordu(key, 'f', { ...PUSTY_REKORD, email: 'a1b2c3+abc@allegromail.pl' }).emailHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fraza wyszukiwania: e-mail, telefon albo „inna” (nazwisko, ulica)', () => {
    expect(rozpoznajFraze(' Jan@Example.test ')).toEqual({ rodzaj: 'email', wartosc: 'jan@example.test' })
    expect(rozpoznajFraze('+48 500 000 000')).toEqual({ rodzaj: 'telefon', wartosc: '48500000000' })
    expect(rozpoznajFraze('Testowy')).toEqual({ rodzaj: 'inna' })
    expect(rozpoznajFraze('ul. Fikcyjna 1')).toEqual({ rodzaj: 'inna' })
    expect(rozpoznajFraze('12')).toEqual({ rodzaj: 'inna' })
  })
})

describe('rekord klienta', () => {
  it('z odbiorcy i z powrotem bez utraty pól; skrót „Jan T., Poznań”; nieznane pola z szyfrogramu pomijane', () => {
    const r = rekordZOdbiorcy(ODBIORCA)
    expect(r.telefon).toBe('+48 500 000 000')
    expect(odbiorcaZRekordu(r)).toEqual(ODBIORCA)
    expect(skrotTekst(skrotRekordu(r))).toBe('Jan T., Poznań')
    expect(parseRekord({ ...r, ukryte: 'x' })).toEqual(r)
    expect(() => parseRekord({ ...r, telefon: 5 })).toThrow(/telefon złego typu/)
    expect(() => parseRekord({ v: 2 })).toThrow(/wersja/)
  })
})

describe('termin retencji', () => {
  const U = { retencjaZFakturaLat: 5, retencjaBezFakturyMiesiecy: 36 }
  it('z fakturą: koniec roku faktury + 5 lat; bez faktury: dostarczenie/anulowanie + 36 mies.; otwarte = brak terminu', () => {
    expect(terminRetencji({ fakturaAt: new Date('2026-03-10T10:00:00Z'), status: 'ODEBRANE', koniecAt: new Date('2026-03-12T00:00:00Z'), otwartySpor: false }, U)).toEqual(new Date('2032-01-01T00:00:00Z'))
    expect(terminRetencji({ fakturaAt: null, status: 'ANULOWANE', koniecAt: new Date('2026-11-04T00:00:00Z'), otwartySpor: false }, U)).toEqual(new Date('2029-11-04T00:00:00Z'))
    expect(terminRetencji({ fakturaAt: null, status: 'WYSLANE', koniecAt: null, otwartySpor: false }, U)).toBeNull()
    // otwarty zwrot albo reklamacja przedłuża (bez terminu, dopóki trwa)
    expect(terminRetencji({ fakturaAt: new Date('2020-01-01T00:00:00Z'), status: 'ODEBRANE', koniecAt: new Date('2020-01-05T00:00:00Z'), otwartySpor: true }, U)).toBeNull()
  })
})
