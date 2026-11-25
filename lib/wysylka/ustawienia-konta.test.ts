// ustawienia konta przewoźnika nakładane na konfigurację reguły (czyste funkcje, bez bazy).
import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '../adaptery/domyslne'
import { idKontaPrzewoznika, konfiguracjaZKontem, maKontoPrzewoznika, nalozUstawieniaKonta, ustawieniaKont } from './ustawienia-konta'

const settings = (ustawienia: unknown) => ({ przewoznicy: { testy: {}, ustawienia } })

describe('ustawienia konta przewoźnika', () => {
  it('id konta: rodzina adaptera i sufiks drugiego konta', () => {
    expect(idKontaPrzewoznika('dpd.services.zapis.v1', null)).toBe('dpd')
    expect(idKontaPrzewoznika('dpd.services.v1', 'EMPIK')).toBe('dpd~EMPIK')
    expect(idKontaPrzewoznika('basecourier.zapis.v1', null)).toBe(idKontaPrzewoznika('basecourier.v1', null))
  })

  it('rejestr: moduły jednego konta (te same klucze) mają ten sam pierwszy człon klucza, różne konta różny', () => {
    const rodziny = new Map<string, Set<string>>()
    for (const m of defaultRegistry().list()) {
      if (!maKontoPrzewoznika(m)) continue
      const r = m.secrets.map((s) => s.name).sort().join(',')
      rodziny.set(r, (rodziny.get(r) ?? new Set()).add(idKontaPrzewoznika(m.adapterKey, null)))
    }
    expect(rodziny.size).toBeGreaterThan(3)
    for (const ids of rodziny.values()) expect(ids.size).toBe(1)
    const wszystkie = [...rodziny.values()].map((s) => [...s][0])
    expect(new Set(wszystkie).size).toBe(wszystkie.length)
  })

  it('odczyt z ustawień firmy pomija śmieci i ustawienia ukryte', () => {
    expect(ustawieniaKont(settings({ dpd: { payerFid: '1', baseUrl: 'https://x', zapisWlaczony: true, zle: { a: 1 }, n: Number.NaN, wyczyszczone: null }, puste: {}, tekst: 'x' }))).toEqual({ dpd: { payerFid: '1', wyczyszczone: null } })
    expect(ustawieniaKont(null)).toEqual({})
    expect(ustawieniaKont({ przewoznicy: [] })).toEqual({})
  })

  it('nakładanie: pole konta wygrywa, null usuwa wartość reguły, pola bez wpisu zostają z reguły, ukryte nietknięte', () => {
    const regula = { baseUrl: 'https://demo', payerFid: '1', masterFid: '2', defaultWeightKg: 1, zapisWlaczony: true }
    expect(nalozUstawieniaKonta(regula, { payerFid: '9', masterFid: null, baseUrl: 'https://inny' })).toEqual({ baseUrl: 'https://demo', payerFid: '9', defaultWeightKg: 1, zapisWlaczony: true })
    expect(nalozUstawieniaKonta(regula, undefined)).toEqual(regula)
    expect(regula.payerFid).toBe('1')
  })

  it('konfiguracja reguły: konto z sufiksu reguły; Wysyłam z Allegro i reguła bez modułu bez zmian', () => {
    const s = settings({ dpd: { payerFid: '1' }, 'dpd~EMPIK': { payerFid: '7' }, allegro: { defaultWeightKg: 5 } })
    expect(konfiguracjaZKontem(s, 'dpd.services.zapis.v1', {})).toEqual({ payerFid: '1' })
    expect(konfiguracjaZKontem(s, 'dpd.services.zapis.v1', { sekretyKonta: 'EMPIK' })).toEqual({ sekretyKonta: 'EMPIK', payerFid: '7' })
    expect(konfiguracjaZKontem(s, 'allegro.wysylam.zapis.v1', { defaultWeightKg: 1 })).toEqual({ defaultWeightKg: 1 })
    expect(konfiguracjaZKontem(s, null, { a: 1 })).toEqual({ a: 1 })
  })
})
