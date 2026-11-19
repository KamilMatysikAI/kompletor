// przesyłka Wysyłam z Allegro (czyste funkcje): gabaryty, waga i limit, pobranie, parser propozycji dostawy
// i treść komendy `create-commands` na danych fikcyjnych. Bez sieci i bez bazy.
import { describe, expect, it } from 'vitest'
import { deliveryProposal, defaultOption } from '@/tests/allegro-wysylam-atrapa'
import { PII_SENTINELS } from '../adaptery/suita-kontraktowa'
import { UnreadableDataError, type ShipmentInput } from '../adaptery/kontrakt'
import { parseDeliveryOptions, wyliczPrzesylkeAllegro } from './allegro'
import { ustawieniaPrzesylki } from './przesylka'
import { buildCreateCommandPayload } from './zlecenie-allegro'

const baza: ShipmentInput = { carrier: 'ALLEGRO', gabaryt: 'ALLEGRO_A', weightG: 600, weightComplete: true, paymentState: 'PAID', paymentMethod: 'ONLINE (P24)', totalGross: 59.9, codAmountUncertain: null, pickupPoint: null }
const u = ustawieniaPrzesylki({})
const kody = (i: ShipmentInput, c: Record<string, unknown> = {}) => wyliczPrzesylkeAllegro(i, ustawieniaPrzesylki(c)).problems.map((p) => p.kod)

describe('wyliczPrzesylkeAllegro', () => {
  it.each([
    ['ALLEGRO_A', [8, 38, 64]],
    ['ALLEGRO_B', [19, 38, 64]],
    ['ALLEGRO_C', [41, 38, 64]],
  ] as const)('%s → %j cm, zawsze z ostrzeżeniem wymiary_domyslne; bez kodu kuriera i punktu bez problemu', (gabaryt, w) => {
    const p = wyliczPrzesylkeAllegro({ ...baza, gabaryt }, u)
    expect([p.sideXCm, p.sideYCm, p.sideZCm]).toEqual(w)
    expect(p).toMatchObject({ courierCode: null, pickupPoint: null, gabaryt, weightKg: 0.6, codAmount: null })
    expect(p.problems.map((x) => x.kod)).toEqual(['wymiary_domyslne'])
    expect(p.problems[0]!.poziom).toBe('OSTRZEZENIE')
  })

  it.each(['INPOST_A', 'DPD', 'nieznany', null])('gabaryt „%s” = BLAD gabaryt, bez wymiarów', (gabaryt) => {
    const p = wyliczPrzesylkeAllegro({ ...baza, gabaryt }, u)
    expect(p.problems.find((x) => x.kod === 'gabaryt')?.poziom).toBe('BLAD')
    expect(p.problems.map((x) => x.kod)).not.toContain('wymiary_domyslne')
    expect([p.sideXCm, p.sideYCm, p.sideZCm]).toEqual([null, null, null])
  })

  it('waga: domyślna z ustawień z ostrzeżeniem, ponad limit 25 kg = BLAD', () => {
    expect(kody({ ...baza, weightG: null, weightComplete: false })).toContain('waga_domyslna')
    expect(wyliczPrzesylkeAllegro({ ...baza, weightG: null, weightComplete: false }, ustawieniaPrzesylki({ defaultWeightKg: 3 })).weightKg).toBe(3)
    expect(kody({ ...baza, weightG: 25_000 })).not.toContain('waga_limit')
    const ciezka = wyliczPrzesylkeAllegro({ ...baza, weightG: 25_001 }, u)
    expect(ciezka.problems.find((x) => x.kod === 'waga_limit')).toMatchObject({ poziom: 'BLAD', tekst: expect.stringContaining('do potwierdzenia') })
  })

  it('pobranie: COD = kwota i ostrzeżenie pobranie_konto; nieznana kwota = BLAD bez ostrzeżenia o koncie', () => {
    const cod = wyliczPrzesylkeAllegro({ ...baza, paymentState: 'COD', paymentMethod: 'CASH_ON_DELIVERY' }, u)
    expect(cod.codAmount).toBe(59.9)
    expect(cod.problems.find((x) => x.kod === 'pobranie_konto')).toMatchObject({ poziom: 'OSTRZEZENIE', tekst: expect.stringContaining('numeru konta') })
    const niepewna = wyliczPrzesylkeAllegro({ ...baza, paymentState: 'COD', paymentMethod: 'CASH_ON_DELIVERY', codAmountUncertain: 'BRAKI' }, u)
    expect(niepewna.codAmount).toBeNull()
    expect(niepewna.problems.map((x) => x.kod)).toEqual(expect.arrayContaining(['pobranie']))
    expect(niepewna.problems.map((x) => x.kod)).not.toContain('pobranie_konto')
    expect(kody({ ...baza, paymentState: 'UNPAID', paymentMethod: 'ONLINE' })).toContain('nieoplacone')
  })

  it('zła wartość ustawienia przechodzi na listę problemów', () => {
    expect(kody(baza, { defaultWeightKg: 'abc' })).toContain('ustawienie')
  })
})

