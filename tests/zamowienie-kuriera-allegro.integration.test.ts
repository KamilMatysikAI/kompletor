// Zamówienie kuriera Wysyłam z Allegro z kolejki pakowania (lib/wysylka/zamowienie-kuriera.ts) na bazie testowej
// i atrapie zapisu Allegro (tests/allegro-zapis-atrapa.ts): włącznik na karcie „Wysyłam z Allegro”, odbiór konkretnych
// przesyłek z numerem nadania (bez liczby i wagi z okna), jedno zamówienie na dzień i konto, odmowa Allegro, wynik
// niepewny bez ponawiania, świadome drugie zamówienie tylko dla nowych przesyłek, kilka kont Allegro = odmowa.
// Dane fikcyjne, zero połączeń z prawdziwym Allegro.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import { writeAccountSecrets } from '@/lib/adaptery/rotacja-sekretow'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { setSecret } from '@/lib/sekrety'
import { kontaPrzewoznikow } from '@/lib/wysylka/konta'
import { liniePaskaKuriera, nieudaneOdbioryDnia } from '@/lib/wysylka/kurier-widok'
import { podsumowanieOdbiorow } from '@/lib/wysylka/kurier-podsumowanie'
import { ALERT_KURIERA, LIMIT_ODBIOROW_MS, POWOD_BEZ_PRZESYLEK, POWOD_NIE_WYSLANO, POWOD_STARE_PRZESYLKI, stanZamawianiaKuriera, zamowKuriera, type DepsKuriera, type ZamowienieKuriera } from '@/lib/wysylka/zamowienie-kuriera'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { API, AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, UA } from './allegro-zapis-atrapa'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { NADAWCA_TESTOWY } from './dpd-atrapa'
import { order, product, seedBase } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await sys.$disconnect()
})

// poniedziałek 23.11.2026 09:00 w Warszawie
const NOW = new Date('2026-11-23T08:00:00.000Z')
const ENV = { APP_ENCRYPTION_KEY: '0'.repeat(64), EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64) }
const SCOPE = { channel: 'ALLEGRO' as const, channelAccountId: 'allegro' }
const KEY = 'allegro.wysylam.zapis.v1'
const P = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`

let fake: FakeAllegroZapis
let teraz = NOW
const deps = (): DepsKuriera => ({ fetch: fake.fetch, env: ENV, secrets: { env: ENV, envFallback: false }, now: () => teraz, http: { pollDelayMs: 0, minIntervalMs: 0 } })
// okno: 13:00–15:00 dziś; liczba i waga z formularza Allegro pomija (pola nie istnieją w oknie)
const ZLECENIE: ZamowienieKuriera = { carrier: 'ALLEGRO', data: '2026-11-23', odMin: 13 * 60, doMin: 15 * 60, liczba: 0, wagaKg: 0, userId: 'u-test', userName: 'Magazyn Test' }
const zamow = (z: Partial<ZamowienieKuriera> = {}) => zamowKuriera(db, { ...ZLECENIE, ...z }, deps())
const komendy = () => fake.writes().filter((w) => w.includes('/pickups/create-commands') && w.startsWith('POST'))

async function firma(o: { wlacznik?: boolean; zapisWlaczony?: boolean } = {}) {
  await db.carrierRule.updateMany({ where: { carrier: 'ALLEGRO' }, data: { shippingModule: 'WYSYLAM_Z_ALLEGRO', adapterKey: KEY, config: { zapisWlaczony: o.zapisWlaczony ?? true } } })
  const ustawienia = o.wlacznik === false ? {} : { allegro: { zamawianieKuriera: true } }
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_TESTOWY, przewoznicy: { ustawienia } } } })
}

let nr = 0
/** Spakowane zamówienie Allegro z przesyłką Wysyłam z Allegro (numer nadania = id przesyłki w Allegro). */
async function przesylka(id: string, o: { carrier?: string; konto?: string; utworzona?: Date } = {}) {
  const pid = await product(db, `HERB-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const form = `29a8e3c0-7f1b-11ef-9d6f-${String(nr).padStart(12, '0')}`
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: 'ALLEGRO', externalId: form, paymentState: 'PAID', paymentMethod: 'ONLINE' }), { now: NOW })
  await db.order.update({ where: { id: r.orderId! }, data: { status: 'SPAKOWANE', ...(o.konto ? { channelAccountId: o.konto } : {}) } })
  await db.shipment.create({ data: { orderId: r.orderId!, packageNo: 1, reference: `ref-${r.orderId}`, state: 'UTWORZONA', adapterKey: KEY, carrier: 'ALLEGRO', weightKg: 1.5, externalRef: id, createdAt: o.utworzona ?? new Date(Date.now() - 1000) } })
  fake.wys.shipments.set(id, { id, carrier: o.carrier ?? 'ALLEGRO', canceledDate: null, packages: [{ waybill: `A00${id.slice(-3)}` }] })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  teraz = NOW
  fake = new FakeAllegroZapis()
  fake.base.clock = () => NOW.getTime()
  await db.channelConfig.updateMany({ where: SCOPE, data: { statusMode: 'PRACA', config: { apiUrl: API, authUrl: AUTH, userAgent: UA } } })
  await setSecret(db, S.clientId, FAKE_CLIENT_ID, ENV, SCOPE)
  await setSecret(db, S.clientSecret, FAKE_CLIENT_SECRET, ENV, SCOPE)
  const pair = fake.base.issuePair()
  await writeAccountSecrets(db, SCOPE, { [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: new Date(NOW.getTime() + 10 * 3600_000).toISOString() }, ENV)
})

