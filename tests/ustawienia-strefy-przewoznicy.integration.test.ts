// strefy magazynu firmy, reguły przewoźników i konta przewoźników z panelu (zapis jednym przyciskiem,
// walidacja, AuditLog, izolacja firm) oraz zachowanie ACME bez zmian (te same strefy i reguły po presecie).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { applyOrgPreset } from '@/lib/organizacje'
import { packingQueue, productZoneInfo, setProductZone } from '@/lib/pakowanie/dane'
import { LEGACY_ZONES } from '@/lib/pakowanie/strefy'
import { StrefyError, ustawieniaStref, zapiszStrefy } from '@/lib/pakowanie/strefy-dane'
import { carrierFromRules, DEFAULT_CARRIER_RULES, loadCarrierRules } from '@/lib/rdzen/przewoznicy'
import { listSecrets } from '@/lib/sekrety'
import { kontaPrzewoznikow, PRZEWOZNIK_TEST_JOB, wykonajTestKonta, zapiszKontaPrzewoznikow, zlecTestKonta } from '@/lib/wysylka/konta'
import { regulyPrzewoznikow, RegulyError, testRegul, zapiszRegulyPrzewoznikow } from '@/lib/wysylka/reguly'
import { ACME_CARRIER_RULES, ACME_EXAMPLE_ZONE_RULES, ACME_PRESET } from '@/tests/preset-testowy'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { grupujPoProdukcie, linieProduktow, pozycjeBrakow, sortujGrupy, zdecydujMasowo } from '@/lib/panel/braki'

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const registry = defaultRegistry()
const ENV = { APP_ENCRYPTION_KEY: 'b'.repeat(64), APP_MODE: 'self-host' }

