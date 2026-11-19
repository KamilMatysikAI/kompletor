// rejestr synchronizacji stanów na bazie, z fałszywym adapterem (kanał w pamięci, bez sieci). Drugi przebieg
// bez zmiany stanu = zero wywołań pushStock; zmiana jednej oferty = wywołanie tylko z nią; PRZEJSCIOWY nie zapisuje
// skrótu i następny przebieg ponawia; korekta stanu, „Wyślij stany ponownie”, job wymuszony, zmiana konta, zmiana oferty,
// rozjazd z odczytu i siatka 24 h wymuszają zapis. Firma bez BL i bez wFirmy z dwoma kanałami na atrapach przechodzi to samo.
// Żadnych prawdziwych sklepów ani danych klientów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Prisma } from '@prisma/client'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { korektaStanu } from '@/lib/kanaly/korekta-stanu'
import { uniewaznijOferty, uniewaznijReferencje, uniewaznijRozjazdy } from '@/lib/kanaly/rejestr-synchronizacji'
import { ekranZapisu, wyslijStanyKonta, wyslijStanyPonownie, zapiszPelnyZapisStanow } from '@/lib/kanaly/zapis-host'
import { type PushStats, runFanout } from '@/lib/rdzen/propagacja'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, testDb, truncateAll } from './db'
import { ACC, offer, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const SRC = { env: {}, envFallback: false }
const S = 1000
const H = 3600_000
const at = (ms: number) => new Date(T0.getTime() + ms)
const SD = ACC.WOO_SD
const AL = ACC.ALLEGRO

let state: FakeChannelState
let stateAl: FakeChannelState
let registry: AdapterRegistry

async function konto(acc: { channel: Channel; channelAccountId: string }, adapterKey = 'fake.v1') {
  await db.channelConfig.update({
    where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...acc } },
    // updatedAt w czasie testu (rejestr porównuje zapis z ostatnią zmianą konta; testy mają zegar w październiku)
    data: { adapterKey, stockMode: 'PRACA', config: { zapisWlaczony: true } as Prisma.InputJsonValue, updatedAt: at(-3 * H) },
  })
}

const ctx = (now: Date) => ({ registry, secrets: SRC, now })
/** Oferta z ostatnim zapisem 2 h przed T0 (rdzeń nie pomija „tego samego targetu < 1 h”, wzrost nie czeka na odczyt). */
async function oferta(label: 'WOO_SD' | 'ALLEGRO', ext: string, productId: string, qty: number) {
  const id = await offer(db, label, ext, productId)
  await db.channelOffer.update({ where: { id }, data: { lastPushedQty: qty, lastPushedAt: at(-2 * H) } })
  return id
}
const zmiana = (productId: string, t: number) => db.outboxEvent.create({ data: { kind: 'AVAILABLE_CHANGED', productId, createdAt: at(t) } })
async function przebieg(t: number, acc: { channel: Channel; channelAccountId: string } = SD): Promise<PushStats> {
  await runFanout(db, { now: at(t) })
  const r = await wyslijStanyKonta(db, acc, ctx(at(t)))
  if ('zablokowane' in r) throw new Error(`konto zablokowane: ${r.zablokowane}`)
  return r
}
const wywolania = (s: FakeChannelState) => s.writeCalls.filter((c) => c.op === 'stock')
const wpis = (ext: string, acc = SD) => db.channelSyncState.findFirst({ where: { ...acc, offerExternalId: ext } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  stateAl = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO'), fakeDefinition(stateAl, 'ALLEGRO', 'fakeallegro.v1')])
})

describe('pomijanie niezmienionych (SKIP)', () => {
  it('pierwszy przebieg wysyła jak dawniej; drugi bez zmiany stanu = 0 wywołań pushStock, licznik na ekranie konta', async () => {
    await konto(SD)
    const a = await product(db, 'A', 5)
    const of = await oferta('WOO_SD', '10', a, 5)
    await zmiana(a, S)
    expect(await przebieg(2 * S)).toMatchObject({ sent: 1, skippedUnchanged: 0 })
    expect(wywolania(state)).toHaveLength(1)
    expect(await wpis('10')).toMatchObject({ contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), qty: 5, failures: 0, lastError: null, reference: expect.any(String) })
    await zmiana(a, 2 * H)
    expect(await przebieg(2 * H + S)).toMatchObject({ sent: 0, skippedUnchanged: 1, failed: 0 })
    expect(wywolania(state)).toHaveLength(1)
    expect(await db.stockSyncJob.count({ where: { offerId: of } })).toBe(0)
    // pominięcie nie jest wysyłką: bez wpisu PRACA w dzienniku, kanał nie „ożywa” w zdrowiu
    expect(await db.channelPushLog.count({ where: { offerId: of, mode: 'PRACA' } })).toBe(1)
    const e = (await ekranZapisu(db, registry, SD, at(2 * H + 2 * S)))!
    expect(e.bezZmian).toMatchObject({ wyslane: 0, pominiete: 1, zapamietane: 1, pelnyZapisCoGodz: 24 })
  })

  it('zmiana jednej oferty = wywołanie tylko z tą ofertą', async () => {
    await konto(SD)
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 7)
    await oferta('WOO_SD', '10', a, 5)
    await oferta('WOO_SD', '20', b, 7)
    await zmiana(a, S)
    await zmiana(b, S)
    expect((await przebieg(2 * S)).sent).toBe(2)
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(2 * H) })
    await zmiana(b, 2 * H)
    expect(await przebieg(2 * H + S)).toMatchObject({ sent: 1, skippedUnchanged: 1 })
    expect(wywolania(state).map((c) => c.target)).toEqual([expect.stringMatching(/10=5/), '10=4'])
    expect(state.stock.get('10')).toBe(4)
    expect(state.stock.get('20')).toBe(7)
  })
})