describe('parseDeliveryOptions', () => {
  it('liczby jako tekst i jako liczba; jednostki przeliczone; brak limitów = null', () => {
    const r = parseDeliveryOptions(
      deliveryProposal('o', [
        defaultOption({ limits: { dimensions: { length: { value: '640', unit: 'MILLIMETER' }, width: 38 }, weight: { value: 500, unit: 'GRAMS' } } }),
        defaultOption({ packageType: 'DOX', deliveryType: undefined, limits: undefined }),
      ]),
    )
    expect(r).toEqual([
      { deliveryType: 'Allegro Paczkomaty InPost', packageType: 'PACKAGE', limits: { cashOnDelivery: null, insurance: null, dimensions: { lengthCm: 64, widthCm: 38, heightCm: null }, weightKg: 0.5 } },
      { deliveryType: null, packageType: 'DOX', limits: { cashOnDelivery: null, insurance: null, dimensions: null, weightKg: null } },
    ])
  })

  it('wynik bez suggestedInput i dodatkowych pól', () => {
    const json = JSON.stringify(parseDeliveryOptions(deliveryProposal('o')))
    for (const p of [...PII_SENTINELS, 'suggestedInput', 'additional', 'paymentType', 'originCountry']) expect(json).not.toContain(p)
  })

  it.each([
    ['nie obiekt', null],
    ['bez listy', { deliveryOptions: {} }],
    ['opcja nie obiekt', { deliveryOptions: [1] }],
    ['nieznany packageType', { deliveryOptions: [defaultOption({ packageType: 'KOPERTA' })] }],
    ['kwota „abc”', { deliveryOptions: [defaultOption({ limits: { cashOnDelivery: { amount: 'abc', currency: 'PLN' } } })] }],
    ['kwota bez waluty', { deliveryOptions: [defaultOption({ limits: { insurance: { amount: '10.00' } } })] }],
    ['waga ujemna', { deliveryOptions: [defaultOption({ limits: { weight: { value: -1, unit: 'KILOGRAMS' } } })] }],
    ['nieznana jednostka', { deliveryOptions: [defaultOption({ limits: { weight: { value: 1, unit: 'POUNDS' } } })] }],
    ['wymiar pusty tekst', { deliveryOptions: [defaultOption({ limits: { dimensions: { length: { value: '', unit: 'CENTIMETER' } } } })] }],
    ['wymiary nie obiekt', { deliveryOptions: [defaultOption({ limits: { dimensions: 'duże' } })] }],
  ])('%s = UnreadableDataError (nigdy 0)', (_n, body) => {
    expect(() => parseDeliveryOptions(body)).toThrow(UnreadableDataError)
  })

  it('komunikat błędu bez wartości z odpowiedzi', () => {
    const e = (() => {
      try {
        parseDeliveryOptions({ deliveryOptions: [defaultOption({ packageType: PII_SENTINELS[0] })] })
      } catch (x) {
        return x as Error
      }
    })()
    expect(e?.message).not.toContain(PII_SENTINELS[0])
  })
})

