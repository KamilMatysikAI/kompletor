// kolumna „Klient” listy zamówień — nazwa z rekordu (czysta funkcja) i odczyt strony jednym zapytaniem
// (`klienciNaLiscie`) na sztucznej bazie: uprawnienie, paczka dodatkowa, uszkodzony rekord, jeden wpis w dzienniku.
// Dane fikcyjne, bez bazy.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({ organizationIdOf: () => 'org-test' }))

import type { OrderRecipient } from '../adaptery/kontrakt'
import { klienciNaLiscie, PODGLAD_AUDIT } from './odczyt'
import { klientNaLiscie, rekordZOdbiorcy, type RekordKlienta } from './rekord'
import { kluczeKlientowZEnv, zaszyfrujKlienta } from './szyfr'

const ENV = { CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}` }

const odbiorca = (imie: string, firma: string | null): OrderRecipient => ({
  dostawa: { imieNazwisko: imie, firma, ulica: 'ul. Fikcyjna 1', numerDomu: null, numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48 500 000 000', email: 'test@example.test' },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
})

describe('klientNaLiscie', () => {
  it('firma, gdy jest, inaczej imię i nazwisko, na końcu nazwa z faktury', () => {
    expect(klientNaLiscie(rekordZOdbiorcy(odbiorca('Jan Testowy', 'Testowa Sp. z o.o.')))).toBe('Testowa Sp. z o.o.')
    expect(klientNaLiscie(rekordZOdbiorcy(odbiorca('Jan Testowy', null)))).toBe('Jan Testowy')
    const tylkoFaktura: RekordKlienta = { ...rekordZOdbiorcy(odbiorca('  ', null)), dostawa: null, nabywca: null, faktura: { nazwa: 'Fikcja SA', nip: null, ulica: null, kodPocztowy: null, miasto: null, kraj: null } }
    expect(klientNaLiscie(tylkoFaktura)).toBe('Fikcja SA')
    expect(klientNaLiscie({ ...tylkoFaktura, faktura: null })).toBeNull()
  })
})

function sztucznaBaza(rola: string, rekordy: Record<string, RekordKlienta | 'zly'>) {
  const ring = kluczeKlientowZEnv(ENV)
  const wiersze = Object.entries(rekordy).map(([orderId, r]) =>
    r === 'zly' ? { orderId, ciphertext: Buffer.from('zle'), iv: Buffer.alloc(12), authTag: Buffer.alloc(16), keyVersion: 1 } : { orderId, ...zaszyfrujKlienta(ring, 'org-test', orderId, r) },
  )
  const findMany = vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) => wiersze.filter((w) => where.orderId.in.includes(w.orderId)))
  const create = vi.fn(async () => ({}))
  const db = { membership: { findFirst: vi.fn(async () => ({ role: rola, permissions: [], deniedPermissions: [] })) }, orderCustomer: { findMany }, auditLog: { create } }
  return { db: db as never, findMany, create }
}

describe('klienciNaLiscie', () => {
  const rekordy = { a: rekordZOdbiorcy(odbiorca('Jan Testowy', null)), glowne: rekordZOdbiorcy(odbiorca('Anna Fikcyjna', 'Fikcja SA')), zepsute: 'zly' as const }

  it('jedno zapytanie na stronę, paczka dodatkowa z danych zamówienia głównego, uszkodzony rekord pomija jeden wiersz', async () => {
    const { db, findMany, create } = sztucznaBaza('WLASCICIEL', rekordy)
    const m = await klienciNaLiscie(db, [{ id: 'a' }, { id: 'paczka', parentOrderId: 'glowne' }, { id: 'zepsute' }, { id: 'bez-danych' }], { actorId: 'u1', env: ENV })
    expect([...m.entries()]).toEqual([
      ['a', 'Jan Testowy'],
      ['paczka', 'Fikcja SA'],
    ])
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    const wpis = (create.mock.calls[0] as unknown as [{ data: { entity: string; after: Record<string, unknown> } }])[0].data
    expect(wpis.entity).toBe(PODGLAD_AUDIT)
    expect(wpis.after).toEqual({ cel: 'PODGLAD', zakres: 'PELNY', lista: true, trafienia: 2, zamowienia: ['a', 'paczka'] })
    // w dzienniku bez danych osobowych
    expect(JSON.stringify(wpis)).not.toMatch(/Jan|Anna|Fikcja/)
  })

  it('bez `klienci.dane` (magazyn ma tylko skrót) i bez klucza: pusta mapa, bez odczytu', async () => {
    const mag = sztucznaBaza('MAGAZYN', rekordy)
    expect((await klienciNaLiscie(mag.db, [{ id: 'a' }], { actorId: 'u1', env: ENV })).size).toBe(0)
    expect(mag.findMany).not.toHaveBeenCalled()
    const bezKlucza = sztucznaBaza('WLASCICIEL', rekordy)
    expect((await klienciNaLiscie(bezKlucza.db, [{ id: 'a' }], { actorId: 'u1', env: {} })).size).toBe(0)
    expect(bezKlucza.findMany).not.toHaveBeenCalled()
    const system = sztucznaBaza('WLASCICIEL', rekordy)
    expect((await klienciNaLiscie(system.db, [{ id: 'a' }], { actorId: 'system:x', env: ENV })).size).toBe(0)
  })
})