beforeEach(async () => {
  await truncateAll()
  for (const db of [a, b]) await seedBase(db)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

const prod = async (sku: string, title: string, packingZone: string | null = null) =>
  (await a.product.create({ data: { sku, kind: 'STOCKED', unit: 'SZT', nameAccounting: title, title, packingZone } })).id

describe('strefy magazynu firmy', () => {
  it('nowa firma bez stref: brak filtrów; zapis stref i reguł jednym zapisem, nowa strefa wskazana odnośnikiem', async () => {
    expect((await packingQueue(a, { tab: 'na_sucho', zone: 'przyprawy' })).zones).toEqual([])
    expect(await ustawieniaStref(a)).toEqual({ strefy: [], reguly: [] })
    const r = await zapiszStrefy(
      a,
      {
        strefy: [
          { key: null, ref: 'nowa-1', name: 'Regał A', color: 'zielen' },
          { key: null, ref: 'nowa-2', name: 'Pomieszczenie obok', color: 'niebo' },
        ],
        reguly: [
          { zone: 'nowa-2', pattern: 'kawa|przyprawa' },
          { zone: 'nowa-1', pattern: 'kubek' },
        ],
      },
      'u-a',
    )
    expect(r).toEqual({ strefy: 2, reguly: 2 })
    const u = await ustawieniaStref(a)
    expect(u.strefy.map((s) => [s.key, s.name, s.color, s.sortOrder])).toEqual([
      ['REGAL_A', 'Regał A', 'zielen', 10],
      ['POMIESZCZENIE_OBOK', 'Pomieszczenie obok', 'niebo', 20],
    ])
    expect(u.reguly.map((x) => [x.priority, x.pattern, x.zone])).toEqual([
      [10, 'kawa|przyprawa', 'POMIESZCZENIE_OBOK'],
      [20, 'kubek', 'REGAL_A'],
    ])
    const kubek = await prod('K1', 'Kubek biały')
    expect((await productZoneInfo(a, kubek))!.zone).toBe('REGAL_A')
    expect(await a.auditLog.count({ where: { entity: 'PackingZoneDef' } })).toBe(1)
    // druga firma nic nie widzi
    expect(await ustawieniaStref(b)).toEqual({ strefy: [], reguly: [] })
  })

  it('zmiana nazwy i kolejności zachowuje klucz; strefy z ręcznym produktem nie da się usunąć; reguły ze zła strefą odrzucone', async () => {
    await zapiszStrefy(a, { strefy: [{ key: null, ref: 'n1', name: 'A', color: 'szary' }, { key: null, ref: 'n2', name: 'B', color: 'szary' }], reguly: [] }, 'u')
    await prod('P1', 'Produkt', 'A')
    await zapiszStrefy(a, { strefy: [{ key: 'B', ref: '', name: 'Bis', color: 'sliwka' }, { key: 'A', ref: '', name: 'Alfa', color: 'ziemia' }], reguly: [] }, 'u')
    expect((await ustawieniaStref(a)).strefy.map((s) => [s.key, s.name, s.produktyRecznie])).toEqual([
      ['B', 'Bis', 0],
      ['A', 'Alfa', 1],
    ])
    await expect(zapiszStrefy(a, { strefy: [{ key: 'B', ref: '', name: 'Bis', color: 'sliwka' }], reguly: [] }, 'u')).rejects.toThrow(/nie można usunąć/)
    await expect(zapiszStrefy(a, { strefy: [{ key: 'A', ref: '', name: 'Alfa', color: 'ziemia' }, { key: 'B', ref: '', name: 'alfa', color: 'szary' }], reguly: [] }, 'u')).rejects.toMatchObject({ pole: 'strefa-1-nazwa' })
    await expect(zapiszStrefy(a, { strefy: [{ key: 'A', ref: '', name: 'Alfa', color: 'ziemia' }, { key: 'B', ref: '', name: 'Bis', color: 'szary' }], reguly: [{ zone: 'X', pattern: 'a' }] }, 'u')).rejects.toMatchObject({ pole: 'regula-0-strefa' })
    const e = await zapiszStrefy(a, { strefy: [{ key: 'A', ref: '', name: 'Alfa', color: 'ziemia' }, { key: 'B', ref: '', name: 'Bis', color: 'szary' }], reguly: [{ zone: 'A', pattern: '(' }] }, 'u').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(StrefyError)
    expect((e as StrefyError).pole).toBe('regula-0-slowa')
    // nic się nie zmieniło po odrzuconym zapisie
    expect((await ustawieniaStref(a)).strefy).toHaveLength(2)
    // usunięcie strefy bez produktów: reguły tej strefy znikają razem z nią (formularz ich nie wysyła)
    await setProductZone(a, (await a.product.findFirstOrThrow({ where: { sku: 'P1' } })).id, null, 'u')
    await zapiszStrefy(a, { strefy: [{ key: 'B', ref: '', name: 'Bis', color: 'sliwka' }], reguly: [{ zone: 'B', pattern: 'x' }] }, 'u')
    expect((await ustawieniaStref(a)).strefy.map((s) => s.key)).toEqual(['B'])
  })

  it('ACME: preset daje dawne strefy i reguły; zapis z panelu zostawia te same reguły i filtry, już nie „przykładowe”', async () => {
    await applyOrgPreset(sys, ACME_PRESET)
    const acme = testDb({ organizationId: 'acme' })
    try {
      const u = await ustawieniaStref(acme)
      expect(u.strefy.map((s) => [s.key, s.name])).toEqual(LEGACY_ZONES.map((z) => [z.key, z.name]))
      expect(u.reguly.map((r) => [r.pattern, r.zone, r.example])).toEqual(ACME_EXAMPLE_ZONE_RULES.map((r) => [r.pattern, r.zone, true]))
      await zapiszStrefy(acme, { strefy: u.strefy.map((s) => ({ key: s.key, ref: '', name: s.name, color: s.color })), reguly: u.reguly.map((r) => ({ zone: r.zone, pattern: r.pattern })) }, 'u')
      const po = await ustawieniaStref(acme)
      expect(po.reguly.map((r) => [r.priority, r.pattern, r.zone, r.example])).toEqual(u.reguly.map((r) => [r.priority, r.pattern, r.zone, false]))
      expect(po.strefy.map((s) => [s.key, s.name, s.color, s.sortOrder])).toEqual(u.strefy.map((s) => [s.key, s.name, s.color, s.sortOrder]))
    } finally {
      await acme.$disconnect()
    }
  })
})

describe('reguły przewoźników z panelu', () => {
  it('zapis listy: kolejność = priorytet, id i konfiguracja istniejących reguł zostają, dopasowanie po zapisie', async () => {
    const przed = await regulyPrzewoznikow(a)
    expect(przed.map((r) => r.pattern)).toEqual(ACME_CARRIER_RULES.map((r) => r.pattern))
    const dpd = przed.find((r) => r.carrier === 'DPD')!
    await a.carrierRule.update({ where: { id: dpd.id }, data: { config: { courierCode: 'dpd' } } })
    // nowa reguła na górze: „kurier inpost” → InPost kurier przez ShipX; DPD bez zmian
    const wiersze = [
      { id: null, channel: '', pattern: 'kurier inpost', carrier: 'INPOST_KURIER', adapterKey: 'inpost.shipx.v1' },
      ...przed.map((r) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '' })),
    ]
    await zapiszRegulyPrzewoznikow(a, registry, wiersze, 'u-a')
    const po = await regulyPrzewoznikow(a)
    expect(po.map((r) => [r.priority, r.carrier, r.shippingModule])).toEqual([
      [10, 'INPOST_KURIER', 'INPOST_SHIPX'],
      [20, 'ALLEGRO', 'WYSYLAM_Z_ALLEGRO'],
      [30, 'PACZKOMATY', 'BASE_COURIER'],
      [40, 'DPD_EMPIK', 'BASE_COURIER'],
      [50, 'DPD', 'BASE_COURIER'],
      [60, 'OSOBISTY', 'BRAK'],
    ])
    expect(po.find((r) => r.carrier === 'DPD')!.id).toBe(dpd.id)
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: dpd.id } })).config).toEqual({ courierCode: 'dpd' })
    const rules = await loadCarrierRules(a)
    expect(carrierFromRules(rules, 'WOO', 'Kurier InPost')).toEqual({ carrier: 'INPOST_KURIER', shippingModule: 'INPOST_SHIPX' })
    expect(carrierFromRules(rules, 'WOO', 'Kurier DPD')).toEqual({ carrier: 'DPD', shippingModule: 'BASE_COURIER' })
    expect(await a.auditLog.count({ where: { entity: 'CarrierRule' } })).toBe(1)
    // usunięcie reguły
    await zapiszRegulyPrzewoznikow(a, registry, po.slice(1).map((r) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '' })), 'u-a')
    expect((await regulyPrzewoznikow(a)).map((r) => r.pattern)).toEqual(ACME_CARRIER_RULES.map((r) => r.pattern))
    // druga firma ma swoje reguły bez zmian
    expect((await regulyPrzewoznikow(b)).map((r) => r.pattern)).toEqual(ACME_CARRIER_RULES.map((r) => r.pattern))
  })

  it('walidacja przy polu: zły wzorzec, Wysyłam z Allegro poza Allegro, nieznany moduł; nic nie zapisane', async () => {
    const przed = await regulyPrzewoznikow(a)
    const zly = async (w: Parameters<typeof zapiszRegulyPrzewoznikow>[2]) => (await zapiszRegulyPrzewoznikow(a, registry, w, 'u').catch((e: unknown) => e)) as RegulyError
    expect((await zly([{ id: null, channel: '', pattern: '(', carrier: 'DPD', adapterKey: '' }])).pole).toBe('regula-0-slowa')
    expect((await zly([{ id: null, channel: 'WOO', pattern: '', carrier: 'ALLEGRO', adapterKey: 'allegro.wysylam.v1' }])).pole).toBe('regula-0-kanal')
    expect((await zly([{ id: null, channel: '', pattern: 'x', carrier: 'DPD', adapterKey: 'woo.v1' }])).pole).toBe('regula-0-modul')
    expect((await zly([{ id: null, channel: '', pattern: 'x', carrier: 'BRAK', adapterKey: '' }])).pole).toBe('regula-0-przewoznik')
    expect((await zly([{ id: 'nie-ma', channel: '', pattern: 'x', carrier: 'DPD', adapterKey: '' }])).message).toMatch(/odśwież/)
    expect(await regulyPrzewoznikow(a)).toEqual(przed)
  })

  it('podgląd na ostatnich zamówieniach: sposób dostawy → numer reguły albo brak', async () => {
    await a.order.createMany({
      data: [
        { channel: 'WOO', channelAccountId: 'sd', externalId: 'T1', status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'przelew', deliveryMethod: 'Kurier DPD', createdAtChannel: new Date(), totalGross: 10 },
        { channel: 'WOO', channelAccountId: 'sd', externalId: 'T2', status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'przelew', deliveryMethod: 'Kurier DPD', createdAtChannel: new Date(), totalGross: 10 },
        { channel: 'WOO', channelAccountId: 'sd', externalId: 'T3', status: 'DO_REALIZACJI', paymentState: 'PAID', paymentMethod: 'przelew', deliveryMethod: 'Poczta Polska', createdAtChannel: new Date(), totalGross: 10 },
      ] as never,
    })
    const t = await testRegul(a)
    expect(t.map((x) => [x.metoda, x.zamowien, x.regula, x.carrier])).toEqual([
      ['Kurier DPD', 2, 4, 'DPD'],
      ['Poczta Polska', 1, null, null],
    ])
  })

  it('nowa firma: startowe reguły bez „kurier → DPD” (ogólny kurier = do wyjaśnienia), DPD z nazwy zostaje', () => {
    expect(carrierFromRules(DEFAULT_CARRIER_RULES, 'WOO', 'Kurier').carrier).toBe('BRAK')
    expect(carrierFromRules(DEFAULT_CARRIER_RULES, 'WOO', 'Kurier DPD').carrier).toBe('DPD')
    expect(carrierFromRules(ACME_CARRIER_RULES, 'WOO', 'Kurier').carrier).toBe('DPD') // ACME bez zmian
  })
})

