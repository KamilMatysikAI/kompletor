// czysta logika przesyłki: gabaryty, kody kuriera, pobranie, punkt odbioru, limity wagi. Dane fikcyjne.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShipmentInput } from '../adaptery/kontrakt'
import { kodKuriera, kwotaPobrania, ustawieniaPrzesylki, wagaZeSkladu, wyliczPrzesylke } from './przesylka'
import { BASE_COURIER_ORIGIN, buildCreateOrderPayload, kontoPobranPoprawne, rozdzielAdres, zawartoscPrzesylki, zRozdzielonymAdresem, type OdbiorcaPrzesylki, type OpcjeZleceniaBaseCourier } from './zlecenie'

const BAZA: ShipmentInput = { carrier: 'PACZKOMATY', gabaryt: 'INPOST_A', weightG: 500, weightComplete: true, paymentState: 'PAID', paymentMethod: 'Przelewy24', totalGross: 120.5, codAmountUncertain: null, pickupPoint: 'POZ01A' }
const U = ustawieniaPrzesylki({})
const licz = (o: Partial<ShipmentInput> = {}, config: Record<string, unknown> = {}) => wyliczPrzesylke({ ...BAZA, ...o }, ustawieniaPrzesylki(config))
const kody = (p: { problems: { kod: string }[] }) => p.problems.map((x) => x.kod)

describe('gabaryt → wymiary', () => {
  it.each([
    ['INPOST_A', 8],
    ['INPOST_B', 19],
    ['INPOST_C', 41],
  ])('%s', (gabaryt, x) => {
    expect(licz({ gabaryt })).toMatchObject({ courierCode: 'paczkomaty', sideXCm: x, sideYCm: 38, sideZCm: 64, problems: [] })
  })

  it('paczkomat bez gabarytu albo z gabarytem innego przewoźnika = problem, bez wymiarów', () => {
    for (const gabaryt of [null, 'DPD', 'cokolwiek']) {
      const p = licz({ gabaryt })
      expect(p.sideXCm).toBeNull()
      expect(kody(p)).toContain('gabaryt')
    }
  })

  it('DPD: wymiary z konfiguracji; bez nich robocze z ostrzeżeniem', () => {
    const c = { defaultSideXCm: 30, defaultSideYCm: 20, defaultSideZCm: 10 }
    expect(licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null }, c)).toMatchObject({ sideXCm: 30, sideYCm: 20, sideZCm: 10, problems: [] })
    const p = licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null })
    expect(p).toMatchObject({ sideXCm: 40, sideYCm: 30, sideZCm: 20 })
    expect(p.problems).toEqual([expect.objectContaining({ kod: 'wymiary_domyslne', poziom: 'OSTRZEZENIE' })])
  })

  it('zła wartość konfiguracji = błąd na liście, nie cichy powrót', () => {
    for (const bad of [0, -1, 'abc', 10.5, 5000]) {
      expect(ustawieniaPrzesylki({ defaultSideXCm: bad }).problemy).toEqual([expect.objectContaining({ kod: 'ustawienie', poziom: 'BLAD' })])
    }
    expect(U.problemy).toEqual([])
    expect(ustawieniaPrzesylki({ defaultWeightKg: '1.5' }).weightKg).toBe(1.5)
  })
})

describe('przewoźnik → courier_code', () => {
  it('domyślne i nadpisanie z reguły', () => {
    expect(kodKuriera('PACZKOMATY')).toBe('paczkomaty')
    expect(kodKuriera('DPD')).toBe('dpd')
    expect(kodKuriera('DPD_EMPIK')).toBe('dpd')
    expect(kodKuriera('PACZKOMATY', 'paczkomaty_eco')).toBe('paczkomaty_eco')
    expect(kodKuriera('ALLEGRO')).toBeNull()
  })

  it('nieznany kod z reguły = problem, nie cichy domyślny', () => {
    const p = licz({ courierCode: 'wymyslony' })
    expect(p.courierCode).toBeNull()
    expect(kody(p)).toContain('kod_kuriera')
  })
})

