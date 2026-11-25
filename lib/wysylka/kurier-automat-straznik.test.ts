// Strażnik: ustawienie konta „Zamawiaj kuriera automatycznie” istnieje tylko w modułach, które umieją zamówić kuriera
// (zdolność `shipment.pickup`) i zamawiają podjazd na dzień; automat działa po zdolności, nie po nazwie modułu. Moduły
// po przesyłkach (`pickupPerShipment`, np. Wysyłam z Allegro) automat pomija, więc pole byłoby tam martwym włącznikiem.
import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '../adaptery/domyslne'
import { POLE_AUTOMATU } from './zamowienie-kuriera'

describe('pole automatu kuriera tylko przy zdolności shipment.pickup', () => {
  it('każdy manifest z polem ma zdolność, a pole jest tak/nie i nie jest wymagane', () => {
    const z = defaultRegistry()
      .list()
      .filter((m) => m.config.some((f) => f.key === POLE_AUTOMATU))
    expect(z.length).toBeGreaterThan(0)
    for (const m of z) {
      expect(m.capabilities, m.adapterKey).toContain('shipment.pickup')
      expect(m.pickupPerShipment, m.adapterKey).not.toBe(true)
      expect(m.config.find((f) => f.key === POLE_AUTOMATU), m.adapterKey).toMatchObject({ type: 'boolean', required: false })
    }
  })
})
