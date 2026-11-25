// przesyłka DPD bezpośrednio, czyste funkcje. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { NADAWCA_TESTOWY, ODBIORCA_TESTOWY } from '../../tests/dpd-atrapa'
import { PII_SENTINELS } from '../adaptery/suita-kontraktowa'
import type { ShipmentInput } from '../adaptery/kontrakt'
import { ustawieniaDpd, wyliczPrzesylkeDpd } from './dpd'
import { LICZENIE_PRZESYLKI } from './moduly'
import { buildPackagesPayload, czyEmpik, odbiorcaDpd, parseNadawca, wagaDoDpd } from './zlecenie-dpd'

const USTAWIONE = ustawieniaDpd({ defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 })
const baza: ShipmentInput = { carrier: 'DPD', gabaryt: 'DPD', weightG: 2_000, weightComplete: true, paymentState: 'PAID', paymentMethod: 'Przelew', totalGross: 120, codAmountUncertain: null, pickupPoint: null }
const kody = (i: Partial<ShipmentInput>, u = USTAWIONE) => wyliczPrzesylkeDpd({ ...baza, ...i }, u).problems.map((p) => `${p.poziom}:${p.kod}`)

describe('wyliczPrzesylkeDpd', () => {
  it('kurier: wymiary i waga z ustawień, bez punktu i bez problemów', () => {
    expect(wyliczPrzesylkeDpd(baza, USTAWIONE)).toEqual({ courierCode: 'DPD_CLASSIC', gabaryt: 'DPD', sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 2, codAmount: null, pickupPoint: null, problems: [] })
  })

  it('kurier bez ustawień: robocze wymiary i waga z ostrzeżeniami (te same kody co Base Courier)', () => {
    const p = wyliczPrzesylkeDpd({ ...baza, weightG: null, weightComplete: false }, ustawieniaDpd({}))
    expect(p).toMatchObject({ courierCode: 'DPD_CLASSIC', sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 1 })
    expect(p.problems.map((x) => x.kod)).toEqual(['wymiary_domyslne', 'waga_domyslna'])
  })

  it('DPD z punktem = Pickup z kodem punktu', () => {
    expect(wyliczPrzesylkeDpd({ ...baza, pickupPoint: ' PL11033 ' }, USTAWIONE)).toMatchObject({ courierCode: 'DPD_PICKUP', pickupPoint: 'PL11033', problems: [] })
  })

  it('salon Empik: zawsze Pickup; z kodem salonu bez problemów (bez empik_niepotwierdzone); bez kodu BLAD punkt', () => {
    expect(wyliczPrzesylkeDpd({ ...baza, carrier: 'DPD_EMPIK', pickupPoint: 'PL99001' }, USTAWIONE)).toMatchObject({ courierCode: 'DPD_PICKUP', pickupPoint: 'PL99001' })
    expect(kody({ carrier: 'DPD_EMPIK', pickupPoint: 'PL99001' })).toEqual([])
    expect(kody({ carrier: 'DPD_EMPIK' })).toEqual(['BLAD:punkt'])
  })

  it('waga domyślna z ustawień firmy = INFO (bez potwierdzania), wbudowana = OSTRZEZENIE; liczba ta sama', () => {
    const zUstawien = wyliczPrzesylkeDpd({ ...baza, carrier: 'DPD_EMPIK', pickupPoint: 'PL99001', weightG: null, weightComplete: false }, ustawieniaDpd({ defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 5 }))
    expect(zUstawien.weightKg).toBe(5)
    expect(zUstawien.problems).toEqual([{ kod: 'waga_domyslna', poziom: 'INFO', tekst: 'Paczka pójdzie z wagą 5 kg z ustawień przewoźnika (produkty nie mają wpisanej wagi). Zmienisz ją w: Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników.' }])
    const wbudowana = wyliczPrzesylkeDpd({ ...baza, weightG: null, weightComplete: false }, ustawieniaDpd({ defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20 }))
    expect(wbudowana.weightKg).toBe(1)
    expect(wbudowana.problems.map((x) => `${x.poziom}:${x.kod}`)).toEqual(['OSTRZEZENIE:waga_domyslna'])
  })

  it('Pickup: limit 20 kg, kurier: limit z konfiguracji (domyślnie 31,5 kg)', () => {
    expect(kody({ pickupPoint: 'PL1', weightG: 20_000 })).toEqual([])
    expect(kody({ pickupPoint: 'PL1', weightG: 20_001 })).toEqual(['BLAD:waga_limit'])
    expect(kody({ weightG: 31_500 })).toEqual([])
    expect(kody({ weightG: 31_501 })).toEqual(['BLAD:waga_limit'])
    expect(kody({ weightG: 50_000 }, ustawieniaDpd({ defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, limitWagiKuriera: 70 }))).toEqual([])
    expect(ustawieniaDpd({ limitWagiKuriera: 701 }).problemy.map((p) => p.kod)).toEqual(['ustawienie'])
  })

  it('Pickup tylko jednopaczkowy: zamówienie dzielone = BLAD pickup_jedna_paczka (kurier bez tego błędu)', () => {
    expect(kody({ pickupPoint: 'PL1', codAmountUncertain: 'PODZIAL' })).toEqual(['BLAD:pickup_jedna_paczka'])
    expect(kody({ carrier: 'DPD_EMPIK', pickupPoint: 'PL1', codAmountUncertain: 'PODZIAL' })).toContain('BLAD:pickup_jedna_paczka')
    expect(kody({ codAmountUncertain: 'PODZIAL' })).toEqual([])
  })

  it('wymiary poza 1–300 cm i waga poniżej 0,01 kg = BLAD', () => {
    expect(kody({}, ustawieniaDpd({ defaultSideXCm: 301, defaultSideYCm: 30, defaultSideZCm: 20 }))).toEqual(['BLAD:wymiary_zakres'])
    expect(kody({}, ustawieniaDpd({ defaultSideXCm: 0, defaultSideYCm: 30, defaultSideZCm: 20 }))).toEqual(['BLAD:ustawienie', 'OSTRZEZENIE:wymiary_domyslne'])
    expect(kody({ weightG: 9 })).toEqual(['BLAD:waga_zakres'])
    expect(kody({ weightG: 10 })).toEqual([])
  })

  it('pobranie: kwota z zamówienia, nieznana = BLAD, ponad limit z konfiguracji = BLAD', () => {
    const cod = { paymentState: 'COD' as const, paymentMethod: 'Za pobraniem' }
    expect(wyliczPrzesylkeDpd({ ...baza, ...cod, totalGross: 149.9 }, USTAWIONE)).toMatchObject({ codAmount: 149.9, problems: [] })
    expect(kody({ ...cod, codAmountUncertain: 'BRAKI' })).toEqual(['BLAD:pobranie'])
    expect(kody({ ...cod, totalGross: 15_000.01 })).toEqual(['BLAD:pobranie_limit'])
    expect(kody({ ...cod, totalGross: 600 }, ustawieniaDpd({ defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, codLimit: 500 }))).toEqual(['BLAD:pobranie_limit'])
  })

  it('inny przewoźnik = BLAD przewoznik, bez kodu', () => {
    const p = wyliczPrzesylkeDpd({ ...baza, carrier: 'PACZKOMATY', gabaryt: 'INPOST_A' }, USTAWIONE)
    expect(p.courierCode).toBeNull()
    expect(p.problems.map((x) => x.kod)).toContain('przewoznik')
  })

  it('wpis w LICZENIE_PRZESYLKI liczy z konfiguracji reguły', () => {
    expect(LICZENIE_PRZESYLKI['dpd.services.v1']!(baza, { defaultSideXCm: 60, defaultSideYCm: 50, defaultSideZCm: 40 })).toMatchObject({ courierCode: 'DPD_CLASSIC', sideXCm: 60 })
  })
})