describe('pobranie', () => {
  const d = { paymentMethod: 'Przelew', totalGross: 99.9, kwotaNiepewna: null }
  it('opłacone = bez pobrania, także przy metodzie „za pobraniem”', () => {
    expect(kwotaPobrania({ ...d, paymentState: 'PAID', paymentMethod: 'Za pobraniem' })).toEqual({ kwota: null, problemy: [] })
  })

  it('COD: kwota równa totalGross', () => {
    expect(kwotaPobrania({ ...d, paymentState: 'COD' })).toEqual({ kwota: 99.9, problemy: [] })
    expect(licz({ paymentState: 'COD', totalGross: 120.5 }).codAmount).toBe(120.5)
  })

  it('metoda „pobranie” przy stanie UNPAID liczy się jak COD', () => {
    for (const m of ['Płatność przy odbiorze', 'Za pobraniem', 'COD']) expect(kwotaPobrania({ ...d, paymentState: 'UNPAID', paymentMethod: m }).kwota).toBe(99.9)
    expect(kwotaPobrania({ ...d, paymentState: 'UNPAID', paymentMethod: 'Encoder' }).kwota).toBeNull()
  })

  it('nieznana kwota = problem, nigdy 0', () => {
    for (const x of [
      { ...d, paymentState: 'COD' as const, totalGross: null },
      { ...d, paymentState: 'COD' as const, totalGross: 0 },
      { ...d, paymentState: 'COD' as const, totalGross: Number.NaN },
      { ...d, paymentState: 'COD' as const, kwotaNiepewna: 'BRAKI' as const },
      { ...d, paymentState: 'COD' as const, kwotaNiepewna: 'PODZIAL' as const },
      { ...d, paymentState: 'COD' as const, kwotaNiepewna: 'ODRZUCONE' as const },
      { ...d, paymentState: 'PARTIAL' as const, paymentMethod: 'Za pobraniem' },
    ]) {
      const r = kwotaPobrania(x)
      expect(r.kwota).toBeNull()
      expect(r.problemy).toEqual([expect.objectContaining({ kod: 'pobranie', poziom: 'BLAD' })])
    }
  })

  it('powód nieznanej kwoty mówi, co się stało', () => {
    const tekst = (kwotaNiepewna: 'BRAKI' | 'BRAKI_SPAKOWANE' | 'PODZIAL' | 'ODRZUCONE') => kwotaPobrania({ ...d, paymentState: 'COD', kwotaNiepewna }).problemy[0]!.tekst
    expect(tekst('BRAKI')).toMatch(/zmieni się po spakowaniu/)
    expect(tekst('BRAKI_SPAKOWANE')).toMatch(/spakowana z brakami, kwotę pobrania pomniejsz/)
    expect(tekst('PODZIAL')).toMatch(/w kilku paczkach/)
    expect(tekst('ODRZUCONE')).toMatch(/odrzucone przy akceptacji/)
  })

  it('pobranie z samej nazwy metody przy UNPAID: kwota zostaje, ale jest ostrzeżenie', () => {
    expect(kwotaPobrania({ ...d, paymentState: 'UNPAID', paymentMethod: 'Za pobraniem' })).toEqual({ kwota: 99.9, problemy: [expect.objectContaining({ kod: 'pobranie_z_metody', poziom: 'OSTRZEZENIE' })] })
  })

  it('nieopłacone bez pobrania = ostrzeżenie', () => {
    expect(kwotaPobrania({ ...d, paymentState: 'UNPAID' }).problemy).toEqual([expect.objectContaining({ kod: 'nieoplacone', poziom: 'OSTRZEZENIE' })])
  })
})

describe('punkt odbioru', () => {
  it('paczkomat i salon Empik bez punktu = problem; DPD kurier bez punktu w porządku', () => {
    expect(kody(licz({ pickupPoint: null }))).toContain('punkt')
    expect(kody(licz({ pickupPoint: '  ' }))).toContain('punkt')
    expect(licz({ pickupPoint: null }).problems.find((p) => p.kod === 'punkt')?.tekst).toBe('Brak punktu odbioru w danych zamówienia.')
    expect(kody(licz({ carrier: 'DPD_EMPIK', gabaryt: 'DPD', pickupPoint: null }))).toContain('punkt')
    expect(kody(licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null }))).not.toContain('punkt')
  })
})

