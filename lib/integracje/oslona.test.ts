// klasyfikacja błędów do licznika zdrowia (czysta część, bez bazy). Przypadki z
// komunikatów adapterów ACME, żeby zmiana tekstu błędu w adapterze nie wyłączyła klasyfikacji po cichu.
import { describe, expect, it } from 'vitest'
import { AllegroAccountError } from '../adaptery/allegro'
import { AdapterError } from '../adaptery/kontrakt'
import { AdapterConfigError } from '../adaptery/rejestr'
import { klasaBledu, liczySie } from './oslona'
import { wlaczanieTrwa, WLACZANIE_NIEAKTUALNE_MS } from './zdrowie'

describe('klasa błędu po treści', () => {
  it('401/403 i odrzucony klucz tak, walidacja jednego rekordu nie', () => {
    expect(klasaBledu({ message: 'Woo /orders/1: HTTP 401 (klucz zapisu odrzucony albo bez prawa zapisu)' })).toBe('UWIERZYTELNIENIE')
    expect(klasaBledu({ message: 'token albo login i hasło odrzucone przez sklep' })).toBe('UWIERZYTELNIENIE')
    expect(klasaBledu({ message: 'Brakuje ustawień albo kluczy: brak sekretu WOO_KEY' })).toBe('KONFIGURACJA')
    expect(klasaBledu({ message: '400 zła oferta' })).toBeNull()
    expect(klasaBledu({ message: 'kod pocztowy odbiorcy niepoprawny' })).toBeNull()
  })

  it.each([
    ['Woo odczyt 401', 'Woo /orders: HTTP 401 (klucz odrzucony albo bez prawa odczytu)'],
    ['Woo odczyt 403', 'Woo /orders/5: HTTP 403 (klucz odrzucony albo bez prawa odczytu)'],
    ['Mirakl 401', 'Mirakl /api/orders: HTTP 401'],
    ['DPD 401', 'DPD generatePackagesNumbers: HTTP 401'],
    ['DPD 403', 'DPD: HTTP 403'],
    ['Base Courier 401', 'Base Courier getProfile.json: HTTP 401'],
    ['IdoSell zapis', 'HTTP 403 (klucz API bez prawa zapisu)'],
    ['Shoper zapis', 'HTTP 401 (token bez prawa zapisu)'],
  ])('%s = UWIERZYTELNIENIE', (_n, m) => {
    expect(klasaBledu({ message: m })).toBe('UWIERZYTELNIENIE')
  })

  it('Allegro 401 po odświeżeniu i 403 bez zakresu = UWIERZYTELNIENIE (choć AllegroAccountError dziedziczy po AdapterConfigError)', () => {
    expect(klasaBledu(new AllegroAccountError('Allegro /order/checkout-forms: HTTP 401 także po odświeżeniu tokena — konto wymaga sprawdzenia autoryzacji'))).toBe('UWIERZYTELNIENIE')
    expect(klasaBledu(new AllegroAccountError('Allegro /sale/offers: HTTP 403 — token bez wymaganego zakresu (allegro:api:sale:offers:read) albo bez dostępu do zasobu'))).toBe('UWIERZYTELNIENIE')
    expect(klasaBledu(new AdapterConfigError('Konto WOO/sklep1: brak sekretu WOO_KEY'))).toBe('KONFIGURACJA')
  })

  it('jawna klasa adaptera wygrywa z treścią; 429, 5xx i timeout bez klasy', () => {
    expect(klasaBledu(new AdapterError('import stanów Empik (STO01) niedostępny na tym koncie: HTTP 403', 'TRWALY', undefined, 'KONFIGURACJA'))).toBe('KONFIGURACJA')
    expect(klasaBledu({ message: 'Allegro /order/events: HTTP 429 (limit zapytań)' })).toBeNull()
    expect(klasaBledu({ message: 'Mirakl /api/orders: HTTP 503' })).toBeNull()
    expect(klasaBledu({ message: 'timeout po 30 s' })).toBeNull()
  })
})

describe('co liczy się do wyłączenia', () => {
  it('KONFIGURACJA przy zapisie nie wyłącza odczytu; przy odczycie tak; odrzucone poświadczenia zawsze', () => {
    expect(liczySie(true, 'KONFIGURACJA')).toBe(false)
    expect(liczySie(false, 'KONFIGURACJA')).toBe(true)
    expect(liczySie(true, 'UWIERZYTELNIENIE')).toBe(true)
    expect(liczySie(false, 'UWIERZYTELNIENIE')).toBe(true)
    expect(liczySie(true, null)).toBe(false)
  })
})

describe('„Włącz ponownie” z wyjściem awaryjnym', () => {
  it('zlecone przed chwilą = trwa (przycisk zablokowany); starsze niż 5 min = nieaktualne (przycisk aktywny)', () => {
    const od = new Date('2026-11-09T10:00:00Z')
    expect(wlaczanieTrwa({ wlaczanieOd: od }, new Date(od.getTime() + 60_000))).toBe(true)
    expect(wlaczanieTrwa({ wlaczanieOd: od }, new Date(od.getTime() + WLACZANIE_NIEAKTUALNE_MS + 1))).toBe(false)
    expect(wlaczanieTrwa({ wlaczanieOd: null }, od)).toBe(false)
  })
})
