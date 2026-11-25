// Zamówienie odbioru paczek przez kuriera w Wysyłam z Allegro (`allegro.wysylam.zapis.v1`, zdolność shipment.pickup) na
// atrapie: przewoźnik przesyłek, terminy z Allegro jako podpowiedź, komenda odbioru z odpytywaniem, powtórka bez
// drugiego odbioru, wyłączniki, odmowa Allegro i niewiadoma. Dane fikcyjne, zero połączeń z prawdziwym Allegro.
import { describe, expect, it } from 'vitest'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, SHIPMENTS_WRITE, UA } from '@/tests/allegro-zapis-atrapa'
import { ALLEGRO_SECRETS as S } from './allegro'
import {
  adresOdbioruAllegro,
  ALLEGRO_WYSYLAM_ZAPIS_KEY,
  AllegroWysylamZapisAdapter,
  commandIdOdbioru,
  dniZTerminow,
  grupujPrzesylkiOdbioru,
  KOD_OSOBNE_ODBIORY,
  przewoznicyTransportu,
  MAX_PROB_ODBIORU,
  SKLAD,
  skladOdbioru,
  terminOdbioru,
  wspolneTerminyOdbioru,
} from './allegro-wysylam-zapis'
import { defaultRegistry } from './domyslne'
import { hasPickupAvailability, hasPickupGrouping, hasPickupOrderer, type PickupOrderRequest } from './kontrakt'

const NOW = new Date('2026-11-23T08:00:00.000Z') // poniedziałek 23.11, 09:00 w Warszawie
const REF = 'b3c1d9a2-1111-5222-8333-444455556677'
const P1 = '00000000-0000-4000-9000-000000000101'
const P2 = '00000000-0000-4000-9000-000000000102'
const P3 = '00000000-0000-4000-9000-000000000103'
const NADAWCA = { name: 'Firma Testowa', address: 'ul. Magazynowa 1', city: 'Poznań', postalCode: '60-001', countryCode: 'PL', phone: '600100200', email: 'magazyn@example.test' }
const WLACZONE = { zapisWlaczony: true, zamawianieKuriera: true, nadawca: JSON.stringify(NADAWCA) }
const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'ALLEGRO/71045', name: 'Allegro', channel: 'ALLEGRO' as const, channelAccountId: '71045' }
// okno z harmonogramu 13:00–15:00
const ZLEC: PickupOrderRequest = { data: '2026-11-23', odMin: 13 * 60, doMin: 15 * 60, paczki: [{ wagaKg: 1 }, { wagaKg: 2 }], przesylki: [P1, P2] }