describe('waga', () => {
  it('ze składu: gramatura towaru na wagę, sztuki bez wagi', () => {
    expect(wagaZeSkladu([{ ilosc: 100, jednostka: 'g' }, { ilosc: 250, jednostka: 'g' }])).toEqual({ gramy: 350, pelna: true })
    expect(wagaZeSkladu([{ ilosc: 100, jednostka: 'g' }, { ilosc: 2, jednostka: 'szt' }])).toEqual({ gramy: 100, pelna: false })
    expect(wagaZeSkladu([]).pelna).toBe(false)
  })

  it('sztuki z wagą z karty produktu liczą się do wagi paczki', () => {
    expect(wagaZeSkladu([{ ilosc: 100, jednostka: 'g' }, { ilosc: 2, jednostka: 'szt', wagaSztukiG: 350 }])).toEqual({ gramy: 800, pelna: true })
    expect(wagaZeSkladu([{ ilosc: 3, jednostka: 'szt', wagaSztukiG: 120 }, { ilosc: 1, jednostka: 'szt', wagaSztukiG: null }])).toEqual({ gramy: 360, pelna: false })
    expect(wagaZeSkladu([{ ilosc: 1, jednostka: 'szt', wagaSztukiG: 0 }])).toEqual({ gramy: 0, pelna: false })
  })

  it('bez wagi: domyślna z konfiguracji (INFO, ustawiona przez firmę) albo wbudowana (OSTRZEZENIE); znana część większa od domyślnej wygrywa', () => {
    const p = licz({ weightG: null, weightComplete: false }, { defaultWeightKg: 2 })
    expect(p.weightKg).toBe(2)
    expect(p.problems).toEqual([expect.objectContaining({ kod: 'waga_domyslna', poziom: 'INFO' })])
    const w = licz({ weightG: null, weightComplete: false }, {})
    expect(w.weightKg).toBe(1)
    expect(w.problems.find((x) => x.kod === 'waga_domyslna')).toMatchObject({ poziom: 'OSTRZEZENIE' })
    expect(licz({ weightG: 3000, weightComplete: false }, { defaultWeightKg: 2 }).weightKg).toBe(3)
  })

  it('znana część cięższa od domyślnej to waga niepełna, nie domyślna', () => {
    const tekst = (o: Partial<ShipmentInput>) => licz(o, { defaultWeightKg: 2 }).problems.find((p) => p.kod === 'waga_domyslna')!.tekst
    // tekst mówi, z jaką wagą paczka pójdzie i gdzie to zmienić; niepełna zostaje ostrzeżeniem
    expect(tekst({ weightG: 3000, weightComplete: false })).toBe('Paczka pójdzie z wagą 3 kg: tyle ważą produkty z wpisaną wagą, część produktów nie ma wagi. Brakującą wagę wpiszesz w: Produkty → karta produktu, pole „Waga (g)”.')
    expect(licz({ weightG: 3000, weightComplete: false }, { defaultWeightKg: 2 }).problems.find((p) => p.kod === 'waga_domyslna')!.poziom).toBe('OSTRZEZENIE')
    expect(tekst({ weightG: 500, weightComplete: false })).toBe('Paczka pójdzie z wagą 2 kg z ustawień przewoźnika (produkty nie mają wpisanej wagi). Zmienisz ją w: Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników.')
    expect(licz({ weightG: null, weightComplete: false }, { defaultWeightKg: 0.5 }).problems.find((x) => x.kod === 'waga_domyslna')!.tekst).toContain('wagą 0,5 kg')
    expect(licz({ weightG: null, weightComplete: false }, {}).problems.find((x) => x.kod === 'waga_domyslna')!.tekst).toBe('Paczka pójdzie z wagą 1 kg: produkty nie mają wpisanej wagi, a firma nie ustawiła wagi domyślnej. Ustawisz ją w: Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników.')
  })

  it('limity: 25 kg, DPD Pickup i salon 20 kg', () => {
    expect(kody(licz({ weightG: 25_000 }))).not.toContain('waga_limit')
    expect(kody(licz({ weightG: 25_001 }))).toContain('waga_limit')
    expect(kody(licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null, weightG: 21_000 }))).not.toContain('waga_limit')
    expect(kody(licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: 'PL123', weightG: 20_001 }))).toContain('waga_limit')
    expect(kody(licz({ carrier: 'DPD_EMPIK', gabaryt: 'DPD', pickupPoint: 'PL123', weightG: 20_000 }))).not.toContain('waga_limit')
    expect(kody(licz({ carrier: 'DPD_EMPIK', gabaryt: 'DPD', pickupPoint: 'PL123', weightG: 20_001 }))).toContain('waga_limit')
  })
})