describe('konta przewoźników z panelu', () => {
  it('lista kont z rodzin adapterów, klucze tylko jako „ustawiony”, zapis kluczy, ustawień i wyłącznika nadawania', async () => {
    const dpdRule = await a.carrierRule.create({ data: { priority: 70, channel: null, pattern: 'dpd bezpośrednio', carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: {} } })
    let konta = await kontaPrzewoznikow(a, registry)
    const nazwy = konta.map((k) => k.id)
    expect(nazwy).toEqual(expect.arrayContaining(['basecourier', 'dpd', 'inpost']))
    expect(nazwy.some((n) => n.startsWith('allegro'))).toBe(false)
    const dpd = konta.find((k) => k.id === 'dpd')!
    expect(dpd.sekrety.map((s) => [s.name, s.ustawiony])).toEqual([
      ['DPD_LOGIN', false],
      ['DPD_PASSWORD', false],
      ['DPD_MYPUDO_KEY', false],
    ])
    expect(dpd.reguly).toEqual([{ id: dpdRule.id, priority: 70, carrier: 'DPD', adapterKey: 'dpd.services.zapis.v1', nadawanie: false }])
    expect(dpd.pola.map((p) => p.key)).toContain('payerFid')
    // reguły ACME (Base Courier) przypięte do konta Base Courier
    expect(konta.find((k) => k.id === 'basecourier')!.reguly.map((r) => r.carrier)).toEqual(['PACZKOMATY', 'DPD_EMPIK', 'DPD'])

    await expect(zapiszKontaPrzewoznikow(a, registry, [{ id: 'dpd', sekrety: {}, pola: { payerFid: 'zly fid' }, nadawanie: {} }], { actorId: 'u', env: ENV })).rejects.toThrow(/zły format/)
    const r = await zapiszKontaPrzewoznikow(a, registry, [{ id: 'dpd', sekrety: { DPD_LOGIN: 'login-testowy', DPD_PASSWORD: '' }, pola: { payerFid: '1495' }, nadawanie: { [dpdRule.id]: true } }], { actorId: 'u', env: ENV })
    expect(r).toEqual({ klucze: 1, reguly: 1 })
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: dpdRule.id } })).config).toEqual({ payerFid: '1495', zapisWlaczony: true })
    expect((await listSecrets(a)).map((s) => s.name)).toContain('DPD_LOGIN')
    konta = await kontaPrzewoznikow(a, registry)
    expect(konta.find((k) => k.id === 'dpd')!.sekrety.find((s) => s.name === 'DPD_LOGIN')!.ustawiony).toBe(true)
    // AuditLog bez wartości kluczy
    const log = await a.auditLog.findFirstOrThrow({ where: { entity: 'CarrierRule.config' } })
    expect(JSON.stringify(log)).not.toContain('login-testowy')
    // wyłączenie nadawania usuwa flagę
    await zapiszKontaPrzewoznikow(a, registry, [{ id: 'dpd', sekrety: {}, pola: {}, nadawanie: { [dpdRule.id]: false } }], { actorId: 'u', env: ENV })
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: dpdRule.id } })).config).toEqual({ payerFid: '1495' })
    // druga firma nie widzi kluczy ani konfiguracji
    expect((await kontaPrzewoznikow(b, registry)).find((k) => k.id === 'dpd')!.sekrety.every((s) => !s.ustawiony)).toBe(true)
  })

  it('test połączenia: zadanie w kolejce, drugie kliknięcie od razu = za często, wynik w ustawieniach firmy', async () => {
    expect(await zlecTestKonta(a, registry, 'inpost')).toBe('ZLECONO')
    expect(await zlecTestKonta(a, registry, 'inpost')).toBe('ZA_CZESTO')
    expect(await a.job.count({ where: { kind: PRZEWOZNIK_TEST_JOB } })).toBe(1)
    await expect(zlecTestKonta(a, registry, 'nie-ma')).rejects.toThrow(/Nie ma takiego konta/)
    // bez kluczy: błąd konfiguracji jako komunikat, bez wywołania sieci
    let wolania = 0
    const fetch = async () => {
      wolania++
      return new Response('{}', { status: 401 })
    }
    const w = await wykonajTestKonta(a, { konto: 'inpost' }, { registry, secrets: { env: ENV, envFallback: false }, fetch })
    expect(w!.ok).toBe(false)
    expect(wolania).toBe(0)
    const k = (await kontaPrzewoznikow(a, registry)).find((x) => x.id === 'inpost')!
    expect(k.test).toMatchObject({ ok: false })
    expect(await wykonajTestKonta(a, { konto: 'inny' }, { registry, secrets: { env: ENV, envFallback: false }, fetch })).toBeNull()
    expect(ORG_A).toBe('test_a')
  })
})

