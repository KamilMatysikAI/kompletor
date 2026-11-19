// Orlen Paczka w wysyłce: liczenie przesyłki z reguły, moduł z klucza adaptera, rozmiary na stanowisku,
// pola „Rozstrzygnij ręcznie”, pomocnicze funkcje zlecenia. Czyste funkcje, bez sieci i bazy.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SHIPPING_ADAPTER } from '../adaptery'
import { defaultRegistry } from '../adaptery/domyslne'
import { PICKUP_CARRIERS } from '../pakowanie/harmonogram'
import { CARRIER_LABEL } from '../panel/format'
import { gabarytyDla, podpowiedzGabarytu } from '../stanowisko/gabaryty'
import { LICZENIE_PRZESYLKI, maLiczeniePrzesylki } from './moduly'
import { identyfikatorPoprawny, MARGINES_ZAWIESZENIA_MS, opisRozstrzygniecia, progZawieszenia } from './nadanie'
import { NAJDLUZSZE_UTWORZENIE_MS } from '../adaptery/orlenpaczka'
import { kodPunktuOrlen } from './orlenpaczka'
import { modulAdaptera, modulyWysylki } from './reguly'
import { nadawcaOrlen, odciskReferencji, podzielAdres, telefonOrlen } from './zlecenie-orlenpaczka'

const REF = 'a1b2c3d4-e5f6-5789-8abc-def012345678'

describe('Orlen Paczka w wysyłce', () => {
  it('moduł i domyślny adapter: ORLEN_PACZKA ↔ orlenpaczka.v1; oba klucze liczą przesyłkę i są na liście modułów', () => {
    expect(DEFAULT_SHIPPING_ADAPTER.ORLEN_PACZKA).toBe('orlenpaczka.v1')
    expect(modulAdaptera('orlenpaczka.v1')).toBe('ORLEN_PACZKA')
    expect(modulAdaptera('orlenpaczka.zapis.v1')).toBe('ORLEN_PACZKA')
    expect(maLiczeniePrzesylki('orlenpaczka.v1')).toBe(true)
    expect(maLiczeniePrzesylki('orlenpaczka.zapis.v1')).toBe(true)
    const p = LICZENIE_PRZESYLKI['orlenpaczka.v1']({ carrier: 'ORLEN_PACZKA', gabaryt: 'ORLEN_S', weightG: 500, weightComplete: true, paymentState: 'PAID', paymentMethod: 'przelew', totalGross: 50, codAmountUncertain: null, pickupPoint: 'XX-116263-00-00' }, {})
    expect(p).toMatchObject({ courierCode: 'S', sideXCm: 8, problems: [] })
    expect(modulyWysylki(defaultRegistry()).map((m) => m.wartosc)).toEqual(expect.arrayContaining(['orlenpaczka.v1', 'orlenpaczka.zapis.v1']))
    expect(CARRIER_LABEL.ORLEN_PACZKA).toBe('Orlen Paczka')
    expect(PICKUP_CARRIERS).toContain('ORLEN_PACZKA')
    // „Sprawdź u przewoźnika” przy zawieszonej przesyłce dopiero po najgorszym czasie nadania z odszukaniem
    expect(progZawieszenia('orlenpaczka.zapis.v1')).toBe(NAJDLUZSZE_UTWORZENIE_MS + MARGINES_ZAWIESZENIA_MS)
    expect(NAJDLUZSZE_UTWORZENIE_MS).toBeGreaterThan(4 * 60_000)
  })

  it('stanowisko: rozmiary S/M/L dla Orlen Paczki, podpowiedź od najmniejszego; inni przewoźnicy bez zmian', () => {
    expect(gabarytyDla('ORLEN_PACZKA')).toEqual(['ORLEN_S', 'ORLEN_M', 'ORLEN_L'])
    expect(podpowiedzGabarytu('ORLEN_PACZKA', [{ ilosc: 2, jednostka: 'szt' }])).toBe('ORLEN_S')
    expect(podpowiedzGabarytu('ORLEN_PACZKA', [{ ilosc: 5, jednostka: 'szt' }])).toBe('ORLEN_M')
    expect(podpowiedzGabarytu('ORLEN_PACZKA', [{ ilosc: 20, jednostka: 'szt' }])).toBe('ORLEN_L')
    expect(podpowiedzGabarytu('PACZKOMATY', [{ ilosc: 5, jednostka: 'szt' }])).toBe('INPOST_B')
    expect(gabarytyDla(null)).not.toContain('ORLEN_S')
  })

  it('„Rozstrzygnij ręcznie”: numer 13 cyfr, podpowiedź z odciskiem z etykiety', () => {
    expect(identyfikatorPoprawny('orlenpaczka.zapis.v1', '2100000000017')).toBe(true)
    for (const z of ['210000000001', '21000000000170', 'ABC0000000017']) expect(identyfikatorPoprawny('orlenpaczka.zapis.v1', z)).toBe(false)
    const o = opisRozstrzygniecia('orlenpaczka.zapis.v1', REF)
    expect(o.etykietaNumeru).toMatch(/13 cyfr/)
    expect(o.wskazowka).toContain(odciskReferencji(REF))
  })

  it('odcisk referencji: 30 znaków, deterministyczny, różny dla różnych referencji; zbyt krótka referencja odrzucona', () => {
    expect(odciskReferencji(REF)).toBe('KMPA1B2C3D4E5F657898ABCDEF0123')
    expect(odciskReferencji(REF)).toHaveLength(30)
    expect(odciskReferencji('a1b2c3d4-e5f6-5789-8abc-def012345679')).toBe(odciskReferencji(REF)) // ostatnie znaki poza odciskiem
    expect(odciskReferencji('b1b2c3d4-e5f6-5789-8abc-def012345678')).not.toBe(odciskReferencji(REF))
    expect(() => odciskReferencji('ref-1')).toThrow()
  })

  it('telefon, adres nadawcy i kod punktu', () => {
    expect(['600100200', '+48 600 100 200', '0048600100200', '48-600-100-200'].map(telefonOrlen)).toEqual(['600100200', '600100200', '600100200', '600100200'])
    expect(telefonOrlen('12345')).toBeNull()
    expect(podzielAdres('ul. Magazynowa 5/2')).toEqual({ ulica: 'Magazynowa', budynek: '5', lokal: '2' })
    expect(podzielAdres('Aleje 3 Maja 12A m. 4')).toEqual({ ulica: 'Aleje 3 Maja', budynek: '12A', lokal: '4' })
    expect(podzielAdres('Prosta 1234')).toEqual({ ulica: 'Prosta', budynek: '1234', lokal: null })
    expect(podzielAdres('Magazynowa')).toBeNull()
    const n = nadawcaOrlen({ name: 'Firma', fullName: 'Firma', address: 'Prosta 1', city: 'Poznań', postalCode: '60001', countryCode: 'PL', phone: '500000000', email: 'a@example.invalid' })
    expect(n.nadawca).toMatchObject({ SenderPostCode: '60-001', SenderStreetName: 'Prosta', SenderBuildingNumber: '1' })
    expect(kodPunktuOrlen('ws-116263-c3-01')).toBe('WS-116263-C3-01')
    expect(kodPunktuOrlen('POP-WAW123')).toBeNull()
  })
})