const ODB = odbiorcaDpd(ODBIORCA_TESTOWY, false).odbiorca!

describe('buildPackagesPayload', () => {
  const nadawca = parseNadawca({ nadawca: NADAWCA_TESTOWY }).nadawca!
  const ust = { payerFid: '1495', reference: 'ORD-1/1' }

  it('kurier: receiver z adresem, bez usług; ALL_OR_NOTHING', () => {
    const p = wyliczPrzesylkeDpd(baza, USTAWIONE)
    const body = buildPackagesPayload(p, ODB, nadawca, ust) as { generationPolicy: string; packages: Record<string, unknown>[] }
    expect(body.generationPolicy).toBe('ALL_OR_NOTHING')
    expect(body.packages[0]).toEqual({
      reference: 'ORD-1/1',
      payerFID: 1495,
      sender: { name: 'Firma Testowa', fullName: 'Firma Testowa sp. z o.o.', address: 'ul. Magazynowa 5', city: 'Testowo', postalCode: '00002', countryCode: 'PL', phone: '500000000', email: 'magazyn@example.invalid' },
      parcels: [{ weight: 2, sizeX: 40, sizeY: 30, sizeZ: 20 }],
      receiver: { name: PII_SENTINELS[0], address: `${PII_SENTINELS[3]} 1`, city: 'Testowo', postalCode: '00001', countryCode: 'PL', phone: PII_SENTINELS[2], email: PII_SENTINELS[1] },
    })
  })

  it('punkt i salon: pudoReceiver i DPD_PICKUP z PUDO; pobranie z AMOUNT i CURRENCY', () => {
    const p = wyliczPrzesylkeDpd({ ...baza, pickupPoint: 'PL11033', paymentState: 'COD', paymentMethod: 'Za pobraniem', totalGross: 99.5 }, USTAWIONE)
    const pkg = (buildPackagesPayload(p, ODB, nadawca, ust) as { packages: Record<string, unknown>[] }).packages[0]!
    expect(pkg['receiver']).toBeUndefined()
    expect(pkg['pudoReceiver']).toEqual({ countryCode: 'PL', name: PII_SENTINELS[0], phone: PII_SENTINELS[2], email: PII_SENTINELS[1] })
    expect(pkg['services']).toEqual([
      { code: 'DPD_PICKUP', attributes: [{ code: 'PUDO', value: 'PL11033' }] },
      { code: 'COD', attributes: [{ code: 'AMOUNT', value: '99.50' }, { code: 'CURRENCY', value: 'PLN' }] },
    ])
    // salon bez osobnego potwierdzenia
    const empik = wyliczPrzesylkeDpd({ ...baza, carrier: 'DPD_EMPIK', pickupPoint: 'PL99001' }, USTAWIONE)
    const pe = (buildPackagesPayload(empik, ODB, nadawca, ust) as { packages: Record<string, unknown>[] }).packages[0]!
    expect(pe['services']).toEqual([{ code: 'DPD_PICKUP', attributes: [{ code: 'PUDO', value: 'PL99001' }] }])
  })

  it('wymóg potwierdzenia ostrzeżeń i brak BLAD jak w buildCreateOrderPayload', () => {
    const robocza = wyliczPrzesylkeDpd({ ...baza, weightG: null, weightComplete: false }, ustawieniaDpd({}))
    expect(() => buildPackagesPayload(robocza, ODB, nadawca, ust)).toThrow(/wymiary_domyslne, waga_domyslna/)
    expect(() => buildPackagesPayload(robocza, ODB, nadawca, { ...ust, potwierdzoneOstrzezenia: ['wymiary_domyslne', 'waga_domyslna'] })).not.toThrow()
    const zla = wyliczPrzesylkeDpd({ ...baza, weightG: 40_000 }, USTAWIONE)
    expect(() => buildPackagesPayload(zla, ODB, nadawca, { ...ust, potwierdzoneOstrzezenia: ['waga_limit'] })).toThrow(/waga_limit/)
    expect(() => buildPackagesPayload(wyliczPrzesylkeDpd(baza, USTAWIONE), ODB, nadawca, { ...ust, payerFid: 'x' })).toThrow(/FID/)
  })

  it('odbiorcaDpd wymaga tylko pól API; numer domu, telefon i e-mail opcjonalne; kraj ≠ PL odrzucony', () => {
    expect(odbiorcaDpd({ ...ODBIORCA_TESTOWY, numerDomu: null, telefon: null, email: null }, false)).toMatchObject({ braki: [] })
    expect(odbiorcaDpd({ ...ODBIORCA_TESTOWY, ulica: null, kodPocztowy: null, miasto: null }, false)).toEqual({ odbiorca: null, braki: ['ulica', 'kodPocztowy', 'miasto'] })
    // punkt: adres nie jest potrzebny, nazwa tak (imię i nazwisko albo firma)
    expect(odbiorcaDpd({ ...ODBIORCA_TESTOWY, ulica: null, kodPocztowy: null, miasto: null }, true)).toMatchObject({ braki: [] })
    expect(odbiorcaDpd({ ...ODBIORCA_TESTOWY, imieNazwisko: null, firma: 'Firma Odbiorcy' }, true).odbiorca).toMatchObject({ nazwa: 'Firma Odbiorcy' })
    expect(odbiorcaDpd({ ...ODBIORCA_TESTOWY, imieNazwisko: null, firma: null }, true)).toEqual({ odbiorca: null, braki: ['imieNazwisko'] })
    expect(odbiorcaDpd({ ...ODBIORCA_TESTOWY, kraj: 'CZ' }, false)).toEqual({ odbiorca: null, braki: ['kraj'] })
    const pkg = (buildPackagesPayload(wyliczPrzesylkeDpd(baza, USTAWIONE), odbiorcaDpd({ ...ODBIORCA_TESTOWY, numerDomu: null, telefon: null }, false).odbiorca!, parseNadawca({ nadawca: NADAWCA_TESTOWY }).nadawca!, { payerFid: '1495', reference: 'R' }) as { packages: Record<string, unknown>[] }).packages[0]!
    expect(pkg['receiver']).toEqual({ name: PII_SENTINELS[0], address: PII_SENTINELS[3], city: 'Testowo', postalCode: '00001', countryCode: 'PL', email: PII_SENTINELS[1] })
  })

  it('salon Empik po przewoźniku, nie po ostrzeżeniu', () => {
    expect(czyEmpik('DPD_EMPIK')).toBe(true)
    expect(czyEmpik('DPD')).toBe(false)
  })

  it('parseNadawca: braki nazwami pól, domyślny kraj i pełna nazwa', () => {
    expect(parseNadawca({})).toEqual({ nadawca: null, braki: ['name', 'address', 'city', 'postalCode', 'phone'] })
    expect(parseNadawca({ nadawca: { ...NADAWCA_TESTOWY, fullName: undefined, email: '' } } as never).nadawca).toMatchObject({ fullName: 'Firma Testowa', countryCode: 'PL', email: null })
  })
})