function make(fake: FakeAllegroZapis, config: Record<string, unknown> = WLACZONE): AllegroWysylamZapisAdapter {
  const pair = fake.base.issuePair()
  const a = defaultRegistry().create(ALLEGRO_WYSYLAM_ZAPIS_KEY, {
    integration,
    rawConfig: { apiUrl: API, authUrl: AUTH, userAgent: UA, ...config },
    rawSecrets: { [S.clientId]: FAKE_CLIENT_ID, [S.clientSecret]: FAKE_CLIENT_SECRET, [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: new Date(NOW.getTime() + 600 * 60_000).toISOString() },
    fetch: fake.fetch,
    now: () => NOW,
    http: { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0, pollDelayMs: 0 },
    persistSecrets: async () => {},
  })
  if (!(a instanceof AllegroWysylamZapisAdapter)) throw new Error('zły adapter')
  return a
}
/** Atrapa z przesyłkami w Allegro: P1 i P2 Allegro One, P3 InPost (paczkomat). */
const fakeNow = () => {
  const f = new FakeAllegroZapis()
  f.base.clock = () => NOW.getTime()
  for (const [id, carrier] of [
    [P1, 'ALLEGRO'],
    [P2, 'ALLEGRO'],
    [P3, 'INPOST'],
  ] as const)
    f.wys.shipments.set(id, { id, carrier, canceledDate: null, packages: [{ waybill: `A00${id.slice(-3)}` }] })
  return f
}
const odbiory = (f: FakeAllegroZapis) => f.writes().filter((w) => w.includes('/pickups/create-commands'))

describe('manifest i wyłączniki', () => {
  it('moduł nadawania deklaruje zamawianie kuriera dla przesyłek; podgląd allegro.wysylam.v1 nie', () => {
    const r = defaultRegistry()
    const m = r.get(ALLEGRO_WYSYLAM_ZAPIS_KEY)!.manifest
    expect(m.capabilities).toContain('shipment.pickup')
    expect(m.pickupPerShipment).toBe(true)
    expect(r.get('allegro.wysylam.v1')!.manifest.capabilities).not.toContain('shipment.pickup')
    expect(m.config.map((f) => f.key)).toEqual(expect.arrayContaining(['zamawianieKuriera', 'przewoznikOdbioru', 'nadawca']))
    expect(hasPickupOrderer(make(fakeNow()))).toBe(true)
    expect(hasPickupAvailability(make(fakeNow()))).toBe(true)
  })

  it('bez nadawania albo bez „Zamawianie kuriera z Kompletora”: odmowa bez żadnego żądania do Allegro', async () => {
    for (const c of [{ ...WLACZONE, zapisWlaczony: false }, { ...WLACZONE, zamawianieKuriera: false }, { zapisWlaczony: true, nadawca: WLACZONE.nadawca }]) {
      const f = fakeNow()
      expect(await make(f, c).zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('wyłączone') })
      await expect(make(f, c).dostepnoscOdbioru({ timeoutMs: 1000, przesylki: [P1] })).rejects.toThrow(/wyłączone/)
      expect(f.requests.filter((r) => r.includes('/shipment-management'))).toEqual([])
    }
  })

  it('bez przesyłek albo bez e-maila nadawcy: czytelna odmowa bez żądania', async () => {
    const f = fakeNow()
    expect(await make(f).zamowOdbior({ ...ZLEC, przesylki: [] }, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('brak przesyłek') })
    expect(await make(f).zamowOdbior({ ...ZLEC, przesylki: ['nie-uuid'] }, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('brak przesyłek') })
    const { email: _e, ...bez } = NADAWCA
    expect(await make(f, { ...WLACZONE, nadawca: JSON.stringify(bez) }).zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('e-mail') })
    expect(f.requests.filter((r) => r.includes('/shipment-management'))).toEqual([])
  })
})