describe('włącznik „Zamawianie kuriera z Kompletora” na karcie Wysyłam z Allegro', () => {
  it('karta pokazuje pole włącznika; wyłączony (domyślnie) = brak przycisku, odmowa bez żądania i bez wiersza', async () => {
    await firma({ wlacznik: false })
    await przesylka(P(1))
    const karta = (await kontaPrzewoznikow(db, defaultRegistry(), undefined, { zWysylamZAllegro: true })).find((k) => k.id === 'allegro')
    expect(karta?.pola.map((p) => p.key)).toEqual(['zamawianieKuriera', 'przewoznikOdbioru'])
    expect(karta?.pola[0]).toMatchObject({ wartosc: '' })
    expect((await stanZamawianiaKuriera(db, deps())).size).toBe(0)
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('wyłączone') })
    expect(fake.writes()).toEqual([])
    expect(await db.courierPickupOrder.count()).toBe(0)
  })

  it('nadawanie wyłączone: przycisk z powodem, zamówienie bez żądania', async () => {
    await firma({ zapisWlaczony: false })
    await przesylka(P(1))
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')).toMatchObject({ powod: expect.stringContaining('Nadawanie'), poPrzesylkach: true })
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA' })
    expect(fake.writes()).toEqual([])
  })
})

describe('zamówienie odbioru Wysyłam z Allegro', () => {
  it('stan: po przesyłkach, liczba przesyłek z numerem nadania (bez zamówień spoza kolejki)', async () => {
    await firma()
    await przesylka(P(1))
    await przesylka(P(2))
    const k = (await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')
    expect(k).toMatchObject({ powod: null, poPrzesylkach: true, paczki: { liczba: 2 } })
  })

  it('zamawia odbiór przesyłek przewoźnika (paczka innego przewoźnika poza zamówieniem), zapisuje faktyczne okno i liczbę; drugie kliknięcie bez drugiej komendy', async () => {
    await firma()
    await przesylka(P(1))
    await przesylka(P(2))
    await przesylka(P(3), { carrier: 'INPOST' })
    const w = await zamow()
    expect(w).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
    expect(komendy()).toHaveLength(1)
    expect(fake.pickups[0]).toMatchObject({ shipmentIds: [P(1), P(2)], pickupTime: { date: '2026-11-23', minTime: '12:00', maxTime: '16:00' } })
    expect((fake.pickups[0] as { address: Record<string, unknown> }).address).toMatchObject({ city: NADAWCA_TESTOWY.city, email: NADAWCA_TESTOWY.email })
    const row = await db.courierPickupOrder.findFirstOrThrow()
    expect(row).toMatchObject({ state: 'ZAMOWIONY', accountKey: 'allegro#odbior:x', parcels: 2, fromMinute: 12 * 60, toMinute: 16 * 60, externalRef: 'CP1' })

    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true })
    expect(komendy()).toHaveLength(1)
    // po zamówieniu przesyłki są już w odbiorze: ekran nie liczy ich drugi raz
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')).toMatchObject({ paczki: { liczba: 0 } })
  })

  it('bez przesyłek z numerem nadania: odmowa bez żądania i bez wiersza', async () => {
    await firma()
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: POWOD_BEZ_PRZESYLEK })
    expect(fake.writes()).toEqual([])
    expect(await db.courierPickupOrder.count()).toBe(0)
  })

  it('odmowa Allegro (komenda ERROR): BLAD z powodem, nic nie zamówione; kolejne kliknięcie ten sam wiersz, nowa komenda', async () => {
    await firma()
    await przesylka(P(1))
    fake.nextPickupOutcome.push('ERROR')
    expect(await zamow()).toMatchObject({ wynik: 'BLAD', powod: expect.stringContaining('odrzuciło zamówienie odbioru') })
    expect(fake.pickups).toHaveLength(0)
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY' })
    expect(komendy()).toHaveLength(2)
    expect(await db.courierPickupOrder.count()).toBe(1)
  })

  it('wynik niepewny (komenda bez wyniku): NIEJEDNOZNACZNY z alertem „sprawdź w Allegro”, kolejne kliknięcie bez żądania', async () => {
    await firma()
    await przesylka(P(1))
    fake.pendingPolls = 1000
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY' })
    expect(await db.alert.count({ where: { kind: ALERT_KURIERA } })).toBe(1)
    const przed = fake.writes().length
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(fake.writes().length).toBe(przed)
  })

  it('świadome drugie zamówienie obejmuje tylko przesyłki utworzone po pierwszym; bez nowych = odmowa bez żądania', async () => {
    await firma()
    await przesylka(P(1), { utworzona: new Date(NOW.getTime() - 3600_000) })
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY' })
    expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ODMOWA', powod: POWOD_BEZ_PRZESYLEK })
    expect(komendy()).toHaveLength(1)
    await przesylka(P(2), { utworzona: new Date() })
    expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
    expect(fake.pickups[1]).toMatchObject({ shipmentIds: [P(2)] })
    expect(await db.courierPickupOrder.count()).toBe(2)
  })

  describe('odczyt przyjętego odbioru w Allegro niepewny: „Zamów drugi raz” nie obejmuje przesyłek z odbioru', () => {
    /** Odbiór z P(1), P(2) przyjęty; potem nowa przesyłka P(3) i odpowiedź GET odbioru z podmienioną listą przesyłek. */
    async function poOdbiorze(lista: string[]) {
      await firma()
      await przesylka(P(1), { utworzona: new Date(NOW.getTime() - 3600_000) })
      await przesylka(P(2), { utworzona: new Date(NOW.getTime() - 3600_000) })
      expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY' })
      await przesylka(P(3), { utworzona: new Date() })
      const f0 = fake.fetch
      fake.fetch = async (url, init) =>
        /\/shipment-management\/pickups\/[0-9a-f-]{36}$/.test(url) && (init?.method ?? 'GET') === 'GET' ? new Response(JSON.stringify({ id: 'x', shipmentIds: lista }), { status: 200, headers: { 'Content-Type': 'application/json' } }) : f0(url, init)
    }

    it('pusta lista przesyłek odbioru: odmowa, zero komend', async () => {
      await poOdbiorze([])
      expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('0 z 2 przesyłek') })
      expect(komendy()).toHaveLength(1)
    })

    it('mniej przesyłek niż zamówiono: odmowa, zero komend', async () => {
      await poOdbiorze([P(1)])
      expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('1 z 2 przesyłek') })
      expect(komendy()).toHaveLength(1)
    })

    it('lista bez jednej z przesyłek odbioru (ta sama liczba): drugi odbiór tylko nowej przesyłki', async () => {
      await poOdbiorze([P(1), P(9)])
      expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
      expect(fake.pickups[1]).toMatchObject({ shipmentIds: [P(3)] })
    })

    it('odbiór anulowany w Allegro (404): odmowa z odesłaniem do Allegro, zero komend', async () => {
      await firma()
      await przesylka(P(1), { utworzona: new Date(NOW.getTime() - 3600_000) })
      expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY' })
      await przesylka(P(3), { utworzona: new Date() })
      const f0 = fake.fetch
      fake.fetch = async (url, init) => (/\/shipment-management\/pickups\/[0-9a-f-]{36}$/.test(url) ? new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404, headers: { 'Content-Type': 'application/json' } }) : f0(url, init))
      expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('anulowany w Allegro') })
      expect(komendy()).toHaveLength(1)
    })
  })

  it('niewiadoma na dziś: zamówienie na jutro (także „drugi”) zwraca niewiadomą, bez nowej komendy', async () => {
    await firma()
    await przesylka(P(1))
    fake.pendingPolls = 1000
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY' })
    const przed = komendy().length
    expect(await zamow({ data: '2026-11-24' })).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(await zamow({ data: '2026-11-24', drugi: true })).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(komendy().length).toBe(przed)
    expect(await db.courierPickupOrder.count()).toBe(1)
  })

  it('równoległe kliknięcia na różne dni: jedna komenda odbioru', async () => {
    await firma()
    await przesylka(P(1))
    const w = await Promise.all([zamow(), zamow({ data: '2026-11-24' })])
    expect(w.filter((x) => x.wynik === 'ZAMOWIONY' && !x.istnialo)).toHaveLength(1)
    expect(komendy()).toHaveLength(1)
    expect(await db.courierPickupOrder.count()).toBe(1)
  })

  it('odmowa, nowe przesyłki, udane zamówienie: nic nie czeka (granica = chwila listy, nie pierwsza próba)', async () => {
    await firma()
    await przesylka(P(1), { utworzona: new Date(Date.now() - 60_000) })
    fake.nextPickupOutcome.push('ERROR')
    expect(await zamow()).toMatchObject({ wynik: 'BLAD' })
    await przesylka(P(2), { utworzona: new Date() })
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY' })
    expect(fake.pickups[0]).toMatchObject({ shipmentIds: [P(1), P(2)] })
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')).toMatchObject({ paczki: { liczba: 0 } })
  })

  it('reguła Wysyłam z Allegro dla Paczkomatów: bez przycisku przy pasku Paczkomatów', async () => {
    await firma()
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'WYSYLAM_Z_ALLEGRO', adapterKey: KEY, config: { zapisWlaczony: true } } })
    const stan = await stanZamawianiaKuriera(db, deps())
    expect(stan.has('PACZKOMATY')).toBe(false)
    expect(stan.has('ALLEGRO')).toBe(true)
    expect(await zamow({ carrier: 'PACZKOMATY' })).toMatchObject({ wynik: 'ODMOWA' })
    expect(fake.writes()).toEqual([])
  })

  it('przesyłki na dwóch kontach Allegro: odmowa z powodem, zero żądań', async () => {
    await firma()
    await przesylka(P(1))
    await przesylka(P(2), { konto: 'allegro-drugie' })
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')).toMatchObject({ powod: expect.stringContaining('kilku kontach Allegro') })
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('kilku kontach Allegro') })
    expect(fake.writes()).toEqual([])
  })
})

