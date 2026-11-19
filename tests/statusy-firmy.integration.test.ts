// statusy własne firmy na bazie — preset ACME (22 statusy BL w 7 sekcjach panelu) i neutralny,
// liczniki panelu listy zgodne z obecnymi i z filtrem listy, zapis ekranu Ustawienia → Statusy zamówień (jeden zapis,
// AuditLog, bez usuwania statusu z zamówieniami, izolacja firm) i mapowanie statusu firmy na status kanału przez host
// zapisu na atrapie kanału (bez prawdziwych sklepów i danych klientów). Rdzeń bez zmian: statusy przechodzą po enumie.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, OrderStatus, Prisma } from '@prisma/client'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { statusDictionaryFirmy } from '@/lib/api/statusy'
import { ekranZapisu, wykonajZapisy, zaplanujZapisy, zapiszMapeStatusow } from '@/lib/kanaly/zapis-host'
import { applyOrgPreset } from '@/lib/organizacje'
import { StatusyError, statusyFirmy, ustawieniaStatusow, zapiszStatusyFirmy, type StatusWejscie } from '@/lib/panel/statusy-firmy-dane'
import { filtryZ, licznikiPanelu, stronaListy } from '@/lib/panel/zamowienia-lista'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ACME_PRESET } from '@/tests/preset-testowy'
import { zapiszAutomatyWysylki } from '@/lib/wysylka/automaty'
import { ORG_A, ORG_B, TEST_ORGS, testDb, testSystemDb, truncateAll } from './db'
import { ACC, order, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

// firma A ze statusami ACME (jak po seedzie presetu ACME), firma B z neutralnymi (jak nowa firma)
const ORGS = TEST_ORGS.map((o) => (o.id === ORG_A ? { ...o, statuses: ACME_PRESET.statuses, statusGroups: ACME_PRESET.statusGroups } : o))

beforeEach(async () => {
  await truncateAll(undefined, ORGS)
  for (const db of [a, b]) await seedBase(db)
})

let nr = 0
async function zam(db: typeof a, status: OrderStatus, carrier: Carrier | null, extra: Partial<Prisma.OrderUncheckedUpdateInput> = {}) {
  const p = await product(db, `P-${++nr}`, 5)
  const r = await ingestOrder(db, order([{ productId: p, qty: 1 }]), { now: T0 })
  await db.order.update({ where: { id: r.orderId! }, data: { status, carrier, ...extra } })
  return r.orderId!
}

const wejscie = (s: Awaited<ReturnType<typeof ustawieniaStatusow>>['statusy']): StatusWejscie[] =>
  s.map((x) => ({ key: x.key, name: x.name, customerName: x.customerName ?? '', color: x.color, group: x.groupKey ?? '', baseStatus: x.baseStatus, carriers: [...x.carriers], active: x.active }))

describe('statusy firmy: preset i panel listy', () => {
  it('ACME po presecie: 22 statusy w 7 sekcjach z kolorami; liczniki = liczniki rdzenia i = wynik filtra listy', async () => {
    const sf = await statusyFirmy(a)
    expect(sf.statusy).toHaveLength(22)
    expect(new Set(sf.statusy.map((s) => s.groupKey ?? '-')).size).toBe(7)
    const plan: [OrderStatus, Carrier | null, number][] = [
      ['NOWE', null, 5],
      ['DO_REALIZACJI', 'BEZ_WYSYLKI', 1],
      ['DO_REALIZACJI', 'PACZKOMATY', 3],
      ['DO_REALIZACJI', 'INPOST_KURIER', 2],
      ['DO_REALIZACJI', 'DPD', 3],
      ['ZEBRANE', 'ALLEGRO', 1],
      ['DO_WYSLANIA', 'DPD', 3],
      ['WYSLANE', 'DPD', 4],
      ['ANULOWANE', null, 2],
      ['ZEBRANE', 'BEZ_WYSYLKI', 1], // brak pasującego statusu firmy
    ]
    for (const [s, c, n] of plan) for (let i = 0; i < n; i++) await zam(a, s, c)
    const l = await licznikiPanelu(a)
    expect(l.firmy).toBeDefined()
    const ile = l.firmy!.ile
    expect(ile).toMatchObject({ NOWE_ZAMOWIENIA: 5, EBOOK: 1, DO_REALIZACJI_PACZKOMATY: 5, DO_REALIZACJI_DPD: 3, ZEBRANE_ALLEGRO: 1, DO_WYSLANIA: 3, WYSLANE: 4, ANULOWANE: 2, 'RDZEN:ZEBRANE': 1 })
    // suma statusów firmy = wszystkie; grupa „Do realizacji” = licznik grupy rdzenia bez e-booka
    const suma = Object.values(ile).reduce((x, y) => x + y, 0)
    expect(suma).toBe(l.grupy.wszystkie)
    const doReal = sf.statusy.filter((s) => s.groupKey === 'DO_REALIZACJI').reduce((n, s) => n + (ile[s.key] ?? 0), 0)
    expect(doReal + (ile.EBOOK ?? 0)).toBe(l.grupy.do_realizacji)
    // filtr listy po statusie i grupie daje te same liczby co panel
    const opcje = { sort: { klucz: 'data', kierunek: 'malejaco' } as const, pomin: 0, ile: 100 }
    for (const k of ['DO_REALIZACJI_PACZKOMATY', 'EBOOK', 'RDZEN:ZEBRANE', 'ZEBRANE_DPD']) {
      expect((await stronaListy(a, filtryZ({ widok: 'wszystkie', sf: k }), opcje)).razem, k).toBe(ile[k] ?? 0)
    }
    expect((await stronaListy(a, filtryZ({ widok: 'wszystkie', sg: 'DO_REALIZACJI' }), opcje)).razem).toBe(doReal)
    // zamówienie przypisane wprost do innego statusu tego samego etapu przechodzi tam w panelu i w filtrze
    const id = await zam(a, 'DO_REALIZACJI', 'DPD', { companyStatus: 'DO_REALIZACJI_ALLEGRO' })
    const l2 = await licznikiPanelu(a)
    expect([l2.firmy!.ile.DO_REALIZACJI_DPD, l2.firmy!.ile.DO_REALIZACJI_ALLEGRO]).toEqual([3, 1])
    expect((await stronaListy(a, filtryZ({ widok: 'wszystkie', sf: 'DO_REALIZACJI_ALLEGRO' }), opcje)).wiersze.map((w) => w.id)).toEqual([id])
    // śmieci w adresie nie trafiają do zapytania
    expect(filtryZ({ sf: "x'; drop", sg: 'a b' })).toMatchObject({ sf: undefined, sg: undefined })
  })

  it('nowa firma: neutralne statusy (bez nazw ACME); API słownik zgodny wstecz + statusy firmy; izolacja firm', async () => {
    const sb = await statusyFirmy(b)
    expect(sb.statusy).toHaveLength(12)
    expect(JSON.stringify(sb)).not.toMatch(/Paczkomaty|DPD|Allegro|E-book|BaseLinker/)
    const d = await statusDictionaryFirmy(b)
    expect(d.statusy).toHaveLength(12)
    expect(d.platnosci).toHaveLength(4)
    expect(d.statusyFirmy.map((s) => s.klucz)).toEqual(sb.statusy.map((s) => s.key))
    expect(d.statusyFirmy[0]).toMatchObject({ nazwa: 'Nowe', bazowy: 'NOWE', aktywny: true, kolorHex: expect.stringMatching(/^#[0-9a-f]{6}$/) })
    expect((await statusDictionaryFirmy(a)).statusyFirmy).toHaveLength(22)
    // preset ponownie: statusy firmy nie są nadpisywane (zmiany z panelu zostają)
    await a.orderStatusDef.update({ where: { organizationId_key: { organizationId: ORG_A, key: 'WYSLANE' } }, data: { name: 'Wysłane do klienta' } })
    await applyOrgPreset(testSystemDb(), ORGS[0]!)
    expect((await statusyFirmy(a)).statusy.find((s) => s.key === 'WYSLANE')?.name).toBe('Wysłane do klienta')
  })
})

describe('statusy firmy: ekran ustawień', () => {
  it('jeden zapis: zmiana nazwy, koloru, kolejności, nowa grupa przez odnośnik, ukrycie; AuditLog; firma B bez zmian', async () => {
    const u = await ustawieniaStatusow(a)
    const s = wejscie(u.statusy)
    s[0] = { ...s[0]!, name: 'Nowe ze sklepów', color: 'zolty', group: 'nowa-1' }
    const [x] = s.splice(1, 1) // E-book na koniec
    s.push({ ...x!, active: false })
    // każdy etap dalej ma widoczny status (Do realizacji ma statusy przewoźników)
    const r = await zapiszStatusyFirmy(a, { grupy: [{ key: null, ref: 'nowa-1', name: 'Nowe', collapsed: false }, ...u.grupy.map((g) => ({ key: g.key, ref: '', name: g.name, collapsed: g.collapsed }))], statusy: s }, 'u-a')
    expect(r).toEqual({ statusy: 22, grupy: 7 })
    const po = await statusyFirmy(a)
    expect(po.grupy[0]).toMatchObject({ key: 'NOWE', name: 'Nowe', sortOrder: 10 })
    expect(po.statusy[0]).toMatchObject({ key: 'NOWE_ZAMOWIENIA', name: 'Nowe ze sklepów', color: 'zolty', groupKey: 'NOWE', sortOrder: 10 })
    expect(po.statusy.at(-1)).toMatchObject({ key: 'EBOOK', active: false, sortOrder: 220 })
    expect(await a.auditLog.count({ where: { entity: 'OrderStatusDef' } })).toBe(1)
    expect((await statusyFirmy(b)).statusy).toHaveLength(12)
    // nowy status bez klucza dostaje klucz z nazwy
    await zapiszStatusyFirmy(a, { grupy: po.grupy.map((g) => ({ key: g.key, ref: '', name: g.name, collapsed: g.collapsed })), statusy: [...wejscie((await ustawieniaStatusow(a)).statusy), { key: null, name: 'Czeka na grawer', customerName: 'W przygotowaniu', color: 'rozowy', group: '', baseStatus: 'DO_REALIZACJI', carriers: [], active: true }] }, 'u-a')
    expect((await statusyFirmy(a)).statusy.find((d) => d.name === 'Czeka na grawer')).toMatchObject({ key: 'CZEKA_NA_GRAWER', customerName: 'W przygotowaniu', carriers: [] })
  })

  it('status z zamówieniami: usunięcie = błąd (tylko ukryć); etap bez widocznego statusu = błąd; zły kolor = błąd pola', async () => {
    await zam(a, 'WYSLANE', 'DPD')
    const u = await ustawieniaStatusow(a)
    expect(u.statusy.find((s) => s.key === 'WYSLANE')?.zamowienia).toBe(1)
    const grupy = u.grupy.map((g) => ({ key: g.key, ref: '', name: g.name, collapsed: g.collapsed }))
    const s = wejscie(u.statusy)
    await expect(zapiszStatusyFirmy(a, { grupy, statusy: s.filter((x) => x.key !== 'WYSLANE') }, 'u')).rejects.toThrow(/Każdy etap musi mieć widoczny status. Brakuje: Wysłane/)
    const zDrugim = [...s, { key: null, name: 'Wysłane kurierem', customerName: '', color: 'zielony', group: 'ZAKONCZONE', baseStatus: 'WYSLANE', carriers: [], active: true }]
    await expect(zapiszStatusyFirmy(a, { grupy, statusy: zDrugim.filter((x) => x.key !== 'WYSLANE') }, 'u')).rejects.toThrow(/nie można usunąć: ma zamówienia \(1\). Ukryj/)
    await expect(zapiszStatusyFirmy(a, { grupy, statusy: s.map((x) => (x.key === 'WYSLANE' ? { ...x, active: false } : x)) }, 'u')).rejects.toThrow(/Brakuje: Wysłane/)
    const e = await zapiszStatusyFirmy(a, { grupy, statusy: s.map((x, i) => (i === 3 ? { ...x, color: 'tęcza' } : x)) }, 'u').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(StatusyError)
    expect((e as StatusyError).pole).toBe('status-3-kolor')
    // ukrycie statusu z zamówieniami przy drugim widocznym: OK, stare zamówienie liczy się pod nazwą rdzenia albo drugim
    await zapiszStatusyFirmy(a, { grupy, statusy: zDrugim.map((x) => (x.key === 'WYSLANE' ? { ...x, active: false } : x)) }, 'u')
    expect((await licznikiPanelu(a)).firmy!.ile).toMatchObject({ WYSLANE_KURIEREM: 1 })
    expect(await a.auditLog.count({ where: { entity: 'OrderStatusDef' } })).toBe(1) // błędne zapisy bez śladu
  })
})

describe('statusy firmy: mapowanie na kanał przez host zapisu (atrapa kanału)', () => {
  const SD = ACC.WOO_SD
  const where = { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...SD } }
  let state: FakeChannelState
  let registry: AdapterRegistry
  beforeEach(() => {
    state = new FakeChannelState()
    registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
  })
  const at = (ms: number) => new Date(T0.getTime() + ms)
  const ctx = (now: Date) => ({ registry, secrets: { env: {}, envFallback: false }, now })

  it('status firmy z nadpisaniem trafia do kanału jako status firmy; bez nadpisania wartość z enumu jak dotąd; ekran konta pokazuje statusy firmy', async () => {
    await a.channelConfig.update({ where, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', config: { zapisWlaczony: true } as Prisma.InputJsonValue } })
    // zapis z ekranu konta: mapa enumu + nadpisanie jednego statusu firmy (pole spoza statusów firmy pominięte)
    await zapiszMapeStatusow(a, SD, { status_SPAKOWANE: 'packed', status_WYSLANE: 'completed', statusfirmy_SPAKOWANE_ALLEGRO: 'Spakowane-Allegro', statusfirmy_NIE_MA: 'x' }, { registry, actorId: 'test' })
    const cfg = (await a.channelConfig.findUniqueOrThrow({ where })).config as Record<string, unknown>
    expect(cfg['statusyFirmy']).toEqual({ SPAKOWANE_ALLEGRO: 'spakowane-allegro' })
    const ekran = (await ekranZapisu(a, registry, SD, at(0)))!
    expect(ekran.statusyFirmy).toHaveLength(22)
    expect(ekran.mapaFirmy).toEqual({ SPAKOWANE_ALLEGRO: 'spakowane-allegro' })

    const allegro = await zam(a, 'SPAKOWANE', 'ALLEGRO')
    const dpd = await zam(a, 'SPAKOWANE', 'DPD')
    const wysl = await zam(a, 'WYSLANE', 'ALLEGRO')
    await zaplanujZapisy(a, registry, { now: at(60_000) })
    const wiersze = await a.channelWrite.findMany({ select: { orderId: true, key: true, channelStatus: true } })
    expect(wiersze.find((w) => w.orderId === allegro)).toMatchObject({ key: 'F:SPAKOWANE_ALLEGRO', channelStatus: 'spakowane-allegro' })
    expect(wiersze.find((w) => w.orderId === dpd)).toMatchObject({ key: 'SPAKOWANE', channelStatus: 'packed' })
    expect(wiersze.find((w) => w.orderId === wysl)).toMatchObject({ key: 'WYSLANE', channelStatus: 'completed' })
    const r = await wykonajZapisy(a, ctx(at(61_000)))
    expect(r.wyslane).toBe(3)
    const ext = async (id: string) => (await a.order.findUniqueOrThrow({ where: { id } })).externalId
    expect(state.statuses.get(await ext(allegro))).toBe('spakowane-allegro')
    expect(state.statuses.get(await ext(dpd))).toBe('packed')
    // drugi przebieg: nic nowego (idempotentnie)
    await zaplanujZapisy(a, registry, { now: at(120_000) })
    expect(await a.channelWrite.count()).toBe(3)
  })

  it('wiersz statusu firmy po zmianie statusu firmy zamówienia nie cofa kanału (pominięty)', async () => {
    await a.channelConfig.update({ where, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', config: { zapisWlaczony: true, statusy: {}, statusyFirmy: { SPAKOWANE_ALLEGRO: 'spakowane-allegro' } } as Prisma.InputJsonValue } })
    const id = await zam(a, 'SPAKOWANE', 'ALLEGRO')
    await zaplanujZapisy(a, registry, { now: at(60_000) })
    await a.order.update({ where: { id }, data: { status: 'DO_WYSLANIA' } })
    const r = await wykonajZapisy(a, ctx(at(61_000)))
    expect(r.pominiete).toBe(1)
    expect(state.writeCalls).toEqual([])
  })

  it('status firmy z etapu Nowe nie trafia do sklepu nawet z mapą; zapis takiej mapy odrzucony; formularz bez pola', async () => {
    await a.channelConfig.update({ where, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', config: { zapisWlaczony: true, statusy: {} } as Prisma.InputJsonValue } })
    await expect(zapiszMapeStatusow(a, SD, { statusfirmy_NOWE_ZAMOWIENIA: 'processing' }, { registry, actorId: 'test' })).rejects.toThrow(/Status firmy „Nowe zamówienia” nie idzie do sklepu/)
    await expect(zapiszMapeStatusow(a, SD, { statusfirmy_REKLAMACJA: 'completed' }, { registry, actorId: 'test' })).rejects.toThrow(/nie idzie do sklepu/)
    expect(((await a.channelConfig.findUniqueOrThrow({ where })).config as Record<string, unknown>)['statusyFirmy']).toBeUndefined()
    const ekran = (await ekranZapisu(a, registry, SD, at(0)))!
    expect(ekran.statusyFirmy.find((d) => d.key === 'NOWE_ZAMOWIENIA')?.doSklepu).toBe(false)
    expect(ekran.statusyFirmy.find((d) => d.key === 'ZEBRANE_DPD')?.doSklepu).toBe(true)
    // mapa wpisana obok formularza (stara konfiguracja, API): plan i wykonanie i tak nic nie wysyłają
    await a.channelConfig.update({ where, data: { config: { zapisWlaczony: true, statusy: {}, statusyFirmy: { NOWE_ZAMOWIENIA: 'processing', DO_WYJASNIENIA: 'on-hold' } } as Prisma.InputJsonValue } })
    const nowe = await zam(a, 'NOWE', 'DPD')
    await zam(a, 'DO_WYJASNIENIA', 'DPD')
    await zaplanujZapisy(a, registry, { now: at(60_000) })
    expect(await a.channelWrite.count()).toBe(0)
    // wiersz zaplanowany przed poprawką (klucz F:NOWE_ZAMOWIENIA) nie wychodzi
    const o = await a.order.findUniqueOrThrow({ where: { id: nowe } })
    await a.channelWrite.create({ data: { orderId: nowe, ...SD, kind: 'STATUS', key: 'F:NOWE_ZAMOWIENIA', mode: 'PRACA', state: 'OCZEKUJE', channelStatus: 'processing', reference: `ref-${o.id}`, nextAttemptAt: at(0), createdAt: at(0) } })
    const r = await wykonajZapisy(a, ctx(at(61_000)))
    expect(r.pominiete).toBe(1)
    expect(state.writeCalls).toEqual([])
  })

  // ×: bramka „Anuluj nieopłacone także w sklepie” obejmuje plan zapisów
  // ze statusami firmy. Anulowanie po terminie płatności idzie zawsze kluczem enumu (ANULOWANE_NIEOPLACONE, z ochroną
  // „tylko nieopłacone”), nigdy jako status firmy F:ANULOWANE.
  it('anulowanie nieopłaconego tylko przy włączonym „Anuluj nieopłacone także w sklepie”, zawsze kluczem enumu; zwykłe anulowanie jako status firmy', async () => {
    await a.channelConfig.update({ where, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', config: { zapisWlaczony: true, statusy: { ANULOWANE_NIEOPLACONE: 'cancelled' }, statusyFirmy: { ANULOWANE: 'odrzucone' } } as Prisma.InputJsonValue } })
    const nieopl = await zam(a, 'ANULOWANE', 'DPD', { cancelReason: 'EXPIRED_UNPAID' })
    const anul = await zam(a, 'ANULOWANE', 'DPD')
    const doWysl = await zam(a, 'DO_WYSLANIA', 'DPD')
    const wiersze = () => a.channelWrite.findMany({ select: { orderId: true, key: true, channelStatus: true } })

    await zapiszAutomatyWysylki(a, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: false }, 'test')
    await zaplanujZapisy(a, registry, { now: at(60_000) })
    let w = await wiersze()
    expect(w.filter((x) => x.orderId === anul)).toEqual([{ orderId: anul, key: 'F:ANULOWANE', channelStatus: 'odrzucone' }])
    expect(w.filter((x) => x.orderId === nieopl)).toEqual([])
    expect(w.filter((x) => x.orderId === doWysl)).toEqual([])

    await zapiszAutomatyWysylki(a, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true }, 'test')
    await zaplanujZapisy(a, registry, { now: at(120_000) })
    w = await wiersze()
    expect(w.filter((x) => x.orderId === nieopl)).toEqual([{ orderId: nieopl, key: 'ANULOWANE_NIEOPLACONE', channelStatus: 'cancelled' }])
    expect(w.filter((x) => x.orderId === anul)).toEqual([{ orderId: anul, key: 'F:ANULOWANE', channelStatus: 'odrzucone' }])
    expect(w.filter((x) => x.orderId === doWysl)).toEqual([])

    // zamówienie opłacone w sklepie: ochrona „tylko nieopłacone” (onlyIfUnpaid) odmawia, więc status w sklepie zostaje
    const ext = async (id: string) => (await a.order.findUniqueOrThrow({ where: { id } })).externalId
    state.paid.add(await ext(nieopl))
    await wykonajZapisy(a, ctx(at(121_000)))
    expect(state.writeCalls.filter((c) => c.op === 'status').map((c) => c.target).sort()).toEqual([`${await ext(anul)}:odrzucone`, `${await ext(nieopl)}:cancelled`].sort())
    expect(state.statuses.get(await ext(nieopl))).toBeUndefined()
    expect(state.statuses.get(await ext(anul))).toBe('odrzucone')
  })
})
