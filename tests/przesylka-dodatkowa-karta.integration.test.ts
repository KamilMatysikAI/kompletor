// Karta zamówienia, blok „Przesyłki”: przycisk „Dodaj przesyłkę” przy włączonej funkcji firmy
// (Ustawienia → Przewoźnicy, „Pozwalaj dodać kolejną przesyłkę do zamówienia”) i z uprawnieniem stanowiska pakowania;
// po wyłączeniu zostaje tylko wtedy, gdy dodatkowa przesyłka czeka na wyjaśnienie u przewoźnika.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import type { PanelContext } from '@/lib/panel/kontekst'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { zapiszAutomatyWysylki } from '@/lib/wysylka/automaty'
import { testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/panel/kontekst', () => ({
  requireSession: async () => {
    throw new Error('akcja nie powinna się wykonać w teście renderu')
  },
  requirePermission: async () => {
    throw new Error('akcja nie powinna się wykonać w teście renderu')
  },
}))

const { BlokDrogiPaczek } = await import('@/app/(panel)/zamowienia/[id]/droga-paczki')

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const WLASCICIEL = permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })
const ctx = (permissions: Set<string> = WLASCICIEL) => ({ db, permissions, user: { id: 'u-test' } }) as unknown as PanelContext

async function zGlowna(): Promise<string> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const id = (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })).orderId!
  await db.order.update({ where: { id }, data: { status: 'WYSLANE' } })
  await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: `ref-karta-${id}`, adapterKey: 'basecourier.zapis.v1', carrier: 'PACZKOMATY', state: 'UTWORZONA', trackingNumber: `NR${Math.random().toString(36).slice(2, 10)}` } })
  return id
}

const blok = async (id: string, c: PanelContext = ctx()) => renderToStaticMarkup((await BlokDrogiPaczek({ ctx: c, orderId: id }))!)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('przycisk „Dodaj przesyłkę” na karcie', () => {
  it('funkcja firmy wyłączona (domyślnie): blok przesyłki bez przycisku', async () => {
    const id = await zGlowna()
    const s = await blok(id)
    expect(s).toContain('Przesyłki')
    expect(s).not.toContain('Dodaj przesyłkę')
  })

  it('funkcja włączona: przycisk jest, ale tylko z uprawnieniem stanowiska pakowania', async () => {
    const id = await zGlowna()
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, dodatkowaPrzesylka: true }, 'u-admin')
    expect(await blok(id)).toContain('Dodaj przesyłkę')
    expect(await blok(id, ctx(new Set(['panel.podglad'])))).not.toContain('Dodaj przesyłkę')
  })

  // dosyłka w trakcie albo niejasna u przewoźnika: okno („Sprawdź u przewoźnika”, „Rozstrzygnij ręcznie”) zostaje po wyłączeniu
  const dosylka = (orderId: string, state: 'TWORZENIE' | 'NIEJEDNOZNACZNA' | 'UTWORZONA' | 'ANULOWANA') =>
    db.shipment.create({ data: { orderId, packageNo: 1, extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'reklamacja: brak produktu', reference: `ref-dosylka-${orderId}-${state}`, adapterKey: 'basecourier.zapis.v1', carrier: 'PACZKOMATY', state } })

  it('funkcja wyłączona, dosyłka niejasna albo w trakcie: przycisk zostaje (z uprawnieniem stanowiska pakowania)', async () => {
    for (const state of ['NIEJEDNOZNACZNA', 'TWORZENIE'] as const) {
      const id = await zGlowna()
      await dosylka(id, state)
      expect(await blok(id), state).toContain('Dodaj przesyłkę')
      expect(await blok(id, ctx(new Set(['panel.podglad']))), state).not.toContain('Dodaj przesyłkę')
    }
  })

  it('funkcja wyłączona, dosyłka niejasna przy anulowanej głównej: blok i przycisk dalej są', async () => {
    const id = await zGlowna()
    await db.shipment.updateMany({ where: { orderId: id, extraNo: 0 }, data: { state: 'ANULOWANA', trackingNumber: null } })
    await dosylka(id, 'NIEJEDNOZNACZNA')
    expect(await blok(id)).toContain('Dodaj przesyłkę')
  })

  it('funkcja wyłączona, dosyłka wyjaśniona (utworzona albo anulowana): bez przycisku', async () => {
    for (const state of ['UTWORZONA', 'ANULOWANA'] as const) {
      const id = await zGlowna()
      await dosylka(id, state)
      expect(await blok(id), state).not.toContain('Dodaj przesyłkę')
    }
  })
})
