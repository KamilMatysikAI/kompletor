// parametry przesyłki InPost ShipX (czyste funkcje) i treść utworzenia przesyłki. Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import type { ShipmentInput } from '../adaptery/kontrakt'
import { PII_SENTINELS } from '../adaptery/suita-kontraktowa'
import { ustawieniaInpost, wyliczPrzesylkeInpost } from './inpost'
import { LICZENIE_PRZESYLKI } from './moduly'
import { buildShipmentPayload, telefonShipx } from './zlecenie-inpost'

const PACZKOMAT: ShipmentInput = { carrier: 'PACZKOMATY', gabaryt: 'INPOST_A', weightG: 500, weightComplete: true, paymentState: 'PAID', paymentMethod: 'Przelew', totalGross: 120, codAmountUncertain: null, pickupPoint: 'KRA010' }
const KURIER: ShipmentInput = { ...PACZKOMAT, carrier: 'INPOST_KURIER', gabaryt: 'INPOST_KURIER', pickupPoint: null }
const COD = { paymentState: 'COD', paymentMethod: 'Za pobraniem' } as const
const kody = (i: ShipmentInput, config: Record<string, unknown> = {}) => wyliczPrzesylkeInpost(i, ustawieniaInpost(config)).problems.map((p) => p.kod)

const ODBIORCA = { imieNazwisko: PII_SENTINELS[0]!, ulica: PII_SENTINELS[3]!, numerDomu: '1', numerLokalu: '2', kodPocztowy: '00-001', miasto: 'Testowo', telefon: '600 100 200', email: PII_SENTINELS[1]! }

describe('wyliczPrzesylkeInpost', () => {
  it.each([
    ['INPOST_A', [8, 38, 64]],
    ['INPOST_B', [19, 38, 64]],
    ['INPOST_C', [41, 38, 64]],
  ] as const)('paczkomat %s: usługa paczkomatowa i wymiary gabarytu', (gabaryt, [x, y, z]) => {
    const p = wyliczPrzesylkeInpost({ ...PACZKOMAT, gabaryt }, ustawieniaInpost({}))
    expect(p).toMatchObject({ courierCode: 'inpost_locker_standard', gabaryt, sideXCm: x, sideYCm: y, sideZCm: z, weightKg: 0.5, codAmount: null, pickupPoint: 'KRA010', problems: [] })
  })

  it('paczkomat bez gabarytu A/B/C albo bez punktu = BLAD', () => {
    expect(kody({ ...PACZKOMAT, gabaryt: 'DPD' })).toContain('gabaryt')
    expect(kody({ ...PACZKOMAT, gabaryt: null })).toContain('gabaryt')
    expect(kody({ ...PACZKOMAT, pickupPoint: null })).toEqual(['punkt'])
    expect(kody({ ...PACZKOMAT, pickupPoint: '  ' })).toEqual(['punkt'])
  })

  it('kurier: usługa kurierska, wymiary i waga z ustawień, bez punktu', () => {
    const p = wyliczPrzesylkeInpost({ ...KURIER, weightG: null, weightComplete: false, pickupPoint: 'KRA010' }, ustawieniaInpost({ defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30, defaultWeightKg: 2 }))
    expect(p).toMatchObject({ courierCode: 'inpost_courier_standard', sideXCm: 50, sideYCm: 40, sideZCm: 30, weightKg: 2, pickupPoint: null })
    expect(p.problems.map((x) => x.kod)).toEqual(['waga_domyslna'])
  })

  it('kurier bez ustawień: wartości robocze z ostrzeżeniami (te same kody co Base Courier)', () => {
    const p = wyliczPrzesylkeInpost({ ...KURIER, weightG: null, weightComplete: false }, ustawieniaInpost({}))
    expect(p).toMatchObject({ sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 1 })
    expect(p.problems.map((x) => x.kod)).toEqual(['wymiary_domyslne', 'waga_domyslna'])
    expect(p.problems.every((x) => x.poziom === 'OSTRZEZENIE')).toBe(true)
  })

  it('inny przewoźnik niż InPost = BLAD kodu usługi', () => {
    expect(kody({ ...PACZKOMAT, carrier: 'DPD' })).toContain('kod_kuriera')
  })

  it('limit wagi 25 kg', () => {
    expect(kody({ ...PACZKOMAT, weightG: 25_000 })).toEqual([])
    expect(kody({ ...PACZKOMAT, weightG: 25_001 })).toEqual(['waga_limit'])
    expect(kody({ ...KURIER, weightG: 30_000 }, { defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30 })).toEqual(['waga_limit'])
  })

  it('pobranie: kwota z zamówienia, ostrzeżenie o ubezpieczeniu; limit z konfiguracji', () => {
    const p = wyliczPrzesylkeInpost({ ...PACZKOMAT, ...COD }, ustawieniaInpost({ codLimit: 5000 }))
    expect(p.codAmount).toBe(120)
    // paczkomat z pobraniem dostaje ostrzeżenie o punkcie (nie każdy paczkomat przyjmuje pobranie)
    expect(p.problems.map((x) => x.kod)).toEqual(['pobranie_punkt', 'pobranie_ubezpieczenie'])
    expect(p.problems.every((x) => x.poziom === 'OSTRZEZENIE')).toBe(true)
    // kurier jedzie pod adres: bez ostrzeżenia o punkcie
    expect(wyliczPrzesylkeInpost({ ...KURIER, ...COD }, ustawieniaInpost({ codLimit: 5000, defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30 })).problems.map((x) => x.kod)).not.toContain('pobranie_punkt')
    expect(kody({ ...PACZKOMAT, ...COD, totalGross: 5000.01 }, { codLimit: 5000 })).toContain('pobranie_limit')
    expect(kody({ ...PACZKOMAT, ...COD })).toEqual(['pobranie_limit_nieznany', 'pobranie_punkt', 'pobranie_ubezpieczenie'])
    expect(kody({ ...PACZKOMAT, ...COD }, { codLimit: 'abc' })).toContain('ustawienie')
  })

  it('pobranie bez kwoty = BLAD, nigdy 0', () => {
    const p = wyliczPrzesylkeInpost({ ...PACZKOMAT, ...COD, totalGross: null }, ustawieniaInpost({ codLimit: 5000 }))
    expect(p.codAmount).toBeNull()
    expect(p.problems).toEqual([expect.objectContaining({ kod: 'pobranie', poziom: 'BLAD' })])
    expect(kody({ ...PACZKOMAT, ...COD, codAmountUncertain: 'BRAKI' })).toEqual(['pobranie'])
  })

  it('wpis w LICZENIE_PRZESYLKI dla obu kluczy', () => {
    expect(LICZENIE_PRZESYLKI['inpost.shipx.v1']!(PACZKOMAT, {})).toEqual(wyliczPrzesylkeInpost(PACZKOMAT, ustawieniaInpost({})))
    expect(LICZENIE_PRZESYLKI['inpost.shipx.zapis.v1']!(KURIER, { codLimit: 100 }).courierCode).toBe('inpost_courier_standard')
  })
})