describe('zamówienie odbioru', () => {
  it('termin Allegro pokrywający okno (12:00–16:00) zastępuje godziny; komenda z przesyłkami i adresem; odpytywanie do SUCCESS', async () => {
    const f = fakeNow()
    f.pendingPolls = 2
    const out = await make(f).zamowOdbior(ZLEC, REF)
    expect(out).toEqual({ kind: 'OK', reference: REF, externalRef: 'CP1', sumaKontrolna: '00000000-0000-4000-8000-000000000001', okno: { odMin: 12 * 60, doMin: 16 * 60 }, przesylek: 2 })
    expect(f.pickups).toHaveLength(1)
    expect(f.pickups[0]).toMatchObject({
      shipmentIds: [P1, P2],
      pickupTime: { date: '2026-11-23', minTime: '12:00', maxTime: '16:00' },
      address: { company: 'Firma Testowa', street: 'ul. Magazynowa 1', postalCode: '60-001', city: 'Poznań', countryCode: 'PL', email: 'magazyn@example.test', phone: '+48600100200' },
    })
    expect(f.pickupCommands.has(commandIdOdbioru(REF, 1))).toBe(true)
  })

  it('tylko przesyłki przewoźnika odbioru: paczka do paczkomatu (INPOST) zostaje poza zamówieniem', async () => {
    const f = fakeNow()
    const out = await make(f).zamowOdbior({ ...ZLEC, przesylki: [P1, P3, P2, P1] }, REF)
    expect(out).toMatchObject({ kind: 'OK', przesylek: 2 })
    expect(f.pickups[0]).toMatchObject({ shipmentIds: [P1, P2] })
  })

  it('żadna przesyłka przewoźnika odbioru: odmowa z przewoźnikami przesyłek, bez komendy; inny przewoźnik z ustawienia', async () => {
    const f = fakeNow()
    expect(await make(f).zamowOdbior({ ...ZLEC, przesylki: [P3] }, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/przewoźnika ALLEGRO.*INPOST ×1/) })
    expect(odbiory(f)).toEqual([])
    expect(await make(f, { ...WLACZONE, przewoznikOdbioru: 'INPOST' }).zamowOdbior({ ...ZLEC, przesylki: [P1, P3] }, REF)).toMatchObject({ kind: 'OK', przesylek: 1 })
    expect(f.pickups[0]).toMatchObject({ shipmentIds: [P3] })
  })

  it('powtórka tej samej referencji: bez drugiej komendy, ten sam odbiór', async () => {
    const f = fakeNow()
    const a = make(f)
    const r1 = await a.zamowOdbior(ZLEC, REF)
    const r2 = await a.zamowOdbior(ZLEC, REF)
    expect(r1).toMatchObject({ kind: 'OK', externalRef: 'CP1' })
    expect(r2).toMatchObject({ kind: 'OK', externalRef: 'CP1' })
    expect(odbiory(f)).toHaveLength(1)
    expect(f.pickups).toHaveLength(1)
  })

  it('terminy bez odpowiedzi albo z błędem: zamówienie i tak idzie z godzinami z okna (lista nie blokuje)', async () => {
    for (const awaria of ['NIEJEDNOZNACZNY_NIEWYKONANY', { status: 500 }, { status: 400 }] as const) {
      const f = fakeNow()
      f.writeFailures.push(awaria)
      expect(await make(f).zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'OK', externalRef: 'CP1' })
      expect(f.pickups[0]).toMatchObject({ pickupTime: { date: '2026-11-23', minTime: '13:00', maxTime: '15:00' } })
    }
  })

  it('dzień bez terminu Allegro: zamówienie z godzinami z okna; odmowa Allegro z podpowiedzią terminów', async () => {
    const f = fakeNow()
    f.domyslneTerminy = [{ date: '2026-11-26', minTime: '10:00', maxTime: '14:00' }]
    f.nextPickupOutcome.push('ERROR')
    const out = await make(f).zamowOdbior({ ...ZLEC, data: '2026-11-25' }, REF)
    expect(out).toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/odrzuciło zamówienie odbioru \(PICKUP_TIME_NOT_AVAILABLE\).*proponowane przez Allegro/) })
    expect(odbiory(f)).toHaveLength(1)
  })

  it('zgubiona odpowiedź komendy: wynik komendy rozstrzyga, jeden odbiór', async () => {
    const g = fakeNow()
    const orig = g.fetch
    let n = 0
    g.fetch = async (url, init) => {
      const r = await orig(url, init)
      if (String(url).endsWith('/pickups/create-commands') && ++n === 1) throw new TypeError('fetch failed')
      return r
    }
    expect(await make(g).zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'OK', externalRef: 'CP1' })
    expect(g.pickups).toHaveLength(1)
  })

  it('komenda bez wyniku po odpytywaniu: NIEJEDNOZNACZNY („sprawdź w Allegro”); powtórka nie wysyła drugiej komendy', async () => {
    const f = fakeNow()
    f.pendingPolls = 50
    const a = make(f)
    expect(await a.zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'NIEJEDNOZNACZNY', message: expect.stringContaining('sprawdź') })
    expect(await a.zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'NIEJEDNOZNACZNY' })
    expect(odbiory(f)).toHaveLength(1)
  })

  it('odmowa Allegro (komenda ERROR): czytelny powód z kodem; kolejna próba pod nowym commandId', async () => {
    const f = fakeNow()
    f.nextPickupOutcome.push('ERROR')
    const a = make(f)
    expect(await a.zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringMatching(/Allegro odrzuciło zamówienie odbioru.*PICKUP_TIME_NOT_AVAILABLE/) })
    expect(await a.zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'OK' })
    expect(f.pickupCommands.has(commandIdOdbioru(REF, 2))).toBe(true)
  })

  it(`po ${MAX_PROB_ODBIORU} odmowach tej referencji: odmowa bez kolejnej komendy`, async () => {
    const f = fakeNow()
    for (let i = 0; i < MAX_PROB_ODBIORU; i++) f.nextPickupOutcome.push('ERROR')
    const a = make(f)
    for (let i = 0; i < MAX_PROB_ODBIORU; i++) expect(await a.zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'TRWALY' })
    expect(await a.zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining(`${MAX_PROB_ODBIORU} prób`) })
    expect(odbiory(f)).toHaveLength(MAX_PROB_ODBIORU)
  })

  it('odmowa komendy (HTTP 400) i brak zakresu (403): TRWALY z powodem, zero odbiorów', async () => {
    const f = fakeNow()
    const orig = f.fetch
    f.fetch = async (url, init) => (String(url).endsWith('/pickups/create-commands') && init?.method === 'POST' ? new Response(JSON.stringify({ errors: [{ code: 'VALIDATION_ERROR' }] }), { status: 400, headers: { 'content-type': 'application/json' } }) : orig(url, init))
    expect(await make(f).zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('HTTP 400 (VALIDATION_ERROR)') })
    const g = fakeNow()
    g.scopes.delete(SHIPMENTS_WRITE)
    expect(await make(g).zamowOdbior(ZLEC, REF)).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('połącz konto') })
    expect([...f.pickups, ...g.pickups]).toEqual([])
  })
})

