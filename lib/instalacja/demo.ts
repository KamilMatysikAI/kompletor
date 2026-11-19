// Firma demonstracyjna (w lib/instalacja): „Sklep Demo” ze zmyślonymi produktami
// i zamówieniami, bez danych klientów i bez konfiguracji prawdziwej firmy. Trzy drogi: przycisk „Najpierw zobacz
// demo” w kreatorze /start, `KOMPLETOR_SEED=demo` przy starcie kontenera (`node dist/org.cjs seed demo`) i
// `npm run demo:panel -- --tak` lokalnie.
//
// Zasady: nigdy w hostingu (APP_MODE=hosted); firma `demo` powstaje tylko wtedy, gdy jej jeszcze nie ma, a dane
// fikcyjne trafiają wyłącznie do niej (klient firmy z RLS), więc inne firmy w bazie zostają nietknięte. Konta
// kanałów demo są nieaktywne: cień ich nie czyta, więc /api/health zostaje `ok` (bez alertów i `withoutAdapter`).
import type { PrismaClient } from '@prisma/client'
import { appModeOf } from '../db'
import { generatePassword } from '../auth/hasla'
import { createUserWithHash, grantMembership } from '../auth/sesje'
import { hashPassword } from '../auth/hasla'
import { applyOrgPreset, type OrgPreset } from '../organizacje'
import type { PickupScheduleT } from '../pakowanie/harmonogram'
import type { ZoneDefT, ZoneRuleT } from '../pakowanie/strefy'
import { LEGACY_DEFAULT_CARRIER_RULES } from '../rdzen/przewoznicy'
import { ingestOrder } from '../rdzen/zamowienia'

export const DEMO_ORG = 'demo'
export const DEMO_EMAIL = 'demo@kompletor.test'

/** Fikcyjne godziny odbiorów (oznaczone jako przykładowe). */
const DEMO_PICKUPS: PickupScheduleT[] = [
  { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true, example: true },
  { carrier: 'DPD_EMPIK', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true, example: true },
  { carrier: 'ALLEGRO', weekdays: [1, 2, 3, 4, 5], pickupMinute: 14 * 60, promiseUntilMinute: 13 * 60, active: true, example: true },
  { carrier: 'PACZKOMATY', weekdays: [1, 2, 3, 4, 5], pickupMinute: 15 * 60, promiseUntilMinute: 14 * 60, active: true, example: true },
]

// strefy demo nazwane ogólnie (miejsce w magazynie), nie od asortymentu konkretnej firmy
const DEMO_ZONES: ZoneDefT[] = [
  { key: 'REGALY', name: 'regały w magazynie', color: 'ziemia', sortOrder: 10 },
  { key: 'PRZY_STANOWISKU', name: 'przy stanowisku', color: 'niebo', sortOrder: 20 },
]

const DEMO_ZONE_RULES: ZoneRuleT[] = [
  { priority: 10, pattern: 'świec|łyżk|zakładk|notes', zone: 'PRZY_STANOWISKU' },
  { priority: 20, pattern: 'kubek|młyn|orzech|granol|słonecznik|mydł|torb', zone: 'REGALY' },
]

/**
 * demo przestawia status zamówienia z pominięciem pakowania, więc braki zamyka tak jak pakowanie
 * (lib/rdzen/rozchod.ts packOrderInTx): paczka wyszła bez brakującej pozycji = zwrot albo mniejsze pobranie.
 * Bez tego lista „Brakuje” pokazywała otwarte braki przy zamówieniach „Wysłane” (błąd danych demo, nie logiki).
 */
async function zamknijBraki(db: PrismaClient, orderId: string, now: Date): Promise<void> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { paymentState: true } })
  await db.shortage.updateMany({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } }, data: { state: o?.paymentState === 'COD' ? 'COD_REDUCED' : 'REFUND_PENDING', resolvedAt: now } })
}

export const DEMO_PRESET: OrgPreset = {
  id: DEMO_ORG,
  slug: 'demo',
  name: 'Sklep Demo',
  warehouses: [{ id: 'glowny', name: 'Główny', wfirmaWarehouseId: null }],
  // nieaktywne: bez kluczy i bez prawdziwych sklepów cień i tak nie miałby czego czytać (health bez `degraded`)
  channels: [
    { channel: 'WOO', channelAccountId: 'sklep', name: 'Sklep internetowy', active: false },
    { channel: 'WOO', channelAccountId: 'outlet', name: 'Outlet', active: false },
    { channel: 'ALLEGRO', channelAccountId: 'allegro', name: 'Allegro', active: false },
    { channel: 'EMPIK', channelAccountId: 'empik', name: 'Empik', active: false },
  ],
  // demo: rozpoznaje też ogólnego „kuriera” jako DPD (zestaw startowy), żeby kolejka była pełna
  carrierRules: LEGACY_DEFAULT_CARRIER_RULES,
  carrierPickups: DEMO_PICKUPS,
  zoneRules: DEMO_ZONE_RULES,
  zones: DEMO_ZONES,
}

