import { describe, expect, it } from 'vitest'
import type { OrderStatus } from '@prisma/client'
import { STATUSY_BEZ_KOSZYKA, zwolnijKoszykPoStatusie } from './zwolnienie'

describe('koszyki: zwolnienie po statusie', () => {
  const tx = () => {
    const wolania: unknown[] = []
    return { wolania, packBasket: { updateMany: async (a: unknown) => (wolania.push(a), { count: 1 }) } as never }
  }

  it('spakowane, wydane, odebrane, anulowane i reklamacja zwalniają koszyk', async () => {
    for (const s of ['SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ANULOWANE', 'REKLAMACJA'] as OrderStatus[]) {
      const t = tx()
      await zwolnijKoszykPoStatusie(t, 'o1', s)
      expect(t.wolania).toEqual([{ where: { orderId: 'o1' }, data: { orderId: null, assignedAt: null, assignedById: null } }])
    }
  })

  it('przed spakowaniem i „do wyjaśnienia” koszyk zostaje', async () => {
    for (const s of ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'DO_WYJASNIENIA'] as OrderStatus[]) {
      const t = tx()
      await zwolnijKoszykPoStatusie(t, 'o1', s)
      expect(t.wolania).toEqual([])
      expect(STATUSY_BEZ_KOSZYKA.has(s)).toBe(false)
    }
  })
})