describe('braki towaru: lista „Brakuje”, grupy po produkcie, decyzja masowa', () => {
  it('domyślnie bez zamówień zamkniętych i bez paczek, które wyszły; grupy po produkcie; wyszukiwarka; decyzja dla grupy', async () => {
    const herb = await product(a, 'HERB-1', 1)
    const kawa = await product(a, 'KAWA-1', 0)
    const o1 = (await ingestOrder(a, order([{ productId: herb, qty: 3 }, { productId: kawa, qty: 1 }]))).orderId!
    const o2 = (await ingestOrder(a, order([{ productId: herb, qty: 2 }]))).orderId!
    const o3 = (await ingestOrder(a, order([{ productId: kawa, qty: 2 }]))).orderId!
    // o3 „wysłane” z otwartym brakiem (jak w demo sprzed poprawki): poza listą domyślną
    await a.order.update({ where: { id: o3 }, data: { status: 'WYSLANE' } })
    const poz = await pozycjeBrakow(a, {})
    expect(new Set(poz.map((p) => p.order.id))).toEqual(new Set([o1, o2]))
    expect((await pozycjeBrakow(a, { zamkniete: true })).some((p) => p.order.id === o3)).toBe(true)
    const g = grupujPoProdukcie(poz)
    const gh = g.find((x) => x.productId === herb)!
    expect([gh.qty, gh.zamowien, gh.decyzje]).toEqual([4, 2, { BRAK: 2 }]) // 1 sztuka zarezerwowana dla o1
    expect((await pozycjeBrakow(a, { q: 'kawa-1' })).map((p) => p.productId)).toEqual([kawa])
    // decyzja „dośle później” dla całej grupy HERB-1 (konta testowe w cieniu: zapis decyzji bez rdzenia)
    const linie = await linieProduktow(a, [herb], {})
    expect(linie).toHaveLength(2)
    const w = await zdecydujMasowo(a, linie, 'DOSLIJ', 'u-a')
    expect(w).toEqual({ zapisane: 2, bezZmian: 0, pominiete: 0, bledy: [] })
    expect(grupujPoProdukcie(await pozycjeBrakow(a, {})).find((x) => x.productId === herb)!.decyzje).toEqual({ DOSLIJ: 2 })
    // druga firma nie zobaczy ani nie zmieni
    expect(await pozycjeBrakow(b, {})).toEqual([])
    const wb = await zdecydujMasowo(b, linie, 'POCZEKAJ', 'u-b')
    expect(wb.zapisane).toBe(0)
    expect(wb.bledy).toHaveLength(2)
    // zamiana produktu nie idzie masowo
    await expect(zdecydujMasowo(a, linie, 'ZAMIEN', 'u-a')).rejects.toThrow(/wielu pozycji/)
  })

  it('grupowanie: 105 pozycji z 12 produktów mieści się w 12 wierszach grup', () => {
    const poz = Array.from({ length: 105 }, (_, i) => ({
      id: `s${i}`,
      orderLineId: `l${i}`,
      productId: `p${i % 12}`,
      qtyBase: 1,
      state: 'OPEN',
      createdAt: new Date(2026, 10, 1, 0, i),
      order: { id: `o${i}`, channel: 'WOO' as const, channelAccountId: 'sd', externalId: String(i), status: 'DO_REALIZACJI' as const },
      title: `Produkt ${i % 12}`,
      sku: `P${i % 12}`,
      unit: 'SZT',
      decyzja: null,
    }))
    const g = grupujPoProdukcie(poz)
    expect(g).toHaveLength(12)
    expect(g.reduce((s, x) => s + x.pozycje, 0)).toBe(105)
    expect(sortujGrupy(g, { klucz: 'zamowien', kierunek: 'malejaco' })[0]!.zamowien).toBe(9)
  })
})