const PRODUCTS: [string, string, 'SZT' | 'KG', number, number, number | null][] = [
  // sku, nazwa, jednostka, stan, cena brutto, cena zakupu netto (za sztukę albo za kg; null = brak, raport
  // pokazuje wtedy „brak ceny zakupu” zamiast marży)
  ['D-001', 'Kubek ceramiczny 300 ml', 'SZT', 14, 24.9, 9.2],
  ['D-002', 'Mieszanka orzechów', 'KG', 3200, 0.19, 70],
  ['D-003', 'Świeca sojowa lawendowa', 'SZT', 40, 19.9, 6.5],
  ['D-004', 'Młynek do pieprzu', 'SZT', 2, 59, 24],
  ['D-005', 'Łyżka drewniana', 'SZT', 9, 18, 6],
  ['D-006', 'Notes w kratkę A5', 'SZT', 1, 32, 13],
  ['D-007', 'Mydło naturalne 100 g', 'SZT', 22, 21.5, 8.1],
  ['D-008', 'Granola klasyczna 300 g', 'SZT', 0, 23.63, null],
  ['D-009', 'Świeca sojowa waniliowa', 'SZT', 31, 19.9, 6.5],
  ['D-010', 'Pestki słonecznika łuskane', 'KG', 900, 0.16, 55],
  ['D-011', 'Zakładka do książki', 'SZT', 55, 10.7, 3.4],
  ['D-012', 'Torba bawełniana', 'SZT', 6, 34, null],
]

/** Odmowa demo w hostingu: firma z danymi fikcyjnymi nie ma czego szukać na wspólnej instalacji. */
export function assertDemoDozwolone(env: Record<string, string | undefined>): void {
  if (appModeOf(env) === 'hosted') throw new Error('Demo nie działa w trybie hosting (APP_MODE=hosted)')
}

/**
 * Produkty, stany i zamówienia demo. `db` = klient firmy demo (RLS), więc zapis nie może trafić do innej firmy.
 * `dni` = ile dni wstecz (zamówienia z bieżącego miesiąca, do wykresu pulpitu).
 */