describe('niepowodzenia nie zapisują skrótu (RETRY)', () => {
  it('PRZEJSCIOWY: skrót pusty z błędem, następny przebieg ponawia; powrót do starej wartości też idzie', async () => {
    await konto(SD)
    const a = await product(db, 'A', 5)
    await oferta('WOO_SD', '10', a, 5)
    await zmiana(a, S)
    await przebieg(2 * S)
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(2 * H) })
    state.writeFailures.push('PRZEJSCIOWY')
    expect((await przebieg(2 * H + S)).failed).toBe(1)
    expect(await wpis('10')).toMatchObject({ contentHash: null, failures: 0, lastError: expect.stringMatching(/PRZEJSCIOWY/) })
    // stan wraca do 5 (wartość ostatniego udanego zapisu): skrót pusty, więc nie pomijamy — kanał mógł dostać 4
    await db.stock.update({ where: { productId_warehouseId: { productId: a, warehouseId: DEFAULT_WAREHOUSE } }, data: { physical: { increment: 1 }, wfirmaCount: { increment: 1 } } })
    await zmiana(a, 2 * H + 2 * S)
    expect((await przebieg(2 * H + 2 * 60 * S)).sent).toBe(1)
    expect(wywolania(state).at(-1)!.target).toBe('10=5')
    expect(await wpis('10')).toMatchObject({ contentHash: expect.any(String), qty: 5, lastError: null })
  })

  it('TRWALY podbija licznik porażek oferty; OK go zeruje; zła oferta nie blokuje reszty paczki', async () => {
    await konto(SD)
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 7)
    await oferta('WOO_SD', '10', a, 5)
    await oferta('WOO_SD', '20', b, 7)
    state.writeFailures.push('TRWALY')
    await zmiana(a, S)
    await zmiana(b, S)
    expect((await przebieg(2 * S)).failed).toBe(2)
    expect(await wpis('10')).toMatchObject({ contentHash: null, failures: 1 })
    expect((await przebieg(2 * S + 10 * 60 * S)).sent).toBe(2)
    expect(await wpis('10')).toMatchObject({ failures: 0, lastError: null, contentHash: expect.any(String) })
  })
})