describe('buildCreateOrderPayload (createOrderV2)', () => {
  const ODBIORCA: OdbiorcaPrzesylki = { imieNazwisko: 'Jan Testowy', ulica: 'Testowa', numerDomu: '1', kodPocztowy: '00-001', miasto: 'Testowo', telefon: '600100200', email: 'jan.testowy@example.invalid' }
  const OPCJE: OpcjeZleceniaBaseCourier = {
    nadawca: { nazwa: 'Firma Testowa', ulica: 'Magazynowa', numerDomu: '5', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', telefon: '611000000', email: 'sklep@example.invalid' },
    zawartosc: 'ref. r-1',
    kontoPobran: '11 1111 1111 1111 1111 1111 1111',
    platnosc: 'bank',
    bezPodjazdu: true,
  }

  it('CourierSearch z gabarytem i pobraniem, Cart[0].Order z nadawcą, odbiorcą, punktem i zawartością; CartOrder; bez uwierzytelnienia', () => {
    const b = buildCreateOrderPayload(licz({ paymentState: 'COD' }), ODBIORCA, [], OPCJE)
    // `origin` wymagany przez API (dokumentacja: CourierSearchDto.required; wycena bez niego = błąd walidacji)
    expect(b['CourierSearch']).toEqual({ courier_code: 'paczkomaty', type: 'package', side_x: 8, side_y: 38, side_z: 64, weight: 0.5, country_code: 'PL', foreign: '0', no_pickup: true, origin: BASE_COURIER_ORIGIN, uptake: 120.5 })
    expect(BASE_COURIER_ORIGIN).toBe('kompletor')
    // ubezpieczenie tylko z opcji
    expect(buildCreateOrderPayload(licz({ paymentState: 'COD' }), ODBIORCA, [], { ...OPCJE, ubezpieczenie: 'pobranie' })['CourierSearch']).toMatchObject({ uptake: 120.5, cover: 120.5 })
    const order = (b['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order
    expect(order).toMatchObject({ name: 'Firma Testowa', street: 'Magazynowa', house_no: '5', postal: '60-001', account: '11111111111111111111111111', taker_name: 'Jan Testowy', taker_email: 'jan.testowy@example.invalid', taker_point: 'POZ01A', package_content: 'ref. r-1' })
    expect(b['CartOrder']).toEqual({ payment: 'bank' })
    expect(b).not.toHaveProperty('auth')
  })

  it('bez pobrania i punktu: pól uptake i cover nie ma, taker_point pusty, account z rachunku firmy; płatność odroczona i podjazd z opcji', () => {
    const b = buildCreateOrderPayload(licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null }), ODBIORCA, ['wymiary_domyslne'], { ...OPCJE, platnosc: 'pay_later', bezPodjazdu: false })
    expect(b['CourierSearch']).not.toHaveProperty('uptake')
    expect(b['CourierSearch']).not.toHaveProperty('cover')
    expect(b['CourierSearch']).toMatchObject({ courier_code: 'dpd', no_pickup: false })
    const order = (b['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order
    // dokumentacja: OrderDto.required ma `taker_point` i `account`; bez punktu pusty tekst (jak formularz wtyczki)
    expect(order).toMatchObject({ taker_point: '', account: '11111111111111111111111111' })
    expect(b['CourierSearch']).toMatchObject({ origin: BASE_COURIER_ORIGIN })
    expect(b['CartOrder']).toEqual({ payment: 'pay_later' })
    // bez rachunku firmy i bez pobrania: `account` nie idzie (dokumentacja nie mówi, co wtedy wysłać)
    for (const kontoPobran of [null, '123']) {
      const bez = (buildCreateOrderPayload(licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null }), ODBIORCA, ['wymiary_domyslne'], { ...OPCJE, kontoPobran })['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order
      expect(bez).not.toHaveProperty('account')
      expect(bez).toMatchObject({ taker_point: '' })
    }
  })

  it('pobranie bez poprawnego rachunku na zwrot pobrań: brak treści zlecenia', () => {
    expect(() => buildCreateOrderPayload(licz({ paymentState: 'COD' }), ODBIORCA, [], { ...OPCJE, kontoPobran: null })).toThrow(/rachunku do zwrotu pobrań/)
    expect(() => buildCreateOrderPayload(licz({ paymentState: 'COD' }), ODBIORCA, [], { ...OPCJE, kontoPobran: '123' })).toThrow(/rachunku/)
  })

  it('przesyłka z błędem nie daje treści zlecenia', () => {
    expect(() => buildCreateOrderPayload(licz({ pickupPoint: null }), ODBIORCA, [], OPCJE)).toThrow(/punkt/)
  })

  // przy punkcie odbioru adres domowy nie wpływa na doręczenie. Pola `taker_street` i `taker_house_no` są
  // w dokumentacji wymagane, więc idą zawsze, ale bez wymyślonego numeru: linia adresu bez zmian, numer pusty.
  it('punkt odbioru bez numeru domu: linia adresu bez zmian, numer pusty, nic nie dopisane; kurier bez numeru = brak treści', () => {
    const order = (b: Record<string, unknown>) => (b['Cart'] as { Order: Record<string, unknown> }[])[0]!.Order
    const bezNumeru = { ...ODBIORCA, ulica: 'Lipowa 7 3', numerDomu: null }
    expect(order(buildCreateOrderPayload(licz(), bezNumeru, [], OPCJE))).toMatchObject({ taker_point: 'POZ01A', taker_street: 'Lipowa 7 3', taker_house_no: '', taker_locum_no: '' })
    expect(order(buildCreateOrderPayload(licz(), { ...ODBIORCA, ulica: null, numerDomu: null }, [], OPCJE))).toMatchObject({ taker_street: '', taker_house_no: '' })
    const kurier = licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null })
    expect(() => buildCreateOrderPayload(kurier, bezNumeru, ['wymiary_domyslne'], OPCJE)).toThrow(/numer domu/)
    expect(() => buildCreateOrderPayload(kurier, { ...ODBIORCA, ulica: null }, ['wymiary_domyslne'], OPCJE)).toThrow(/ulica/)
  })

  it('wartości robocze bez potwierdzenia nie dają treści zlecenia; potwierdzenie błędu nic nie zmienia', () => {
    const dpd = licz({ carrier: 'DPD', gabaryt: 'DPD', pickupPoint: null, weightG: null, weightComplete: false })
    expect(() => buildCreateOrderPayload(dpd, ODBIORCA, [], OPCJE)).toThrow(/wymiary_domyslne, waga_domyslna/)
    expect(() => buildCreateOrderPayload(dpd, ODBIORCA, ['wymiary_domyslne'], OPCJE)).toThrow(/waga_domyslna/)
    expect(buildCreateOrderPayload(dpd, ODBIORCA, ['wymiary_domyslne', 'waga_domyslna'], OPCJE)['CourierSearch']).toMatchObject({ side_x: 40, weight: 1 })
    expect(() => buildCreateOrderPayload(licz({ pickupPoint: null }), ODBIORCA, ['punkt'], OPCJE)).toThrow(/punkt/)
  })

  it('pomocnicze: rachunek pobrań, adres nadawcy, zawartość z referencją', () => {
    expect(kontoPobranPoprawne('PL11 1111 1111 1111 1111 1111 1111')).toBe('11111111111111111111111111')
    expect(kontoPobranPoprawne('1111')).toBeNull()
    expect(rozdzielAdres('ul. Magazynowa 12A/3')).toEqual({ ulica: 'ul. Magazynowa', numerDomu: '12A', numerLokalu: '3' })
    expect(rozdzielAdres('Os. Słoneczne 7 lok. 2')).toEqual({ ulica: 'Os. Słoneczne', numerDomu: '7', numerLokalu: '2' })
    expect(rozdzielAdres('Bez numeru')).toBeNull()
    expect(rozdzielAdres('E.Testowa, 8, 24')).toEqual({ ulica: 'E.Testowa', numerDomu: '8', numerLokalu: '24' })
    expect(rozdzielAdres('Testowa 8, 24')).toEqual({ ulica: 'Testowa', numerDomu: '8', numerLokalu: '24' })
    expect(rozdzielAdres('Testowa, 8')).toEqual({ ulica: 'Testowa', numerDomu: '8', numerLokalu: null })
    // Hotfix 19.11.2026: adres kanału w jednej linii rozdzielany przy nadaniu; niejednoznaczny zostaje bez zmian
    const baza = { ulica: 'Ul. Testowa 9c/6', numerDomu: null, numerLokalu: null, miasto: 'Testowo' }
    expect(zRozdzielonymAdresem(baza)).toEqual({ ulica: 'Ul. Testowa', numerDomu: '9c', numerLokalu: '6', miasto: 'Testowo' })
    expect(zRozdzielonymAdresem({ ...baza, ulica: '3 Maja 15' })).toMatchObject({ ulica: '3 Maja', numerDomu: '15', numerLokalu: null })
    expect(zRozdzielonymAdresem({ ...baza, ulica: 'Testowa 5-7' })).toMatchObject({ ulica: 'Testowa 5-7', numerDomu: null })
    expect(zRozdzielonymAdresem({ ...baza, ulica: 'Testowa 2', numerDomu: '1' })).toMatchObject({ ulica: 'Testowa 2', numerDomu: '1' })
    expect(zRozdzielonymAdresem({ ...baza, ulica: null })).toMatchObject({ ulica: null, numerDomu: null })
    expect(zawartoscPrzesylki('abc', 'SD-123')).toBe('ref. abc; zam. SD-123')
    expect(zawartoscPrzesylki('abc', 'z'.repeat(31))).toBe('ref. abc')
  })

  it('podgląd i adapter tylko do odczytu nie sięgają po treść zlecenia', () => {
    for (const f of ['lib/wysylka/podglad.ts', 'lib/adaptery/basecourier.ts']) {
      expect(readFileSync(path.join(process.cwd(), f), 'utf8')).not.toContain('buildCreateOrderPayload')
    }
  })
})

describe('rozdzielAdres: tylko zapis jednoznaczny', () => {
  const r = (adres: string) => rozdzielAdres(adres)
  const dom = (ulica: string, numerDomu: string, numerLokalu: string | null = null) => ({ ulica, numerDomu, numerLokalu })

  it.each([
    ['Lipowa 7', dom('Lipowa', '7')],
    ['Lipowa 7/3', dom('Lipowa', '7', '3')],
    ['Lipowa 7 m. 3', dom('Lipowa', '7', '3')],
    ['Lipowa 7 m 3', dom('Lipowa', '7', '3')],
    ['Lipowa 7, 3', dom('Lipowa', '7', '3')],
    ['E.Plater, 8, 24', dom('E.Plater', '8', '24')],
    ['3 Maja 5', dom('3 Maja', '5')],
    ['al. 11 Listopada 12/3', dom('al. 11 Listopada', '12', '3')],
    ['Lipowa 12A', dom('Lipowa', '12A')],
    ['Osiedle Leśne 5B/12', dom('Osiedle Leśne', '5B', '12')],
  ])('%s → rozdzielone', (adres, oczekiwane) => {
    expect(r(adres)).toEqual(oczekiwane)
  })

  it.each([
    'Lipowa',
    'ul. 3 Maja',
    'ul. 3 maja',
    'al. 1 maja',
    'Testowa 5-7',
    'Kwiatowa 12 A',
    'Lipowa 7 kl. 2 m. 3',
    'Lipowa 7 klatka B',
    'Lipowa nr 7',
    '12 5',
    'Lipowa 7/3 3',
  ])('%s → null (niejednoznaczne)', (adres) => {
    expect(r(adres)).toBeNull()
  })

  it.each([
    ['Lipowa 7 3', dom('Lipowa', '7', '3')],
    ['Lipowa 7 lokal 3', dom('Lipowa', '7', '3')],
    ['Lipowa 7 mieszkanie 3', dom('Lipowa', '7', '3')],
    ['Rynek 1, lokal 2', dom('Rynek', '1', '2')],
    ['Bema 3, m 4', dom('Bema', '3', '4')],
    ['Lipowa 7 apt 3', dom('Lipowa', '7', '3')],
  ])('%s → poprawnie albo null, nigdy ostatnia liczba jako numer domu', (adres, oczekiwane) => {
    const w = r(adres)
    if (w !== null) expect(w).toEqual(oczekiwane)
  })

  it('Woo: address_1 „Lipowa 7” + address_2 „3” (sklejone spacją) nie daje domu 3', () => {
    const w = zRozdzielonymAdresem({ ulica: 'Lipowa 7 3', numerDomu: null, numerLokalu: null })
    expect(w.numerDomu === null || w.numerDomu === '7').toBe(true)
    if (w.numerDomu === '7') expect(w).toMatchObject({ ulica: 'Lipowa', numerLokalu: '3' })
  })

  it('Woo: address_2 z dowolnym tekstem zostawia adres bez rozdziału', () => {
    expect(zRozdzielonymAdresem({ ulica: 'Lipowa 7 II piętro', numerDomu: null, numerLokalu: null })).toMatchObject({ ulica: 'Lipowa 7 II piętro', numerDomu: null })
    expect(zRozdzielonymAdresem({ ulica: 'ul. 3 maja', numerDomu: null, numerLokalu: null })).toMatchObject({ ulica: 'ul. 3 maja', numerDomu: null, numerLokalu: null })
  })
})
