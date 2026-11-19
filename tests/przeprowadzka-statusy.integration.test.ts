// przeprowadzka z BL — statusy BL jako statusy firmy (nazwa, kolor, nazwa dla klienta, grupa, etap) i
// automaty z najbliższego szablonu w wyłączonej grupie „Z BaseLinkera”. Tryb próbny na nagranych odpowiedziach BL
// (kształt z dokumentacji getOrderStatusList / getOrderStatusGroups) niczego nie zapisuje; zapis zakłada statusy;
// drugi przebieg niczego nie dubluje. BL tylko jako atrapa HTTP (tests/bl-przeprowadzka-atrapa.ts), zero zapisów do BL.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { loadBlStatusMap } from '@/lib/organizacje'
import { etykietaStatusuFirmy } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { zbierz } from '@/lib/przeprowadzka/przebieg'
import { parseMapa, type MapaCzlowieka } from '@/lib/przeprowadzka/statusy'
import { GRUPA_AUTOMATOW_BL } from '@/lib/przeprowadzka/statusy-firmy'
import { uruchomPrzeprowadzke } from '@/lib/przeprowadzka/uruchomienie'
import { AtrapaBlPrzeprowadzki, NOW } from './bl-przeprowadzka-atrapa'
import { ORG_A, ORG_B, testDb, truncateAll } from './db'

// wymuszony błąd walidacji zestawu statusów (zapis i raport liczą go tą samą funkcją)
const wymus = vi.hoisted(() => ({ bladZestawu: null as string | null }))
vi.mock('@/lib/przeprowadzka/statusy-firmy', async (orig) => {
  const m = await orig<typeof import('@/lib/przeprowadzka/statusy-firmy')>()
  return { ...m, bladZestawu: (...a: Parameters<typeof m.bladZestawu>) => wymus.bladZestawu ?? m.bladZestawu(...a) }
})

const NOWE_FIRMY = [
  { id: ORG_A, slug: 'test-a', name: 'Firma testowa A' },
  { id: ORG_B, slug: 'test-b', name: 'Firma testowa B' },
]
const db = testDb()
const registry = defaultRegistry()
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  wymus.bladZestawu = null
  await truncateAll(undefined, NOWE_FIRMY)
})

/** Odpowiedzi BL w kształcie z dokumentacji (api.baselinker.com: getOrderStatusList, getOrderStatusGroups). */
function atrapa(): AtrapaBlPrzeprowadzki {
  const a = new AtrapaBlPrzeprowadzki()
  a.statusy = [
    { id: 1, name: 'Nowe zamówienia', color: '#0000FF', group_id: 1, is_primary: 1, name_for_customer: 'Zamówienie przyjęte' },
    { id: 2, name: 'Do wysłania', color: '#1C8752', group_id: 2, is_primary: 0, name_for_customer: 'Paczka czeka na kuriera' },
    { id: 3, name: 'Wysłane', color: '#808080', group_id: 3, is_primary: 0, name_for_customer: 'Paczka wysłana' },
    { id: 4, name: 'Anulowane', color: '#FF0000', group_id: 3, is_primary: 0, name_for_customer: '' },
    { id: 5, name: 'Status Xyz', color: '#ff9900', group_id: 2, is_primary: 0, name_for_customer: '' },
  ]
  a.grupyStatusow = [
    { group_id: 1, name: 'Brak grupy', is_main_group: 1 },
    { group_id: 2, name: 'W realizacji', is_main_group: 0 },
    { group_id: 3, name: 'Zakończone', is_main_group: 0 },
  ]
  return a
}
const MAPA: MapaCzlowieka = parseMapa({ statusy: { '5': 'DO_REALIZACJI' }, przewoznicy: { 'Poczta Polska': 'BRAK' } })

async function przebieg(zapisz: boolean, mapa: MapaCzlowieka = MAPA) {
  const fake = atrapa()
  const dane = await zbierz({ bl: fake.client(), wfirma: null, wfirmaWarehouseId: null }, { mapa, registry, now: NOW })
  // tylko metody odczytu: żadnej metody zapisu BL (add*, set*, delete*, run*)
  expect(fake.calls.filter((c) => /^(add|set|delete|run|update)/.test(c.method))).toEqual([])
  return uruchomPrzeprowadzke(db, { firma: 'test-a', dane, mapa, registry, zapisz, now: NOW })
}

const liczby = async () => ({
  statusy: await db.orderStatusDef.count(),
  grupy: await db.orderStatusGroup.count(),
  reguly: await db.automationRule.count(),
  grupyAutomatow: await db.automationGroup.count(),
})