describe('terminy dla okna (dostępność)', () => {
  it('dni od dziś z przedziałami wspólnymi dla przesyłek', async () => {
    const f = fakeNow()
    expect(await make(f).dostepnoscOdbioru({ timeoutMs: 1000, przesylki: [P1, P2] })).toEqual({
      stan: 'OK',
      dni: [
        { dzienOd: 0, przedzialy: [{ odMin: 540, doMin: 720 }, { odMin: 720, doMin: 960 }] },
        { dzienOd: 1, przedzialy: [{ odMin: 540, doMin: 960 }] },
      ],
    })
    expect(odbiory(f)).toEqual([])
    expect(await make(f).dostepnoscOdbioru({ timeoutMs: 1000, przesylki: [] })).toEqual({ stan: 'BRAK' })
  })
})

describe('funkcje czyste', () => {
  const odp = (times: Record<string, { date: string; minTime?: string; maxTime?: string }[]>) => [{ proposals: Object.entries(times).map(([shipmentId, pickupTimes]) => ({ shipmentId, pickupTimes })) }]
  const T = (date: string, a: string, b: string) => ({ date, minTime: a, maxTime: b })

  it('terminy wspólne: część wspólna przesyłek z terminami; przesyłka bez terminów nie zawęża; obiekt zamiast tablicy też', () => {
    const r = odp({ [P1]: [T('2026-11-23', '08:00', '12:00'), T('2026-11-23', '12:00', '16:00')], [P2]: [T('2026-11-23', '12:00', '16:00')], [P3]: [] })
    expect(wspolneTerminyOdbioru(r, [P1, P2, P3])).toEqual([T('2026-11-23', '12:00', '16:00')])
    expect(wspolneTerminyOdbioru(r[0], [P1])).toEqual([T('2026-11-23', '08:00', '12:00'), T('2026-11-23', '12:00', '16:00')])
    expect(wspolneTerminyOdbioru([], [P1])).toEqual([])
    expect(wspolneTerminyOdbioru('śmieci', [P1])).toEqual([])
    expect(wspolneTerminyOdbioru(odp({ [P1]: [{ date: 'zła' }, T('2026-11-23', '16:00', '12:00')] }), [P1])).toEqual([{ date: '2026-11-23' }])
  })

  it('termin: najlepiej pokrywający okno; bez pokrycia godziny z okna i podpowiedź', () => {
    const w = [T('2026-11-23', '08:00', '12:00'), T('2026-11-23', '12:00', '16:00'), T('2026-11-24', '09:00', '16:00')]
    expect(terminOdbioru(w, '2026-11-23', 780, 900)).toEqual({ termin: T('2026-11-23', '12:00', '16:00'), zAllegro: true, podpowiedz: '2026-11-23 08:00–12:00, 2026-11-23 12:00–16:00, 2026-11-24 09:00–16:00' })
    expect(terminOdbioru(w, '2026-11-23', 1020, 1080)).toMatchObject({ termin: T('2026-11-23', '17:00', '18:00'), zAllegro: false })
    expect(terminOdbioru([], '2026-11-25', 780, 900)).toEqual({ termin: T('2026-11-25', '13:00', '15:00'), zAllegro: false, podpowiedz: null })
  })

  it('dni z terminów: przesunięcie od dziś, bez dni minionych i bez terminów bez godzin', () => {
    expect(dniZTerminow([T('2026-11-22', '09:00', '12:00'), { date: '2026-11-23' }, T('2026-11-24', '09:00', '12:00')], '2026-11-23')).toEqual([{ dzienOd: 1, przedzialy: [{ odMin: 540, doMin: 720 }] }])
  })

  it('adres odbioru z danych firmy: telefon z prefiksem, braki po nazwie pola', () => {
    expect(adresOdbioruAllegro(NADAWCA)).toEqual({ adres: { company: 'Firma Testowa', street: 'ul. Magazynowa 1', postalCode: '60-001', city: 'Poznań', countryCode: 'PL', email: 'magazyn@example.test', phone: '+48600100200' } })
    expect(adresOdbioruAllegro({ ...NADAWCA, city: '' })).toMatchObject({ blad: expect.stringContaining('miasto') })
  })
})

