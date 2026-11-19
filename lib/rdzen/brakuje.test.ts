// Odmowa podziału i „Dośle później” przy etykiecie za pobraniem nie obiecuje
// „Anuluj przesyłkę” tam, gdzie moduł przewoźnika nie anuluje z Kompletora.
import { describe, expect, it } from 'vitest'
import { GLS_ZAPIS_KEY } from '../adaptery/gls'
import { komunikatPodzialuPoEtykiecie, KOMUNIKAT_PODZIAL_PO_ETYKIECIE, przewoznicyAnulujaZKompletora } from './brakuje'

describe('komunikatPodzialuPoEtykiecie', () => {
  it('przewoźnik anuluje z Kompletora: komunikat jak dotąd, z „najpierw anuluj przesyłkę”', () => {
    expect(komunikatPodzialuPoEtykiecie(true)).toBe(KOMUNIKAT_PODZIAL_PO_ETYKIECIE)
    expect(komunikatPodzialuPoEtykiecie(true)).toBe(
      'Zamówienie za pobraniem ma już przesyłkę u przewoźnika z kwotą pobrania sprzed podziału: najpierw anuluj przesyłkę, potem podziel zamówienie albo dośli brak',
    )
  })

  it('przewoźnik bez anulowania: wprost, że w Kompletorze się nie da, bez „najpierw anuluj”, z drogą ręczną', () => {
    const k = komunikatPodzialuPoEtykiecie(false)
    expect(k).toBe(
      'Zamówienie za pobraniem ma już przesyłkę u przewoźnika z kwotą pobrania sprzed podziału, a tej przesyłki nie da się anulować w Kompletorze (ten przewoźnik nie anuluje przesyłek z Kompletora). ' +
        'Podziału ani „Dośle później” przy pobraniu z gotową etykietą nie zrobisz. Zrób to ręcznie: wyślij to, co jest („Wyślij resztę”), ' +
        'zmień kwotę pobrania na tej przesyłce w panelu przewoźnika, a brakujący towar wyślij później osobnym zamówieniem (Zamówienia → Dodaj zamówienie)',
    )
    expect(k).not.toMatch(/najpierw anuluj/)
  })
})

describe('przewoznicyAnulujaZKompletora (manifest modułu)', () => {
  it('Base Courier i Wysyłam z Allegro z zapisem anulują; DPD, InPost ShipX i GLS nie', async () => {
    expect(await przewoznicyAnulujaZKompletora(['basecourier.zapis.v1'])).toBe(true)
    expect(await przewoznicyAnulujaZKompletora(['allegro.wysylam.zapis.v1'])).toBe(true)
    expect(await przewoznicyAnulujaZKompletora(['dpd.services.zapis.v1'])).toBe(false)
    expect(await przewoznicyAnulujaZKompletora(['inpost.shipx.zapis.v1'])).toBe(false)
    expect(await przewoznicyAnulujaZKompletora([GLS_ZAPIS_KEY])).toBe(false)
  })

  it('moduł tylko do odczytu albo nieznany = bez anulowania; jedna przesyłka bez anulowania przesądza o całej rodzinie', async () => {
    expect(await przewoznicyAnulujaZKompletora(['basecourier.v1'])).toBe(false)
    expect(await przewoznicyAnulujaZKompletora(['nieznany.modul.v1'])).toBe(false)
    expect(await przewoznicyAnulujaZKompletora(['basecourier.zapis.v1', 'dpd.services.zapis.v1'])).toBe(false)
  })
})
