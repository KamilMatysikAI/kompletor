// (3b-2, pkt 4): przebieg masowy „Przygotuj oferty” czyta listę kont, ustawienia ofert i tworzy adapter
// każdego konta RAZ na przebieg; przy N produktach liczba tych odczytów nie rośnie z N (rosną tylko odczyty produktu).
// Konta i adaptery jako atrapy (bez kanałów i sieci), baza jako atrapa liczników.
import type { PrismaClient } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelAccountSettings } from '@/lib/adaptery/konta'

const liczniki = { konta: 0, adaptery: 0, ustawienia: 0, produkty: 0, zakres: 0 }

const KONTA: ChannelAccountSettings[] = [
  { organizationId: 'o1', channel: 'ALLEGRO' as ChannelAccountSettings['channel'], channelAccountId: 'a1', name: 'Allegro główne', adapterKey: 'allegro', config: {}, active: true },
  { organizationId: 'o1', channel: 'EMPIK' as ChannelAccountSettings['channel'], channelAccountId: 'e1', name: 'Empik', adapterKey: 'empik', config: {}, active: true },
  { organizationId: 'o1', channel: 'WOO' as ChannelAccountSettings['channel'], channelAccountId: 'w1', name: 'Sklep', adapterKey: 'woo', config: {}, active: true },
]

vi.mock('@/lib/adaptery/konta', () => ({
  loadChannelAccounts: async () => {
    liczniki.konta++
    return KONTA
  },
  createAccountAdapter: async () => {
    liczniki.adaptery++
    return {} // adapter bez odczytu ofert: podgląd z samych danych produktu, zero sieci
  },
}))

const { kafelPublikacji, zaleznosciPrzebieguOfert } = await import('./publikacja-serwer')
const { policzRaport } = await import('./masowo')

const db = {
  product: {
    findFirst: async ({ where }: { where: { id: string } }) => {
      liczniki.produkty++
      return { id: where.id, sku: `SKU-${where.id}`, title: `Przyprawa ${where.id}`, ean: '5901234560035', description: '<p>Opis.</p>', weightG: 100, priceGross: { toString: () => '19.90' }, details: null }
    },
  },
  productImage: { findMany: async () => [] },
  stock: { findMany: async () => [{ physical: 5, reserved: 0 }] },
  organization: {
    findFirst: async () => {
      liczniki.ustawienia++
      return { settings: null }
    },
  },
} as unknown as PrismaClient

const deps = {
  registry: { get: () => undefined } as never,
  src: { env: {} } as never,
  zakresOfertAllegro: async () => {
    liczniki.zakres++
    return true
  },
}

async function przebieg(n: number) {
  const z = zaleznosciPrzebieguOfert(db, deps)
  const konta = await z.konta()
  return policzRaport(
    Array.from({ length: n }, (_, i) => `p${i}`),
    konta,
    z.podglad,
  )
}

beforeEach(() => {
  for (const k of Object.keys(liczniki) as (keyof typeof liczniki)[]) liczniki[k] = 0
})

describe('przebieg masowy: konfiguracja raz na przebieg', () => {
  it.each([1, 7, 40])('%i produktów × 3 konta: konta, zakres Allegro, ustawienia i adaptery po razie (na konto)', async (n) => {
    const r = await przebieg(n)
    expect(r.kanaly.reduce((a, k) => a + k.gotowe + k.zProblemami + k.bledy, 0)).toBe(n * 3)
    expect(r.kanaly.reduce((a, k) => a + k.bledy, 0)).toBe(0)
    expect(liczniki).toEqual({ konta: 1, zakres: 1, ustawienia: 1, adaptery: 3, produkty: n * 3 })
  })

  it('ekran „Publikacja” (bez pamięci przebiegu) dalej czyta konfigurację przy każdym podglądzie', async () => {
    await kafelPublikacji(db, 'p1', 'ALLEGRO.a1', deps)
    await kafelPublikacji(db, 'p2', 'ALLEGRO.a1', deps)
    expect(liczniki).toMatchObject({ konta: 2, ustawienia: 2, adaptery: 2 })
  })
})