describe('buildCreateCommandPayload (dane fikcyjne)', () => {
  const draft = wyliczPrzesylkeAllegro({ ...baza, gabaryt: 'ALLEGRO_B', paymentState: 'COD', paymentMethod: 'CASH_ON_DELIVERY' }, u)
  const sugg = deliveryProposal('o')['suggestedInput']
  const opcje = { commandId: '3f2b6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', labelFormat: 'PDF' as const, referenceNumber: 'KMP-1' }

  it('bez potwierdzenia ostrzeżeń = błąd z samymi kodami', () => {
    expect(() => buildCreateCommandPayload(draft, sugg, opcje)).toThrow(/wymiary_domyslne, pobranie_konto/)
  })

  it('nadpisuje tylko packages i cashOnDelivery; bez deliveryMethodId i credentialsId; reszta z propozycji', () => {
    const p = buildCreateCommandPayload(draft, sugg, opcje, ['wymiary_domyslne', 'pobranie_konto'])
    const input = p['input'] as Record<string, unknown>
    expect(p['commandId']).toBe(opcje.commandId)
    expect(input['packages']).toEqual([{ type: 'PACKAGE', length: { value: 64, unit: 'CENTIMETER' }, width: { value: 38, unit: 'CENTIMETER' }, height: { value: 19, unit: 'CENTIMETER' }, weight: { value: 0.6, unit: 'KILOGRAMS' } }])
    expect(input['cashOnDelivery']).toEqual({ amount: '59.90', currency: 'PLN', ownerName: 'Sprzedawca Fikcyjny', iban: 'PL00000000000000000000000000' })
    expect(input).not.toHaveProperty('deliveryMethodId')
    expect(input).not.toHaveProperty('credentialsId')
    expect(input['sender']).toEqual((sugg as Record<string, unknown>)['sender'])
    expect(input['receiver']).toEqual((sugg as Record<string, unknown>)['receiver'])
    expect(input).toMatchObject({ labelFormat: 'PDF', referenceNumber: 'KMP-1', additionalServices: ['ADDITIONAL_HANDLING'] })
    expect(String((input['cashOnDelivery'] as { amount: string }).amount)).toMatch(/^\d+[.,]\d{1,2}$/)
  })

  it('bez pobrania: cashOnDelivery z propozycji usunięte', () => {
    const oplacona = wyliczPrzesylkeAllegro(baza, u)
    const input = buildCreateCommandPayload(oplacona, sugg, opcje, ['wymiary_domyslne'])['input'] as Record<string, unknown>
    expect(input).not.toHaveProperty('cashOnDelivery')
  })

  it('BLAD, zły commandId, zły format etykiety, brak odbiorcy = błąd bez danych osobowych', () => {
    const zly = wyliczPrzesylkeAllegro({ ...baza, gabaryt: 'DPD' }, u)
    expect(() => buildCreateCommandPayload(zly, sugg, opcje, ['gabaryt'])).toThrow(/gabaryt/)
    const ok = wyliczPrzesylkeAllegro(baza, u)
    expect(() => buildCreateCommandPayload(ok, sugg, { ...opcje, commandId: 'x' }, ['wymiary_domyslne'])).toThrow(/UUID/)
    expect(() => buildCreateCommandPayload(ok, sugg, { ...opcje, labelFormat: 'PNG' as never }, ['wymiary_domyslne'])).toThrow(/labelFormat/)
    const bez = { ...(sugg as Record<string, unknown>), receiver: undefined }
    const e = (() => {
      try {
        buildCreateCommandPayload(ok, bez, opcje, ['wymiary_domyslne'])
      } catch (x) {
        return x as Error
      }
    })()
    expect(e?.message).toMatch(/odbiorcy/)
    for (const p of PII_SENTINELS) expect(e?.message).not.toContain(p)
  })
})