describe('osobne odbiory (REQUIRES_SEPARATE_PICKUPS)', () => {
  const P4 = '00000000-0000-4000-9000-000000000104'
  const fakeGrupy = () => {
    const f = fakeNow()
    f.wys.shipments.set(P4, { id: P4, carrier: 'ALLEGRO', canceledDate: null, packages: [{ waybill: 'A00104' }] })
    f.pickupGroup.set(P1, 'KURIER')
    f.pickupGroup.set(P2, 'KURIER')
    f.pickupGroup.set(P4, 'AUTOMAT')
    return f
  }

  it('podział po przewoźnikach transportu; elementy pickup-proposals dzielą tylko przesyłki bez transportu; ta sama lista = ten sam podział', () => {
    const odp = [{ proposals: [{ shipmentId: P4 }] }, { proposals: [{ shipmentId: P2 }, { shipmentId: P1 }] }]
    const bezTransportu = [P1, P2, P4].map((id) => ({ id, transport: null }))
    expect(grupujPrzesylkiOdbioru(bezTransportu, odp)).toEqual([
      { klucz: 'x.p1', przesylki: [P1, P2] },
      { klucz: 'x.p2', przesylki: [P4] },
    ])
    expect(grupujPrzesylkiOdbioru(bezTransportu, [...odp].reverse())).toEqual(grupujPrzesylkiOdbioru(bezTransportu, odp))
    // trzy przesyłki tego samego przewoźnika w trzech elementach (przewoźnik dał im jeden numer zlecenia) = jeden odbiór
    const ids = [P1, P2, P4].map((id) => ({ id, transport: 'ORLEN' }))
    const poJednej = [{ proposals: [{ shipmentId: P1 }] }, { proposals: [{ shipmentId: P2 }] }, { proposals: [{ shipmentId: P4 }] }]
    expect(grupujPrzesylkiOdbioru(ids, poJednej)).toEqual([{ klucz: 'ORLEN', przesylki: [P1, P2, P4] }])
    // mieszanka: znany transport bez tokenu, nieznany z tokenem elementu
    expect(grupujPrzesylkiOdbioru([{ id: P1, transport: 'ORLEN' }, { id: P2, transport: null }, { id: P4, transport: null }], odp).map((g) => [g.klucz, g.przesylki])).toEqual([
      ['ORLEN', [P1]],
      ['x.p1', [P2]],
      ['x.p2', [P4]],
    ])
    // jeden element: podział tylko po transporcie (przesyłki bez danych = `x`)
    expect(grupujPrzesylkiOdbioru([{ id: P1, transport: 'ALLEGRO' }, { id: P2, transport: 'ALLEGRO+DPD' }, { id: P4, transport: null }], [{ proposals: [{ shipmentId: P1 }, { shipmentId: P2 }, { shipmentId: P4 }] }]).map((g) => g.klucz)).toEqual(['ALLEGRO', 'ALLEGRO+DPD', 'x'])
    expect(grupujPrzesylkiOdbioru(ids, null)).toEqual([{ klucz: 'ORLEN', przesylki: [P1, P2, P4] }])
    // podział awaryjny po odmowie REQUIRES_SEPARATE_PICKUPS: elementy dzielą też przesyłki o znanym transporcie
    expect(grupujPrzesylkiOdbioru(ids, poJednej, { poElementach: true }).map((g) => [g.klucz, g.przesylki])).toEqual([
      ['ORLEN.p1', [P1]],
      ['ORLEN.p2', [P2]],
      ['ORLEN.p3', [P4]],
    ])
    // jeden element albo brak propozycji: bez podziału także awaryjnie
    expect(grupujPrzesylkiOdbioru(ids, [{ proposals: [{ shipmentId: P1 }, { shipmentId: P2 }, { shipmentId: P4 }] }], { poElementach: true })).toEqual([{ klucz: 'ORLEN', przesylki: [P1, P2, P4] }])
    expect(grupujPrzesylkiOdbioru(ids, null, { poElementach: true })).toEqual([{ klucz: 'ORLEN', przesylki: [P1, P2, P4] }])
    expect(przewoznicyTransportu({ transport: ['dpd', 'ALLEGRO'] })).toBe('ALLEGRO+DPD')
    expect(przewoznicyTransportu({ packages: [{ transportingInfo: [{ carrierId: 'INPOST' }] }] })).toBe('INPOST')
    expect(przewoznicyTransportu({ transport: ['zły znak!'] })).toBeNull()
  })

  it('grupyOdbioru: dwa odbiory z terminami per grupa, przesyłki innych przewoźników poza, bez żadnej komendy', async () => {
    const f = fakeGrupy()
    f.pickupTimes.set(P4, [{ date: '2026-11-23', minTime: '16:00', maxTime: '18:00' }])
    const a = make(f)
    expect(hasPickupGrouping(a)).toBe(true)
    const g = await a.grupyOdbioru({ przesylki: [P1, P2, P3, P4], wOdbiorze: [] })
    expect(g.powod).toBeNull()
    expect(g.grupy.map((x) => [x.klucz, x.przesylki])).toEqual([
      ['x.p1', [P1, P2]],
      ['x.p2', [P4]],
    ])
    expect(g.grupy[1]!.dni).toEqual([{ dzienOd: 0, przedzialy: [{ odMin: 16 * 60, doMin: 18 * 60 }] }])
    expect(g.grupy[0]!.opis).toContain('odbiór 1 z 2')
    expect(odbiory(f)).toEqual([])
  })

  it('grupyOdbioru: przesyłki odbioru już zamówionego wypadają z listy; błąd odczytu odbioru = wyjątek, nic nie zamówiono', async () => {
    const f = fakeGrupy()
    const a = make(f)
    const r = await a.zamowOdbior({ ...ZLEC, przesylki: [P1, P2] }, REF)
    expect(r).toMatchObject({ kind: 'OK' })
    const pickupId = (r as { sumaKontrolna?: string }).sumaKontrolna!
    const g = await a.grupyOdbioru({ przesylki: [P1, P2, P4], wOdbiorze: [{ id: pickupId, przesylek: 2 }] })
    expect(g.grupy.map((x) => x.przesylki)).toEqual([[P4]])
    expect(f.pickupReads).toEqual([pickupId])
    expect((await a.grupyOdbioru({ przesylki: [P1, P2], wOdbiorze: [{ id: pickupId, przesylek: 2 }] })).grupy).toEqual([])
    await expect(a.grupyOdbioru({ przesylki: [P4], wOdbiorze: [{ id: '00000000-0000-4000-8000-999999999999', przesylek: 1 }] })).rejects.toThrow(/nic nie zamówiono/)
    expect(odbiory(f)).toHaveLength(1)
  })

  it('komenda z przesyłkami wymagającymi osobnych odbiorów: czytelna odmowa po polsku, jedna komenda, bez ponawiania', async () => {
    const f = fakeGrupy()
    const r = await make(f).zamowOdbior({ ...ZLEC, przesylki: [P1, P2, P4] }, REF)
    expect(r).toMatchObject({ kind: 'TRWALY', message: expect.stringContaining('wymaga osobnych odbiorów') })
    expect((r as { message: string }).message).toContain(KOD_OSOBNE_ODBIORY)
    expect((r as { message: string }).message).toContain('Zamów odbiór tych przesyłek w Allegro')
    // skład dla administratora: liczby i identyfikatory usług, bez numerów przesyłek, listów, adresu i nazw
    const m = (r as { message: string }).message
    expect(m).toContain(`${SKLAD} propozycje: `)
    expect(m).toContain('przewoźnik: ALLEGRO×3')
    for (const zakazane of [P1, P2, P4, 'A00104', NADAWCA.address, NADAWCA.name, NADAWCA.phone, NADAWCA.email]) expect(m).not.toContain(zakazane)
    expect(odbiory(f)).toHaveLength(1)
  })

  it('skladOdbioru: elementy propozycji z liczbą przesyłek i terminów, transport i przewoźnik z licznikami, znaczniki spoza wzorca = inny', () => {
    const propozycje = [
      { proposals: [{ shipmentId: P1, pickupTimes: [{ date: '2026-11-24' }] }, { shipmentId: P2, pickupTimes: [] }], address: { street: 'ul. Magazynowa 1' } },
      { proposals: [{ shipmentId: P3 }] },
    ]
    const transport = new Map<string, string | null>([[P1, 'ALLEGRO_COURIER'], [P2, 'ALLEGRO_COURIER'], [P3, null], [P4, 'Jan Kowalski']])
    const s = skladOdbioru({ propozycje, stanPropozycji: 200, transport, przewoznik: 'ALLEGRO', przesylek: 4, inni: new Map([['INPOST', 2], ['ul. Polna 5', 1], ['anulowana', 1]]) })
    expect(s).toBe('propozycje: 2 grupy (przesyłek 2, 1; z terminami 1, 0); transport: ALLEGRO_COURIER×2, brak×1, inny×1; przewoźnik: ALLEGRO×4, INPOST×2, anulowana×1, inny×1')
    for (const zakazane of [P1, P2, P3, 'Magazynowa', 'Kowalski', 'Polna']) expect(s).not.toContain(zakazane)
    expect(skladOdbioru({ propozycje: [], stanPropozycji: 200, transport: new Map(), przewoznik: 'ALLEGRO', przesylek: 0, inni: new Map() })).toBe('propozycje: 0 grup')
    expect(skladOdbioru({ propozycje: null, stanPropozycji: null, transport: new Map([[P1, 'DPD']]), przewoznik: 'ALLEGRO', przesylek: 1, inni: new Map() })).toBe('propozycje: brak odpowiedzi; transport: DPD×1; przewoźnik: ALLEGRO×1')
    expect(skladOdbioru({ propozycje: { proposals: [] }, stanPropozycji: 422, transport: new Map(), przewoznik: 'ALLEGRO', przesylek: 0, inni: new Map() })).toBe('propozycje: HTTP 422')
  })
})