describe('unieważnienie: rejestr nie ukrywa rozjazdu', () => {
  async function zapisane() {
    await konto(SD)
    const a = await product(db, 'A', 5)
    const of = await oferta('WOO_SD', '10', a, 5)
    await zmiana(a, S)
    await przebieg(2 * S)
    expect(await wpis('10')).not.toBeNull()
    return { a, of }
  }
  const znowuIdzie = async (a: string, t: number) => {
    await zmiana(a, t)
    const r = await przebieg(t + S)
    expect(r).toMatchObject({ sent: 1, skippedUnchanged: 0 })
    expect(wywolania(state)).toHaveLength(2)
  }

  it('korekta stanu (firma bez wFirmy), także bez zmiany ilości, kasuje skróty ofert produktu', async () => {
    await db.warehouse.updateMany({ where: { id: DEFAULT_WAREHOUSE }, data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
    const { a } = await zapisane()
    expect(await korektaStanu(db, { productId: a, physicalAfter: 5, reason: 'przeliczona półka' }, { actorId: 'test', now: at(H) })).toEqual({ delta: 0 })
    expect(await wpis('10')).toBeNull()
    await znowuIdzie(a, 2 * H)
  })

  it('„Wyślij stany ponownie” kasuje skróty konta i wysyła wszystko (job wymuszony)', async () => {
    const { a } = await zapisane()
    const r = await wyslijStanyPonownie(db, SD, { now: at(2 * H), actorId: 'test' })
    expect(r.skroty).toBe(1)
    expect(await db.channelSyncState.count()).toBe(0)
    expect((await przebieg(2 * H + S)).sent).toBe(1)
    expect(wywolania(state)).toHaveLength(2)
    expect(await db.auditLog.count({ where: { entity: 'ChannelConfig', after: { path: ['akcja'], equals: 'wyslij-stany-ponownie' } } })).toBe(1)
    void a
  })

  it('job wymuszony (kanał sam zmienił stan) idzie mimo identycznego skrótu', async () => {
    const { a, of } = await zapisane()
    await db.outboxEvent.create({ data: { kind: 'FORCE_PUSH', productId: a, offerId: of, createdAt: at(2 * H) } })
    expect((await przebieg(2 * H + S)).sent).toBe(1)
    expect(wywolania(state)).toHaveLength(2)
  })

  it('zmiana konta po zapisie (ustawienia, tryb, wyłącznik — ChannelConfig.updatedAt) = pełny zapis', async () => {
    const { a } = await zapisane()
    await db.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...SD } }, data: { name: 'Sklep po zmianie', updatedAt: at(H) } })
    await znowuIdzie(a, 2 * H)
  })

  it('zmiana oferty (wyłączenie i włączenie, inny produkt, przelicznik) kasuje skrót wyzwalaczem w bazie', async () => {
    const { a, of } = await zapisane()
    await db.channelOffer.update({ where: { id: of }, data: { active: false } })
    expect(await wpis('10')).toBeNull()
    await db.channelOffer.update({ where: { id: of }, data: { active: true } })
    await znowuIdzie(a, 2 * H)
    // zmiana bez znaczenia dla kanału (ostatni zapis) nie kasuje
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedAt: at(3 * H) } })
    expect(await wpis('10')).not.toBeNull()
    await db.channelOffer.update({ where: { id: of }, data: { qtyBasePerOffer: 2 } })
    expect(await wpis('10')).toBeNull()
  })

  it('rozjazd z odczytu ofert kanału (inna ilość niż w ostatnim zapisie) kasuje skrót; zgodna ilość zostawia', async () => {
    const { a } = await zapisane()
    expect(await uniewaznijRozjazdy(db, SD, [{ externalId: '10', qty: 5 }, { externalId: 'nieznana', qty: 1 }])).toBe(0)
    expect(await wpis('10')).not.toBeNull()
    expect(await uniewaznijRozjazdy(db, SD, [{ externalId: '10', qty: 3 }])).toBe(1)
    await znowuIdzie(a, 2 * H)
    expect(await uniewaznijOferty(db, SD, ['10'])).toBe(1)
  })

  it('plik stanów odrzucony później przez kanał (import Empiku): skróty z tej referencji kasowane', async () => {
    const { a } = await zapisane()
    const ref = (await wpis('10'))!.reference!
    expect(await uniewaznijReferencje(db, SD, 'inna-referencja')).toBe(0)
    expect(await uniewaznijReferencje(db, SD, ref)).toBe(1)
    await znowuIdzie(a, 2 * H)
  })

  it('siatka: po odstępie pełnego zapisu (domyślnie 24 h, ustawialne) oferta idzie mimo braku zmian', async () => {
    const { a } = await zapisane()
    await zmiana(a, 23 * H)
    expect((await przebieg(23 * H + S)).skippedUnchanged).toBe(1)
    await zmiana(a, 24 * H + 5 * S)
    expect((await przebieg(24 * H + 10 * S)).sent).toBe(1)
    await zapiszPelnyZapisStanow(db, SD, 6, { actorId: 'test' })
    await expect(zapiszPelnyZapisStanow(db, SD, 0, { actorId: 'test' })).rejects.toThrow(/Zły odstęp/)
  })
})

describe('firma bez BL i bez wFirmy, dwa kanały na atrapach', () => {
  it('pierwszy przebieg wysyła na oba kanały, drugi bez zmian nic; sprzedaż zmienia tylko swoją ofertę na obu', async () => {
    await db.warehouse.updateMany({ where: { id: DEFAULT_WAREHOUSE }, data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
    await konto(SD)
    await konto(AL, 'fakeallegro.v1')
    const a = await product(db, 'A', 5)
    const b = await product(db, 'B', 7)
    await oferta('WOO_SD', '10', a, 5)
    await oferta('WOO_SD', '20', b, 7)
    await oferta('ALLEGRO', 'al-1', a, 5)
    await oferta('ALLEGRO', 'al-2', b, 7)
    await zmiana(a, S)
    await zmiana(b, S)
    expect((await przebieg(2 * S, SD)).sent).toBe(2)
    expect((await przebieg(2 * S, AL)).sent).toBe(2)
    await zmiana(a, 2 * H)
    await zmiana(b, 2 * H)
    expect(await przebieg(2 * H + S, SD)).toMatchObject({ sent: 0, skippedUnchanged: 2 })
    expect(await przebieg(2 * H + S, AL)).toMatchObject({ sent: 0, skippedUnchanged: 2 })
    expect([wywolania(state).length, wywolania(stateAl).length]).toEqual([1, 1])
    await ingestOrder(db, order([{ productId: b, qty: 2 }]), { now: at(3 * H) })
    await zmiana(a, 3 * H)
    expect((await przebieg(3 * H + S, SD)).sent).toBe(1)
    expect((await przebieg(3 * H + S, AL)).sent).toBe(1)
    expect(wywolania(state).at(-1)!.target).toBe('20=5')
    expect(wywolania(stateAl).at(-1)!.target).toBe('al-2=5')
  })
})