describe('reguła z ustawieniami spoza panelu', () => {
  const doWejscia = (r: Awaited<ReturnType<typeof regulyPrzewoznikow>>[number]) => ({ id: r.id, channel: r.channel ?? '', pattern: r.pattern ?? '', carrier: r.carrier, adapterKey: r.adapterKey ?? '' })

  it('usunięcie reguły z config wymaga potwierdzenia, config trafia do AuditLog; edycja zostawia config', async () => {
    const przed = await regulyPrzewoznikow(a)
    const empik = przed.find((r) => r.carrier === 'DPD_EMPIK')!
    await a.carrierRule.update({ where: { id: empik.id }, data: { config: { sekretyKonta: 'EMPIK', courierCode: 'dpd' } } })
    const z = (await regulyPrzewoznikow(a)).find((r) => r.id === empik.id)!
    expect(z.konfiguracja).toBe('drugie konto przewoźnika (EMPIK); ustawienia konta: courierCode')
    expect((await regulyPrzewoznikow(a)).filter((r) => r.id !== empik.id).every((r) => r.konfiguracja === null)).toBe(true)

    // edycja (inne słowa, ta sama reguła): config zostaje
    await zapiszRegulyPrzewoznikow(a, registry, (await regulyPrzewoznikow(a)).map((r) => (r.id === empik.id ? { ...doWejscia(r), pattern: 'salon(u)? empik|empik salon' } : doWejscia(r))), 'u-a')
    expect((await a.carrierRule.findUniqueOrThrow({ where: { id: empik.id } })).config).toEqual({ sekretyKonta: 'EMPIK', courierCode: 'dpd' })

    // usunięcie bez potwierdzenia: odmowa, nic nie zapisane
    const bez = (await regulyPrzewoznikow(a)).filter((r) => r.id !== empik.id).map(doWejscia)
    const logow = await a.auditLog.count({ where: { entity: 'CarrierRule' } })
    const e = (await zapiszRegulyPrzewoznikow(a, registry, bez, 'u-a').catch((x: unknown) => x)) as RegulyError
    expect(e).toBeInstanceOf(RegulyError)
    expect(e.message).toMatch(/drugie konto przewoźnika \(EMPIK\)/)
    expect(await a.carrierRule.count({ where: { id: empik.id } })).toBe(1)
    expect(await a.auditLog.count({ where: { entity: 'CarrierRule' } })).toBe(logow)

    // z potwierdzeniem: reguła znika, jej config w before; config pozostałych reguł nie ląduje w logu
    await zapiszRegulyPrzewoznikow(a, registry, bez, 'u-a', { usunZKonfiguracja: [empik.id] })
    expect(await a.carrierRule.count({ where: { id: empik.id } })).toBe(0)
    const log = await a.auditLog.findFirstOrThrow({ where: { entity: 'CarrierRule' }, orderBy: { createdAt: 'desc' } })
    const before = log.before as { id: string; config?: unknown }[]
    expect(before.find((r) => r.id === empik.id)!.config).toEqual({ sekretyKonta: 'EMPIK', courierCode: 'dpd' })
    expect(before.filter((r) => r.id !== empik.id).every((r) => !('config' in r))).toBe(true)
  })

  it('reguła bez config usuwa się bez potwierdzenia', async () => {
    const przed = await regulyPrzewoznikow(a)
    await zapiszRegulyPrzewoznikow(a, registry, przed.slice(1).map(doWejscia), 'u-a')
    expect((await regulyPrzewoznikow(a)).length).toBe(przed.length - 1)
  })
})