// host składa nadawcę z profilu firmy, więc adapter DPD (i Base Courier) dostaje dane z
// Ustawienia → Dane firmy także bez `settings.nadawca`.
describe('nadawcaFirmy (host adaptera przewoźnika)', () => {
  it('sam profil firmy → pełny nadawca, który adapter DPD przyjmuje; nadpisanie nadawca wygrywa; braki wskazane dokładnie', async () => {
    const { nadawcaFirmy } = await import('./adapter-przewoznika')
    const { parseNadawca: parse } = await import('./zlecenie-dpd')
    const profil = { firma: { nazwa: 'Profil', adres: { ulica: 'ul. Profilowa 12', kodPocztowy: '61-100', miasto: 'Poznań' }, telefon: '612000000' } }
    const n = nadawcaFirmy(profil)!
    expect(n).toMatchObject({ name: 'Profil', address: 'ul. Profilowa 12', city: 'Poznań', postalCode: '61-100', phone: '612000000', countryCode: 'PL' })
    // tak czyta to adapter (lib/adaptery/dpd.ts, basecourier-zapis.ts): parseNadawca({ nadawca: <JSON z config> })
    expect(parse({ nadawca: JSON.parse(JSON.stringify(n)) }).braki).toEqual([])
    expect(nadawcaFirmy({ ...profil, nadawca: { address: 'ul. Nadania 1' } })).toMatchObject({ name: 'Profil', address: 'ul. Nadania 1' })
    const bezTel = nadawcaFirmy({ firma: { ...profil.firma, telefon: undefined } })!
    expect(parse({ nadawca: JSON.parse(JSON.stringify(bezTel)) }).braki).toEqual(['phone'])
    expect(nadawcaFirmy({})).toBeUndefined()
  })
})