describe('osobne odbiory: Allegro nie łączy części przesyłek (REQUIRES_SEPARATE_PICKUPS)', () => {
  const KONTO = 'allegro'
  /** P(1), P(2) w grupie kuriera, P(3) w grupie automatów (propozycje Allegro zwracają je osobnymi elementami). */
  async function dwieGrupy() {
    await firma()
    for (const [n, g] of [
      [1, 'KURIER'],
      [2, 'KURIER'],
      [3, 'AUTOMAT'],
    ] as const) {
      await przesylka(P(n))
      fake.pickupGroup.set(P(n), g)
    }
  }
  const wiersze = () => db.courierPickupOrder.findMany({ orderBy: [{ accountKey: 'asc' }, { attempt: 'asc' }] })
  const objete = () => komendy().length
  const przesylkiKomend = () => [...fake.pickupCommands.values()].map((c) => (c.input['shipmentIds'] as string[]).join(','))

  it('dwie grupy: dwa odbiory, każdy z własnym zleceniem i wynikiem; ponowne kliknięcie nie zamawia żadnej drugi raz', async () => {
    await dwieGrupy()
    const w = await zamow()
    expect(w.wynik).toBe('ODBIORY')
    if (w.wynik !== 'ODBIORY') throw new Error('zły wynik')
    expect(w.odbiory.map((o) => [o.przesylek, o.wynik.wynik])).toEqual([
      [2, 'ZAMOWIONY'],
      [1, 'ZAMOWIONY'],
    ])
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(3)])
    const z = await wiersze()
    expect(z.map((x) => [x.accountKey, x.state, x.parcels])).toEqual([
      [`${KONTO}#odbior:x.p1`, 'ZAMOWIONY', 2],
      [`${KONTO}#odbior:x.p2`, 'ZAMOWIONY', 1],
    ])
    expect(new Set(z.map((x) => x.reference)).size).toBe(2)
    // pasek: oba odbiory przyjęte w jednym kliknięciu = nic już nie czeka
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')?.paczki.liczba).toBe(0)
    const drugi = await zamow()
    expect(drugi).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true })
    expect(objete()).toBe(2)
    expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ODMOWA', powod: POWOD_BEZ_PRZESYLEK })
    expect(objete()).toBe(2)
    expect(fake.pickupReads.length).toBeGreaterThan(0)
  })

  it('jedna grupa przyjęta, druga odrzucona: widać obie linie; kolejne kliknięcie zamawia tylko odrzuconą (pewna odmowa nie blokuje)', async () => {
    await dwieGrupy()
    fake.nextPickupOutcome = ['SUCCESS', 'ERROR']
    const w = await zamow()
    if (w.wynik !== 'ODBIORY') throw new Error('zły wynik')
    expect(w.odbiory.map((o) => o.wynik.wynik)).toEqual(['ZAMOWIONY', 'BLAD'])
    // jedno podsumowanie, okno się zamyka (ok), ton informacyjny, rada „Ponów nieudany odbiór”
    const p = podsumowanieOdbiorow(w.odbiory, 'Allegro', '2026-11-23')
    expect(p).toMatchObject({ ok: true, ton: 'info' })
    expect(p.komunikat).toMatch(/^Kurier Allegro zamówiony: .*\(2 przesyłki, zlecenie nr CP\d+\)\. Nie udało się: .*\(1 przesyłka\)/)
    // powód bez własnej instrukcji (atrapa: odmowa bez kodu) = ogólna rada „Ponów nieudany odbiór”
    expect(p.komunikat).toContain('Ponów nieudany odbiór')
    expect(p.komunikat).not.toContain('PICKUP_TIME_NOT_AVAILABLE')
    // przy odmowie wiersz ma termin, który poszedł do Allegro, nie okno z formularza
    const wyslany = [...fake.pickupCommands.values()].find((c) => c.outcome === 'ERROR')!.input['pickupTime'] as { minTime?: string; maxTime?: string }
    const minuty = (g: string) => Number(g.slice(0, 2)) * 60 + Number(g.slice(3, 5))
    const odrzucony = (await wiersze()).find((x) => x.state === 'BLAD')!
    expect(wyslany).toMatchObject({ minTime: '12:00', maxTime: '16:00' })
    expect([minuty(wyslany.minTime!), minuty(wyslany.maxTime!)]).not.toEqual([ZLECENIE.odMin, ZLECENIE.doMin])
    expect([odrzucony.fromMinute, odrzucony.toMinute]).toEqual([minuty(wyslany.minTime!), minuty(wyslany.maxTime!)])
    const stan = (await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')!
    expect(stan.zlecenia.map((x) => x.stan).sort()).toEqual(['BLAD', 'ZAMOWIONY'])
    expect(nieudaneOdbioryDnia(liniePaskaKuriera(stan.zlecenia, '2026-11-23'), '2026-11-23').map((x) => x.paczki)).toEqual([1])
    // pod paskiem: odmowa grupy osobną linią obok przyjętego odbioru (nie zwinięta pod nim)
    expect(liniePaskaKuriera(stan.zlecenia, '2026-11-23').map((l) => [l.glowna.stan, l.glowna.paczki])).toEqual([
      ['ZAMOWIONY', 2],
      ['BLAD', 1],
    ])
    // kliknięcie z odmową części grup nie zmniejsza liczby na pasku (bez sieci nie wiadomo, które przesyłki są w odbiorze)
    expect(stan.paczki.liczba).toBe(3)
    const ponownie = await zamow()
    expect(ponownie).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(3), P(3)])
    // podział zależy od listy: reszta to jedna grupa z nowym kluczem, która przejmuje wiersz odmowy pod jego kluczem
    // (drobne 4: ta sama przesyłka nie ma dwóch wierszy), z chwilą pierwszego kliknięcia (bez przesuwania granicy dnia)
    const z = await wiersze()
    expect(z.map((x) => [x.accountKey, x.state])).toEqual([
      [`${KONTO}#odbior:x.p1`, 'ZAMOWIONY'],
      [`${KONTO}#odbior:x.p2`, 'ZAMOWIONY'],
    ])
    expect(z[0]!.createdAt.getTime()).toBe(z[1]!.createdAt.getTime())
    expect(new Set(z.map((x) => x.reference)).size).toBe(2)
    // po udanym ponowieniu: dwie linie przyjętych odbiorów, nic do ponowienia
    const poPonowieniu = liniePaskaKuriera((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')!.zlecenia, '2026-11-23')
    expect(poPonowieniu.map((l) => [l.glowna.stan, l.pozostale.map((x) => x.stan)])).toEqual([
      ['ZAMOWIONY', []],
      ['ZAMOWIONY', []],
    ])
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')?.paczki.liczba).toBe(0)
    expect(nieudaneOdbioryDnia(poPonowieniu, '2026-11-23')).toEqual([])
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true })
    expect(objete()).toBe(3)
  })


  it('przesyłka nadana między odmową części a udanym ponowieniem dalej czeka na pasku i daje się zamówić „Zamów drugi raz”', async () => {
    await dwieGrupy()
    fake.nextPickupOutcome = ['SUCCESS', 'ERROR']
    const w = await zamow()
    if (w.wynik !== 'ODBIORY') throw new Error('zły wynik')
    expect(w.odbiory.map((o) => o.wynik.wynik)).toEqual(['ZAMOWIONY', 'BLAD'])
    // nowa przesyłka po pierwszym kliknięciu
    await przesylka(P(4), { utworzona: new Date() })
    // ponowienie (bez „drugi”): tylko odrzucona przesyłka z listy pierwszego kliknięcia
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(3), P(3)])
    // pasek: odbiory pierwszego kliknięcia przyjęte w całości, czeka tylko nowa przesyłka
    const stan = (await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')!
    expect(stan.paczki.liczba).toBe(1)
    expect(nieudaneOdbioryDnia(liniePaskaKuriera(stan.zlecenia, '2026-11-23'), '2026-11-23')).toEqual([])
    // bez „drugi”: zwrot istniejącego, bez komendy; „Zamów drugi raz” zamawia nową przesyłkę
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true })
    expect(objete()).toBe(3)
    expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(3), P(3), P(4)])
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')?.paczki.liczba).toBe(0)
  })

  it('nieudane ponowienie i ponowienie jeszcze raz: jeden wiersz odmowy tej przesyłki, nowa przesyłka nie wchodzi bez „drugi”', async () => {
    await dwieGrupy()
    fake.nextPickupOutcome = ['SUCCESS', 'ERROR', 'ERROR']
    await zamow()
    await przesylka(P(4), { utworzona: new Date() })
    expect(await zamow()).toMatchObject({ wynik: 'BLAD' })
    const z = await wiersze()
    expect(z.filter((x) => x.state === 'BLAD').map((x) => x.parcels)).toEqual([1])
    const stan = (await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')!
    expect(nieudaneOdbioryDnia(liniePaskaKuriera(stan.zlecenia, '2026-11-23'), '2026-11-23').map((x) => x.paczki)).toEqual([1])
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(3), P(3), P(3)])
  })

  it('„Zamów drugi raz” obok nieudanego odbioru zamawia nieudaną przesyłkę i nowe, przyjętego odbioru nie powtarza', async () => {
    await dwieGrupy()
    fake.nextPickupOutcome = ['SUCCESS', 'ERROR']
    await zamow()
    await przesylka(P(4), { utworzona: new Date() })
    const w = await zamow({ drugi: true })
    if (w.wynik !== 'ODBIORY') throw new Error(`zły wynik ${w.wynik}`)
    expect(w.odbiory.map((o) => o.wynik.wynik)).toEqual(['ZAMOWIONY', 'ZAMOWIONY'])
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(3), P(3), P(4)])
    expect((await wiersze()).filter((x) => x.state === 'BLAD')).toEqual([])
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')?.paczki.liczba).toBe(0)
  })

  for (const drugi of [true, false])
    it(`odmowa jednej grupy, a odczyt przyjętego odbioru zwraca właściwą liczbę obcych identyfikatorów${drugi ? ' + „Zamów drugi raz”' : ''}: odmowa, zero komend`, async () => {
      await dwieGrupy()
      fake.nextPickupOutcome = ['SUCCESS', 'ERROR']
      const w = await zamow()
      if (w.wynik !== 'ODBIORY') throw new Error('zły wynik')
      expect(w.odbiory.map((o) => o.wynik.wynik)).toEqual(['ZAMOWIONY', 'BLAD'])
      const f0 = fake.fetch
      let odczyty = 0
      fake.fetch = async (url, init) =>
        /\/shipment-management\/pickups\/[0-9a-f-]{36}$/.test(url) && (init?.method ?? 'GET') === 'GET' && ++odczyty
          ? new Response(JSON.stringify({ id: 'x', shipmentIds: [P(8), P(9)] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : f0(url, init)
      expect(await zamow(drugi ? { drugi: true } : {})).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining(POWOD_STARE_PRZESYLKI) })
      expect(objete()).toBe(2)
      expect(odczyty).toBeGreaterThan(0)
      // odmowa przed rezerwacją: wiersze bez zmian (odrzucona grupa dalej czeka na ponowienie)
      expect((await wiersze()).map((x) => x.state)).toEqual(['ZAMOWIONY', 'BLAD'])
    })

  it('niewiadoma w jednej grupie: druga rozstrzygnięta, ponowne kliknięcie nie zamawia grupy z niewiadomą', async () => {
    await dwieGrupy()
    let n = 0
    const f0 = fake.fetch
    fake.fetch = async (url, init) => {
      // druga komenda odbioru: brak odpowiedzi i Allegro jej nie zna (wynik nieznany)
      if (url.includes('/pickups/create-commands') && init?.method === 'POST' && ++n === 2) throw new TypeError('fetch failed')
      return f0(url, init)
    }
    const w = await zamow()
    if (w.wynik !== 'ODBIORY') throw new Error('zły wynik')
    expect(w.odbiory.map((o) => o.wynik.wynik)).toEqual(['ZAMOWIONY', 'NIEJEDNOZNACZNY'])
    expect(await db.alert.count({ where: { kind: ALERT_KURIERA } })).toBe(1)
    fake.fetch = f0
    const p = await zamow()
    expect(p).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`])
  })

  it('równoległe kliknięcia: jedna komenda na grupę', async () => {
    await dwieGrupy()
    fake.pendingPolls = 2
    const w = await Promise.all([zamow(), zamow(), zamow()])
    expect(w.filter((x) => x.wynik === 'ODBIORY')).toHaveLength(1)
    expect(objete()).toBe(2)
    expect(new Set(przesylkiKomend())).toEqual(new Set([`${P(1)},${P(2)}`, P(3)]))
  })

  it('równoległe kliknięcia: drugie odczytało listę przed rezerwacją pierwszego i skończyło podział po jego komendach = zwrot istniejącego, bez komendy', async () => {
    await dwieGrupy()
    const f0 = fake.fetch
    let n = 0
    let doszedlDrugi!: () => void
    let puscDrugi!: () => void
    const drugiDoszedl = new Promise<void>((r) => (doszedlDrugi = r))
    const drugiPuszczony = new Promise<void>((r) => (puscDrugi = r))
    fake.fetch = async (url, init) => {
      if (url.includes('/pickup-proposals')) {
        const k = ++n
        // pierwsze kliknięcie czeka z podziałem, aż drugie odczyta listę; drugie czeka, aż pierwsze wyśle komendy
        if (k === 1) await drugiDoszedl
        if (k === 2) {
          doszedlDrugi()
          await drugiPuszczony
        }
      }
      return f0(url, init)
    }
    // które kliknięcie dojdzie pierwsze do podziału, nie wiadomo: puszczamy drugie, gdy którekolwiek skończy
    const p = [zamow(), zamow()]
    const pierwszy = await Promise.race(p)
    expect(pierwszy).toMatchObject({ wynik: 'ODBIORY' })
    expect(objete()).toBe(2)
    puscDrugi()
    const oba = await Promise.all(p)
    expect(oba.filter((w) => w.wynik === 'ODBIORY')).toHaveLength(1)
    expect(oba.find((w) => w.wynik !== 'ODBIORY')).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true })
    expect(objete()).toBe(2)
    expect(await db.courierPickupOrder.count()).toBe(2)
  })

  it('limit czasu kliknięcia minął po pierwszej grupie: druga bez komendy, pewna odmowa „zamów ponownie”; ponowienie zamawia tylko ją', async () => {
    await dwieGrupy()
    const f0 = fake.fetch
    fake.fetch = async (url, init) => {
      if (url.includes('/pickups/create-commands') && init?.method === 'POST') teraz = new Date(NOW.getTime() + LIMIT_ODBIOROW_MS + 60_000)
      return f0(url, init)
    }
    const w = await zamow()
    if (w.wynik !== 'ODBIORY') throw new Error('zły wynik')
    expect(w.odbiory.map((o) => o.wynik.wynik)).toEqual(['ZAMOWIONY', 'BLAD'])
    expect(w.odbiory[1]!.wynik).toMatchObject({ powod: POWOD_NIE_WYSLANO })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`])
    fake.fetch = f0
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(3)])
  })

  it('wiersz dalszej grupy zmieniony w trakcie (np. uznany za przerwany): jego komenda nie wychodzi', async () => {
    await dwieGrupy()
    const f0 = fake.fetch
    fake.fetch = async (url, init) => {
      if (url.includes('/pickups/create-commands') && init?.method === 'POST')
        await db.courierPickupOrder.updateMany({ where: { accountKey: `${KONTO}#odbior:x.p2`, state: 'TWORZENIE' }, data: { state: 'NIEJEDNOZNACZNY', lastError: 'zamawianie przerwane w trakcie', failureKind: 'NIEJEDNOZNACZNY' } })
      return f0(url, init)
    }
    const w = await zamow()
    if (w.wynik !== 'ODBIORY') throw new Error('zły wynik')
    expect(w.odbiory.map((o) => o.wynik)).toMatchObject([{ wynik: 'ZAMOWIONY' }, { wynik: 'NIEJEDNOZNACZNY', istnialo: true }])
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`])
  })

  it('odmowa sprzed podziału (wiersz konta bez grupy, BLAD) nie blokuje zamówienia po poprawce', async () => {
    await dwieGrupy()
    await db.courierPickupOrder.create({ data: { carrier: 'ALLEGRO', adapterKey: KEY, accountKey: KONTO, pickupDay: '2026-11-23', attempt: 1, reference: 'ref-stara-odmowa', state: 'BLAD', fromMinute: 900, toMinute: 1020, parcels: 3, weightKg: 0, requestedBy: 'u-test', requestedName: 'Magazyn Test', lastError: 'Allegro odrzuciło zamówienie odbioru (REQUIRES_SEPARATE_PICKUPS)', failureKind: 'TRWALY' } })
    expect(await zamow()).toMatchObject({ wynik: 'ODBIORY' })
    expect(objete()).toBe(2)
  })

  it('bez propozycji terminów (błąd Allegro) przesyłki zostają razem; odmowa REQUIRES_SEPARATE_PICKUPS po polsku, bez ponawiania', async () => {
    await dwieGrupy()
    const f0 = fake.fetch
    fake.fetch = async (url, init) => (url.includes('/pickup-proposals') ? new Response('{}', { status: 503 }) : f0(url, init))
    const w = await zamow()
    expect(w).toMatchObject({ wynik: 'BLAD', zlecenie: { powod: expect.stringContaining('wymaga osobnych odbiorów') } })
    expect(objete()).toBe(1)
  })
})

describe('Allegro odrzuca połączony odbiór jednego przewoźnika (REQUIRES_SEPARATE_PICKUPS)', () => {
  const KONTO = 'allegro'
  /** Trzy przesyłki tego samego transportu ORLEN, które Allegro podaje w osobnych elementach propozycji. */
  async function orlen(grupy: readonly string[]) {
    await firma()
    for (const [i, grupa] of grupy.entries()) {
      await przesylka(P(i + 1))
      Object.assign(fake.wys.shipments.get(P(i + 1))!, { transport: ['ORLEN'] })
      if (grupa) fake.pickupGroup.set(P(i + 1), grupa)
    }
  }
  const wiersze = () => db.courierPickupOrder.findMany({ orderBy: [{ accountKey: 'asc' }, { attempt: 'asc' }] })
  const przesylkiKomend = () => [...fake.pickupCommands.values()].map((c) => (c.input['shipmentIds'] as string[]).join(','))

  it('odmowa kodem osobnych odbiorów: w tym samym kliknięciu podział po elementach propozycji i osobne zamówienia', async () => {
    await orlen(['A', 'B', 'C'])
    const w = await zamow()
    if (w.wynik !== 'ODBIORY') throw new Error(`zły wynik ${w.wynik}`)
    expect(w.odbiory.map((o) => [o.grupa, o.przesylek, o.wynik.wynik])).toEqual([
      ['ORLEN.p1', 1, 'ZAMOWIONY'],
      ['ORLEN.p2', 1, 'ZAMOWIONY'],
      ['ORLEN.p3', 1, 'ZAMOWIONY'],
    ])
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)},${P(3)}`, P(1), P(2), P(3)])
    // wiersz odmowy przejęty przez pierwszą część: żadnej odmowy na pasku, jedna chwila kliknięcia
    const z = await wiersze()
    expect(z.map((x) => [x.accountKey, x.state])).toEqual([
      [`${KONTO}#odbior:ORLEN`, 'ZAMOWIONY'],
      [`${KONTO}#odbior:ORLEN.p2`, 'ZAMOWIONY'],
      [`${KONTO}#odbior:ORLEN.p3`, 'ZAMOWIONY'],
    ])
    expect(new Set(z.map((x) => x.createdAt.getTime())).size).toBe(1)
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')?.paczki.liczba).toBe(0)
    // ponowne kliknięcie: nic drugi raz
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true })
    expect(przesylkiKomend()).toHaveLength(4)
  })

  it('r2 W-A: odmowa pod kluczem części (T.p2) przejęta przez połączoną grupę, podział na dwie części: dwa różne wiersze i dwie komendy', async () => {
    await orlen(['A', 'B'])
    // odmowa sprzed wydania pod kluczem drugiej części: połączona grupa ją przejmuje, potem część 1 przejmuje ją po odmowie
    await db.courierPickupOrder.create({ data: { carrier: 'ALLEGRO', adapterKey: KEY, accountKey: `${KONTO}#odbior:ORLEN.p2`, pickupDay: '2026-11-23', attempt: 1, reference: 'ref-odmowa-p2', state: 'BLAD', fromMinute: 900, toMinute: 1020, parcels: 1, weightKg: 0, requestedBy: 'u-test', requestedName: 'Magazyn Test', lastError: 'Allegro odrzuciło zamówienie odbioru', failureKind: 'TRWALY' } })
    const w = await zamow()
    if (w.wynik !== 'ODBIORY') throw new Error(`zły wynik ${w.wynik}`)
    expect(w.odbiory.map((o) => [o.grupa, o.przesylek, o.wynik.wynik, 'istnialo' in o.wynik ? o.wynik.istnialo : undefined])).toEqual([
      ['ORLEN.p1', 1, 'ZAMOWIONY', false],
      ['ORLEN.p2', 1, 'ZAMOWIONY', false],
    ])
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)}`, P(1), P(2)])
    const z = await wiersze()
    expect(z.map((x) => [x.accountKey, x.attempt, x.state, x.parcels])).toEqual([
      [`${KONTO}#odbior:ORLEN.p2`, 1, 'ZAMOWIONY', 1],
      [`${KONTO}#odbior:ORLEN.p2`, 2, 'ZAMOWIONY', 1],
    ])
    expect(new Set(z.map((x) => x.externalRef)).size).toBe(2)
    expect((await stanZamawianiaKuriera(db, deps())).get('ALLEGRO')?.paczki.liczba).toBe(0)
  })

  it('odmowa z innym kodem niczego nie dzieli: jedna komenda, odmowa zostaje', async () => {
    await orlen(['', '', ''])
    fake.nextPickupOutcome = ['ERROR']
    expect(await zamow()).toMatchObject({ wynik: 'BLAD' })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)},${P(3)}`])
    expect((await wiersze()).map((x) => [x.accountKey, x.state])).toEqual([[`${KONTO}#odbior:ORLEN`, 'BLAD']])
  })

  it('przewoźnik nie umie podzielić drobniej (jeden element propozycji): odmowa zostaje, bez kolejnych komend', async () => {
    await orlen(['', '', ''])
    const f0 = fake.fetch
    // Allegro zwraca kod osobnych odbiorów, choć propozycje mają jeden element
    fake.fetch = async (url, init) => {
      const r = await f0(url, init)
      for (const c of fake.pickupCommands.values()) if (c.outcome === 'SUCCESS' && !c.kod) Object.assign(c, { outcome: 'ERROR', pickupId: null, carrierPickupId: null, kod: 'REQUIRES_SEPARATE_PICKUPS' })
      fake.pickups.length = 0
      return r
    }
    expect(await zamow()).toMatchObject({ wynik: 'BLAD', zlecenie: { powod: expect.stringContaining('REQUIRES_SEPARATE_PICKUPS') } })
    expect(przesylkiKomend()).toEqual([`${P(1)},${P(2)},${P(3)}`])
  })
})