describe('przeprowadzka: statusy BL jako statusy firmy i automaty', () => {
  it('tryb próbny: raport ze statusami, etapami, pozycjami do potwierdzenia i szablonem; nic nie zapisuje', async () => {
    const przed = await liczby()
    const r = await przebieg(false, parseMapa({ przewoznicy: { 'Poczta Polska': 'BRAK' } }))
    expect(await liczby()).toEqual(przed)
    const im = r.raport.importStatusow!
    expect(im.blad).toBeNull()
    expect(im.statusy.map((s) => [s.nazwa, s.etap, s.kolor, s.nazwaDlaKlienta, s.grupa, s.doPotwierdzenia])).toEqual([
      ['Nowe zamówienia', 'Nowe', 'niebieski', 'Zamówienie przyjęte', null, false],
      ['Do wysłania', 'Do wysłania', 'zielony', 'Paczka czeka na kuriera', 'W realizacji', false],
      ['Wysłane', 'Wysłane', 'szary', 'Paczka wysłana', 'Zakończone', false],
      ['Anulowane', 'Anulowane', 'czerwony', null, 'Zakończone', false],
      ['Status Xyz', 'Zbieranie', 'pomarańczowy', null, 'W realizacji', true],
    ])
    expect(im.automaty.szablon?.id).toBe('kurier-i-paczkomaty')
    expect(im.automaty.przeniesione.length).toBeGreaterThan(0)
    expect(r.raport.coPrzejdzie['statusyFirmyNowe']).toBe(5)
    expect(r.markdown).toContain('## Statusy i automatyczne akcje')
    expect(r.markdown).toContain('API BaseLinkera nie pozwala odczytać automatycznych akcji')
    // status do potwierdzenia z otwartym zamówieniem blokuje import (decyzja w „Decyzjach”)
    expect(r.powodyOdmowy.join(' ')).toMatch(/do decyzji/)
  })

  it('zapis: statusy z BL, grupy, ukryte domyślne, mapa dla cienia, reguły szablonu wyłączone; drugi przebieg nic nie dubluje', async () => {
    const r = await przebieg(true)
    expect(r.zapis?.konfiguracja.statusyFirmy).toEqual({ nowe: 5, grupy: 2, ukryte: 5, blad: null })
    expect(r.zapis?.konfiguracja.automaty).toMatchObject({ szablon: 'kurier-i-paczkomaty', juzBylo: false })
    const st = (await statusyFirmy(db)).statusy
    const bl1 = st.find((s) => s.key === 'BL_1')!
    expect(bl1).toMatchObject({ name: 'Nowe zamówienia', color: 'niebieski', customerName: 'Zamówienie przyjęte', groupKey: null, baseStatus: 'NOWE', active: true })
    expect(st.find((s) => s.key === 'BL_2')).toMatchObject({ groupKey: 'BL_G2', baseStatus: 'DO_WYSLANIA', color: 'zielony' })
    expect(st.find((s) => s.key === 'BL_5')).toMatchObject({ baseStatus: 'DO_REALIZACJI' }) // decyzja z mapy
    expect(st.find((s) => s.key === 'NOWE')?.active).toBe(false) // domyślny „Nowe” ukryty: lista pokazuje nazwę z BL
    expect(st.find((s) => s.key === 'ZEBRANE')?.active).toBe(true) // etap bez statusu z BL zostaje
    // mapa statusów BL → klucz statusu firmy (cień, kopia statusów)
    const mapa = await loadBlStatusMap(db)
    expect(mapa['2']).toMatchObject({ status: 'DO_WYSLANIA', klucz: 'BL_2' })
    // zamówienie przeniesione ze statusu „Nowe zamówienia” widać pod nazwą z BL
    const zam = await db.order.findMany({ where: { status: 'NOWE' }, select: { status: true, carrier: true, companyStatus: true } })
    for (const o of zam) expect(etykietaStatusuFirmy(st, o).nazwa).toBe('Nowe zamówienia')
    // automaty: grupa „Z BaseLinkera”, wszystkie reguły wyłączone, na statusach z BL
    const g = await db.automationGroup.findFirstOrThrow({ where: { name: GRUPA_AUTOMATOW_BL } })
    const reguly = await db.automationRule.findMany({ where: { groupId: g.id } })
    expect(reguly.length).toBe(r.zapis!.konfiguracja.automaty!.reguly)
    expect(reguly.every((x) => !x.enabled)).toBe(true)
    expect(JSON.stringify(reguly.map((x) => x.actions))).toContain('BL_2')

    const po1 = await liczby()
    const r2 = await przebieg(true)
    expect(r2.zapis?.konfiguracja.statusyFirmy).toEqual({ nowe: 0, grupy: 0, ukryte: 0, blad: null })
    expect(r2.zapis?.konfiguracja.automaty).toMatchObject({ reguly: 0, juzBylo: true })
    expect(await liczby()).toEqual(po1)
    expect(r2.raport.importStatusow!.statusy.every((s) => s.juzJest)).toBe(true)
  })

  it('grupa „Z BaseLinkera” przemianowana i z usuniętą regułą, potem skasowana: kolejny import 0 nowych reguł', async () => {
    const r1 = await przebieg(true)
    const zalozone = r1.zapis!.konfiguracja.automaty!.reguly
    expect(zalozone).toBeGreaterThan(1)
    const g = await db.automationGroup.findFirstOrThrow({ where: { name: GRUPA_AUTOMATOW_BL } })
    const org = await db.organization.findFirstOrThrow({ select: { settings: true } })
    expect((org.settings as { baselinker: { przeprowadzka: { automaty: unknown } } }).baselinker.przeprowadzka.automaty).toMatchObject({ szablon: 'kurier-i-paczkomaty', grupaId: g.id, reguly: zalozone })

    await db.automationGroup.update({ where: { id: g.id }, data: { name: 'Moje automaty' } })
    const jedna = await db.automationRule.findFirstOrThrow({ where: { groupId: g.id } })
    await db.automationRule.delete({ where: { id: jedna.id } })
    const r2 = await przebieg(true)
    expect(r2.raport.importStatusow!.automaty.juzJest).toBe(true)
    expect(r2.zapis?.konfiguracja.automaty).toMatchObject({ reguly: 0, juzBylo: true })
    expect(await db.automationRule.count()).toBe(zalozone - 1)
    expect(await db.automationGroup.count({ where: { name: GRUPA_AUTOMATOW_BL } })).toBe(0)

    // cała grupa skasowana w panelu: decyzja użytkownika, import jej nie odtwarza
    await db.automationRule.deleteMany({ where: { groupId: g.id } })
    await db.automationGroup.delete({ where: { id: g.id } })
    const r3 = await przebieg(true)
    expect(r3.zapis?.konfiguracja.automaty).toMatchObject({ reguly: 0, juzBylo: true })
    expect(await db.automationRule.count()).toBe(0)
  })

  it('zestaw statusów z błędem walidacji = żadnych statusów BL i mapa bez kluczy; po poprawie klucze wchodzą razem ze statusami', async () => {
    wymus.bladZestawu = 'Brakuje statusu dla: Wysłane'
    const r = await przebieg(true)
    expect(r.zapis?.konfiguracja.statusyFirmy).toEqual({ nowe: 0, grupy: 0, ukryte: 0, blad: 'Brakuje statusu dla: Wysłane' })
    expect(r.zapis?.konfiguracja.automaty).toMatchObject({ reguly: 0 })
    expect(await db.orderStatusDef.count({ where: { key: { startsWith: 'BL_' } } })).toBe(0)
    const mapa = await loadBlStatusMap(db)
    expect(Object.keys(mapa).length).toBeGreaterThan(0) // decyzje etapów zostają (cień liczy po nich jak dotąd)
    expect(Object.values(mapa).every((m) => !('klucz' in m))).toBe(true)
    const org = await db.organization.findFirstOrThrow({ select: { settings: true } })
    expect((org.settings as { baselinker: { przeprowadzka: Record<string, unknown> } }).baselinker.przeprowadzka['automaty']).toBeUndefined()

    wymus.bladZestawu = null
    const r2 = await przebieg(true)
    expect(r2.zapis?.konfiguracja.statusyFirmy?.blad).toBeNull()
    expect(r2.zapis?.konfiguracja.automaty?.reguly).toBeGreaterThan(0)
    const mapa2 = await loadBlStatusMap(db)
    const klucze = Object.values(mapa2).map((m) => (m as { klucz?: string }).klucz).filter(Boolean)
    expect(klucze.length).toBeGreaterThan(0)
    const istnieja = new Set((await db.orderStatusDef.findMany({ select: { key: true } })).map((s) => s.key))
    expect(klucze.every((k) => istnieja.has(k!))).toBe(true)
  })

  it('zmiany z panelu po imporcie zostają po kolejnym przebiegu; firma B nietknięta', async () => {
    await przebieg(true)
    await db.orderStatusDef.update({ where: { organizationId_key: { organizationId: ORG_A, key: 'BL_2' } }, data: { name: 'Czeka na kuriera', color: 'turkusowy' } })
    await przebieg(true)
    expect(await db.orderStatusDef.findUniqueOrThrow({ where: { organizationId_key: { organizationId: ORG_A, key: 'BL_2' } } })).toMatchObject({ name: 'Czeka na kuriera', color: 'turkusowy' })
    const b = testDb({ organizationId: ORG_B })
    try {
      expect(await b.orderStatusDef.count({ where: { key: { startsWith: 'BL_' } } })).toBe(0)
      expect(await b.automationRule.count()).toBe(0)
    } finally {
      await b.$disconnect()
    }
  })
})