describe('wagaDoDpd', () => {
  it('najwyżej dwa miejsca po przecinku, w górę do 10 g; pełne dziesiątki gramów bez zmiany', () => {
    expect(wagaDoDpd(0.144)).toBe(0.15)
    expect(wagaDoDpd(0.141)).toBe(0.15)
    expect(wagaDoDpd(0.058)).toBe(0.06)
    expect(wagaDoDpd(0.01)).toBe(0.01)
    expect(wagaDoDpd(0.2)).toBe(0.2)
    expect(wagaDoDpd(0.24)).toBe(0.24)
    expect(wagaDoDpd(0.29)).toBe(0.29)
    expect(wagaDoDpd(1.5)).toBe(1.5)
    expect(wagaDoDpd(19.999)).toBe(20)
    expect(wagaDoDpd(31.5)).toBe(31.5)
  })

  it('treść żądania niesie wagę zaokrągloną, a przesyłka zostaje z wagą z gramów', () => {
    const p = wyliczPrzesylkeDpd({ ...baza, weightG: 144 }, USTAWIONE)
    expect(p.weightKg).toBe(0.144)
    const nadawca = parseNadawca({ nadawca: NADAWCA_TESTOWY }).nadawca!
    const pkg = (buildPackagesPayload(p, ODB, nadawca, { payerFid: '1495', reference: 'ORD-1/1' }) as { packages: { parcels: { weight: number }[] }[] }).packages[0]!
    expect(pkg.parcels[0]!.weight).toBe(0.15)
  })
})