export async function wypelnijDemo(db: PrismaClient, opts: { now?: Date; dni?: number } = {}): Promise<{ produkty: number; zamowienia: number }> {
  const ids: string[] = []
  for (const [sku, title, unit, stock, price, zakup] of PRODUCTS) {
    const p = await db.product.create({ data: { sku, kind: 'STOCKED', unit, title, nameAccounting: title, priceGross: price.toFixed(2), vatRate: '23', purchasePriceNet: zakup === null ? null : zakup.toFixed(4) } })
    await db.stock.create({ data: { productId: p.id, warehouseId: 'glowny', wfirmaCount: stock, physical: stock, wfirmaReadAt: new Date() } })
    ids.push(p.id)
  }
  const bundle = await db.product.create({ data: { sku: 'D-Z01', kind: 'BUNDLE', unit: 'SZT', title: 'Zestaw kuchenny: młynek i łyżka', nameAccounting: 'Zestaw kuchenny: młynek i łyżka' } })
  await db.bundleComponent.createMany({ data: [{ bundleId: bundle.id, componentId: ids[3]!, qtyBase: 1 }, { bundleId: bundle.id, componentId: ids[4]!, qtyBase: 1 }] })
  for (const [i, id] of ids.entries()) await db.channelOffer.create({ data: { channel: 'WOO', channelAccountId: 'sklep', externalId: String(1000 + i), productId: id } })

  const accounts = [
    ['WOO', 'sklep', 'Paczkomaty InPost'],
    ['WOO', 'sklep', 'Kurier DPD'],
    ['WOO', 'outlet', 'Paczkomaty InPost'],
    ['ALLEGRO', 'allegro', 'Allegro One Box'],
    ['EMPIK', 'empik', 'DPD do salonu Empik'],
  ] as const
  const now = opts.now ?? new Date()
  const day = 86400_000
  let n = 48000
  let seed = 7
  let zamowienia = 0
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
  const daysBack = Math.min(opts.dni ?? 24, new Date(now).getDate() - 1)
  for (let d = daysBack; d >= 0; d--) {
    const count = d === 0 ? 9 : 8 + Math.floor(rnd() * 14)
    for (let k = 0; k < count; k++) {
      const acc = accounts[Math.floor(rnd() * accounts.length)]!
      const created = new Date(now.getTime() - d * day - Math.floor(rnd() * 8) * 3600_000)
      if (created > now) continue
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, li) => {
        const pi = Math.floor(rnd() * PRODUCTS.length)
        const kg = PRODUCTS[pi]![2] === 'KG'
        return { externalLineId: `L${li + 1}`, productId: ids[pi]!, qty: kg ? 100 * (1 + Math.floor(rnd() * 3)) : 1 + Math.floor(rnd() * 2), unitPriceGross: PRODUCTS[pi]![4] }
      })
      if (rnd() < 0.08) lines.push({ externalLineId: 'LZ', productId: bundle.id, qty: 1, unitPriceGross: 69 })
      const unpaid = d < 4 && rnd() < 0.25
      const total = Math.round(lines.reduce((s, l) => s + l.qty * l.unitPriceGross, 0) * 100) / 100 + 13.99
      const res = await ingestOrder(
        db,
        {
          source: 'demo',
          channel: acc[0],
          channelAccountId: acc[1],
          externalId: acc[0] === 'ALLEGRO' ? `${Math.floor(rnd() * 1e8).toString(16)}-44e0-4f1a-9c2b-${(n++).toString(16)}` : String(n++),
          externalRevision: '1',
          createdAtChannel: created,
          paymentState: unpaid ? 'UNPAID' : acc[2].startsWith('Kurier') && rnd() < 0.3 ? 'COD' : 'PAID',
          paymentMethod: unpaid ? 'przelew' : acc[0] === 'ALLEGRO' ? 'Allegro Finance' : 'BLIK',
          totalGross: total,
          deliveryMethod: rnd() < 0.04 ? 'Orlen Paczka' : acc[2],
          lines,
        },
        { now: created },
      )
      zamowienia++
      // starsze zamówienia: dalej w procesie (tylko demo, bez faktur i przesyłek)
      if (res.orderId && d >= 2 && res.status === 'DO_REALIZACJI' && rnd() < 0.85) {
        await db.order.update({ where: { id: res.orderId }, data: { status: 'WYSLANE' } })
        await zamknijBraki(db, res.orderId, created)
        await db.reservation.updateMany({ where: { orderId: res.orderId, state: 'ACTIVE' }, data: { state: 'CONSUMED', consumedAt: created } })
      } else if (res.orderId && d === 1 && res.status === 'DO_REALIZACJI' && rnd() < 0.4) {
        const status = rnd() < 0.5 ? 'ZBIERANIE' : 'SPAKOWANE'
        await db.order.update({ where: { id: res.orderId }, data: { status } })
        if (status === 'SPAKOWANE') await zamknijBraki(db, res.orderId, created)
      }
    }
  }
  // rezerwacje oznaczone w demo jako wydane: schodzą z zarezerwowanych i ze stanu fizycznego (jak po fakturze)
  for (const s of await db.stock.findMany()) {
    const consumed = await db.reservation.aggregate({ where: { productId: s.productId, state: 'CONSUMED' }, _sum: { qtyBase: true } })
    const used = consumed._sum.qtyBase ?? 0
    if (!used) continue
    await db.stock.update({
      where: { productId_warehouseId: { productId: s.productId, warehouseId: s.warehouseId } },
      data: { reserved: Math.max(0, s.reserved - used), physical: Math.max(0, s.physical - used), wfirmaCount: Math.max(0, s.wfirmaCount - used) },
    })
  }
  return { produkty: PRODUCTS.length + 1, zamowienia }
}

export type WynikDemo = { utworzona: false } | { utworzona: true; email: string; haslo: string; zamowienia: number }

/**
 * Firma demo z kontem właściciela `demo@kompletor.test` i wygenerowanym hasłem (CLI: `seed demo`, `demo:panel`).
 * Gdy firma `demo` już jest: nic nie robi (`utworzona: false`). Hasło zwraca raz, do wypisania na terminal/log.
 */
export async function zalozDemo(sys: PrismaClient, orgClient: (organizationId: string) => PrismaClient, env: Record<string, string | undefined> = process.env): Promise<WynikDemo> {
  assertDemoDozwolone(env)
  if (await sys.organization.findUnique({ where: { id: DEMO_ORG }, select: { id: true } })) return { utworzona: false }
  if (await sys.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } })) throw new Error(`Konto ${DEMO_EMAIL} już istnieje bez firmy demo: nadaj dostęp ręcznie (npm run uzytkownik)`)
  await applyOrgPreset(sys, DEMO_PRESET)
  const db = orgClient(DEMO_ORG)
  let zamowienia: number
  try {
    zamowienia = (await wypelnijDemo(db)).zamowienia
  } finally {
    await db.$disconnect()
  }
  const haslo = generatePassword()
  // hasło idzie do logu kontenera, więc pierwsze logowanie wymusza jego zmianę
  await createUserWithHash(sys, { email: DEMO_EMAIL, name: 'Demo', passwordHash: await hashPassword(haslo), mustChangePassword: true })
  await grantMembership(sys, { email: DEMO_EMAIL, organizationId: DEMO_ORG, role: 'WLASCICIEL' })
  return { utworzona: true, email: DEMO_EMAIL, haslo, zamowienia }
}