describe('buildShipmentPayload', () => {
  const ust = { sendingMethod: 'dispatch_order' }

  it('paczkomat: szablon, punkt docelowy, sposób nadania, odbiorca tylko w treści', () => {
    const parcel = wyliczPrzesylkeInpost({ ...PACZKOMAT, gabaryt: 'INPOST_B' }, ustawieniaInpost({}))
    const b = buildShipmentPayload(parcel, ODBIORCA, ust)
    expect(b).toMatchObject({ service: 'inpost_locker_standard', parcels: [{ template: 'medium' }], custom_attributes: { sending_method: 'dispatch_order', target_point: 'KRA010' } })
    expect(b['receiver']).toMatchObject({ first_name: 'Jan', last_name: 'Testowy', phone: '600100200', address: { building_number: '1/2', post_code: '00-001', country_code: 'PL' } })
    expect(b).not.toHaveProperty('cod')
    expect(b).not.toHaveProperty('reference')
  })

  it('paczkomat z niepełnym adresem = bez `address`; pełny adres idzie jak dotąd; kurier bez numeru = brak treści', () => {
    const parcel = wyliczPrzesylkeInpost(PACZKOMAT, ustawieniaInpost({}))
    expect(buildShipmentPayload(parcel, { ...ODBIORCA, numerDomu: null }, ust)['receiver']).not.toHaveProperty('address')
    expect(buildShipmentPayload(parcel, { ...ODBIORCA, ulica: null, numerDomu: null, kodPocztowy: null, miasto: null }, ust)['receiver']).toMatchObject({ phone: '600100200' })
    const kurier = wyliczPrzesylkeInpost(KURIER, ustawieniaInpost({ defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30 }))
    expect(() => buildShipmentPayload(kurier, { ...ODBIORCA, numerDomu: null }, ust)).toThrow(/adres/)
  })

  it('kurier: wymiary w mm i waga w kg, bez punktu', () => {
    const parcel = wyliczPrzesylkeInpost(KURIER, ustawieniaInpost({ defaultSideXCm: 50, defaultSideYCm: 40, defaultSideZCm: 30 }))
    const b = buildShipmentPayload(parcel, ODBIORCA, ust)
    expect(b).toMatchObject({ service: 'inpost_courier_standard', parcels: [{ dimensions: { length: 500, width: 400, height: 300, unit: 'mm' }, weight: { amount: 0.5, unit: 'kg' } }] })
    expect((b['custom_attributes'] as Record<string, unknown>)['target_point']).toBeUndefined()
  })

  it('pobranie: cod i ubezpieczenie na tę samą kwotę, ale dopiero po potwierdzeniu ostrzeżeń', () => {
    const parcel = wyliczPrzesylkeInpost({ ...PACZKOMAT, ...COD }, ustawieniaInpost({ codLimit: 5000 }))
    expect(() => buildShipmentPayload(parcel, ODBIORCA, ust)).toThrow(/pobranie_punkt, pobranie_ubezpieczenie/)
    expect(() => buildShipmentPayload(parcel, ODBIORCA, ust, ['pobranie_ubezpieczenie'])).toThrow(/pobranie_punkt/)
    const b = buildShipmentPayload(parcel, ODBIORCA, ust, ['pobranie_punkt', 'pobranie_ubezpieczenie'])
    expect(b).toMatchObject({ cod: { amount: 120, currency: 'PLN' }, insurance: { amount: 120, currency: 'PLN' } })
  })

  it('BLAD nie przechodzi nawet z potwierdzeniem; komunikat bez danych odbiorcy', () => {
    const parcel = wyliczPrzesylkeInpost({ ...PACZKOMAT, pickupPoint: null }, ustawieniaInpost({}))
    let msg = ''
    try {
      buildShipmentPayload(parcel, ODBIORCA, ust, ['punkt'])
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/punkt/)
    for (const p of PII_SENTINELS) expect(msg).not.toContain(p)
  })

  it('telefon z prefiksem +48 / 0048 / 48 i separatorami → 9 cyfr', () => {
    for (const t of ['+48 600 100 200', '+48600100200', '0048 600-100-200', '48600100200', '(+48) 600.100.200', '600 100 200']) expect(telefonShipx(t)).toBe('600100200')
    const parcel = wyliczPrzesylkeInpost({ ...PACZKOMAT, gabaryt: 'INPOST_A' }, ustawieniaInpost({}))
    expect(buildShipmentPayload(parcel, { ...ODBIORCA, telefon: '+48 600 100 200' }, ust)['receiver']).toMatchObject({ phone: '600100200' })
  })

  it('telefon, z którego nie wychodzi 9 cyfr = błąd „telefon” bez wartości numeru', () => {
    const parcel = wyliczPrzesylkeInpost({ ...PACZKOMAT, gabaryt: 'INPOST_A' }, ustawieniaInpost({}))
    for (const t of ['+49 600 100 200', '60010020', '6001002001', '+48 600 100 20', 'tel. 600100200', '']) {
      expect(() => telefonShipx(t)).toThrow('Przesyłka nie jest gotowa: telefon')
      let msg = ''
      try {
        buildShipmentPayload(parcel, { ...ODBIORCA, telefon: t }, ust)
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toBe('Przesyłka nie jest gotowa: telefon')
    }
  })

  it('kraj inny niż PL = błąd „kraj”; PL albo brak kraju przechodzi', () => {
    const parcel = wyliczPrzesylkeInpost({ ...PACZKOMAT, gabaryt: 'INPOST_A' }, ustawieniaInpost({}))
    expect(() => buildShipmentPayload(parcel, { ...ODBIORCA, kraj: 'DE' }, ust)).toThrow('Przesyłka nie jest gotowa: kraj')
    expect(buildShipmentPayload(parcel, { ...ODBIORCA, kraj: 'pl' }, ust)['receiver']).toMatchObject({ address: { country_code: 'PL' } })
    expect(buildShipmentPayload(parcel, { ...ODBIORCA, kraj: null }, ust)['receiver']).toMatchObject({ address: { country_code: 'PL' } })
  })
})
