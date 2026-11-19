// Wysyłam z Allegro wpięte w host przesyłek (lib/wysylka/nadanie.ts) na bazie testowej i atrapie
// zapisu Allegro (tests/allegro-zapis-atrapa.ts). Te same bramki co inni przewoźnicy (PRACA, moduł z nadawaniem,
// wyłącznik w regule), adapter na koncie Allegro zamówienia (te same tokeny co odczyt), jedna przesyłka przy powtórce
// i zgubionej odpowiedzi, numer nadania i etykieta, anulowanie z nową referencją dla następnej przesyłki.
// Dane fikcyjne, zero połączeń z prawdziwym Allegro.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import type { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { writeAccountSecrets } from '@/lib/adaptery/rotacja-sekretow'
import { ordersByNumber } from '@/lib/api/zamowienia'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { setSecret } from '@/lib/sekrety'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY, commandIdUtworzenia, NAJDLUZSZE_UTWORZENIE_MS } from '@/lib/adaptery/allegro-wysylam-zapis'
import { ANULOWANIE_AUDIT, anulujPrzesylke, bramkaNadania, ROZSTRZYGNIECIE_AUDIT, rozstrzygnijRecznie, progZawieszenia, TWORZENIE_ZAWIESZONE_MS, utworzPrzesylke, widokPrzesylki, type DepsNadania, type ZlecenieNadania } from '@/lib/wysylka/nadanie'
import { NUMER_NADANIA_GOTOWY } from '@/lib/wysylka/zdarzenia'
import { sledzeniePrzesylek } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { zapiszSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { API, AUTH, deliveryProposal, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegroZapis, UA } from './allegro-zapis-atrapa'
import { testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const FORM = '29a8e3c0-7f1b-11ef-9d6f-0d1c5b7a1e01'
const ENV = { APP_ENCRYPTION_KEY: '0'.repeat(64), EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64) }
const SCOPE = { channel: 'ALLEGRO' as const, channelAccountId: 'allegro' }
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica: 'ul. Atrapowa 9', numerDomu: null, numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 222 333', email: 'anna@example.test' },
  punktOdbioru: null,
  faktura: null,
  problemy: ['adres_bez_podzialu'],
}

let fake: FakeAllegroZapis
const deps = (): DepsNadania => ({ fetch: fake.fetch, env: ENV, secrets: { env: ENV, envFallback: false }, http: { pollDelayMs: 0, minIntervalMs: 0 } })

async function regula(o: { adapterKey?: string; zapisWlaczony?: boolean } = {}) {
  await db.carrierRule.updateMany({ where: { carrier: 'ALLEGRO' }, data: { shippingModule: 'WYSYLAM_Z_ALLEGRO', adapterKey: o.adapterKey ?? 'allegro.wysylam.zapis.v1', config: { zapisWlaczony: o.zapisWlaczony ?? true } } })
}

async function zamowienie(externalId = FORM): Promise<string> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: 'ALLEGRO', externalId, paymentState: 'PAID', paymentMethod: 'ONLINE' }), { now: T0 })
  await zapiszRekordKlienta(db, r.orderId!, rekordZOdbiorcy(ODBIORCA), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  return r.orderId!
}

/** „Utwórz przesyłkę” z gabarytem A; ostrzeżenia robocze przyjęte jak przez człowieka (drugie kliknięcie). */
async function utworz(orderId: string) {
  const z: ZlecenieNadania = { orderId, gabaryt: 'ALLEGRO_A', userId: 'u-test' }
  const w = await utworzPrzesylke(db, z, deps())
  if (w.wynik === 'ODMOWA' && w.doPotwierdzenia) return utworzPrzesylke(db, { ...z, potwierdzoneOstrzezenia: w.doPotwierdzenia.map((d) => d.kod) }, deps())
  return w
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  fake = new FakeAllegroZapis()
  fake.base.clock = () => T0.getTime()
  fake.wys.proposals.set(FORM, deliveryProposal(FORM))
  await db.channelConfig.updateMany({ where: SCOPE, data: { statusMode: 'PRACA', config: { apiUrl: API, authUrl: AUTH, userAgent: UA } } })
  await setSecret(db, S.clientId, FAKE_CLIENT_ID, ENV, SCOPE)
  await setSecret(db, S.clientSecret, FAKE_CLIENT_SECRET, ENV, SCOPE)
  const pair = fake.base.issuePair()
  await writeAccountSecrets(db, SCOPE, { [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: new Date(T0.getTime() + 10 * 3600_000).toISOString() }, ENV)
})

describe('bramki', () => {
  it('„Sprawdź u przewoźnika” pojawia się dopiero po najgorszym czasie żywego utworzenia Wysyłam z Allegro', () => {
    // próg per moduł; Wysyłam z Allegro deklaruje najgorszy czas w manifeście, InPost i DPD zostają przy domyślnym
    expect(progZawieszenia(ALLEGRO_WYSYLAM_ZAPIS_KEY)).toBeGreaterThan(NAJDLUZSZE_UTWORZENIE_MS)
    expect(progZawieszenia('dpd.services.zapis.v1')).toBe(TWORZENIE_ZAWIESZONE_MS)
    expect(progZawieszenia('inpost.shipx.zapis.v1')).toBe(TWORZENIE_ZAWIESZONE_MS)
    expect(TWORZENIE_ZAWIESZONE_MS).toBeLessThan(NAJDLUZSZE_UTWORZENIE_MS)
  })

  it('moduł tylko do podglądu (allegro.wysylam.v1) i wyłączony zapis: odmowa z powodem, zero żądań do Allegro', async () => {
    const id = await zamowienie()
    await regula({ adapterKey: 'allegro.wysylam.v1' })
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/tylko liczy przesyłkę/)
    await regula({ zapisWlaczony: false })
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/wyłączone w ustawieniach przewoźnika/)
    expect((await utworz(id)).wynik).toBe('ODMOWA')
    expect(fake.writes()).toEqual([])
    expect(await db.shipment.count()).toBe(0)
  })
})

describe('nadanie przez Wysyłam z Allegro', () => {
  it('przesyłka, numer nadania, etykieta i zdarzenie; powtórne kliknięcie nie tworzy drugiej', async () => {
    await regula()
    const id = await zamowienie()
    const w = await utworz(id)
    expect(w, JSON.stringify(w)).toMatchObject({ wynik: 'UTWORZONA', istniala: false })
    expect(fake.created).toHaveLength(1)
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s).toMatchObject({ state: 'UTWORZONA', externalRef: fake.created[0], trackingNumber: 'AL000111222PL', carrier: 'ALLEGRO', adapterKey: 'allegro.wysylam.zapis.v1', labelFormat: 'PDF' })
    expect(s.labelCiphertext).not.toBeNull()
    expect(await db.auditLog.count({ where: { entity: NUMER_NADANIA_GOTOWY, entityId: s.id } })).toBe(1)
    // komenda niesie propozycję Allegro z adresem z karty zamówienia (poprawka adresu wygrywa)
    const cmd = [...fake.createCommands.values()][0]!
    expect(cmd.input['receiver']).toMatchObject({ name: 'Anna Fikcyjna', street: 'ul. Atrapowa 9', point: 'WAW01A' })
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA', istniala: true })
    expect(fake.created).toHaveLength(1)
    expect((await widokPrzesylki(db, id))!).toMatchObject({ stan: 'UTWORZONA', moznaAnulowac: true })
  })

  it('zgubiona odpowiedź na komendę: wynik komendy rozstrzyga, jedna przesyłka', async () => {
    await regula()
    const id = await zamowienie()
    fake.writeFailures.push('NIEJEDNOZNACZNY_WYKONANY')
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    expect(fake.created).toHaveLength(1)
  })

  it('odrzucenie przez Allegro = BLAD; ponowienie tą samą referencją tworzy dokładnie jedną przesyłkę', async () => {
    await regula()
    const id = await zamowienie()
    fake.nextCreateOutcome = ['ERROR']
    expect(await utworz(id)).toMatchObject({ wynik: 'BLAD', powod: expect.stringMatching(/INVALID_DIMENSIONS/) })
    const ref = (await db.shipment.findFirstOrThrow({ where: { orderId: id } })).reference
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: id, state: 'UTWORZONA' } })).reference).toBe(ref)
    expect(fake.created).toHaveLength(1)
  })

  it('anulowanie: komenda w Allegro, przesyłka ANULOWANA, ślad; następna przesyłka z nową referencją', async () => {
    await regula()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(await anulujPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'ANULOWANA' })
    expect(await anulujPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'ODMOWA' })
    expect(fake.cancelled).toEqual([s.externalRef])
    expect(fake.cancelCommands.size).toBe(1)
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'ANULOWANA' })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'PRZESYLKA_ANULOWANA' } })).toBe(1)
    expect(await db.auditLog.count({ where: { entity: ANULOWANIE_AUDIT, entityId: s.id } })).toBe(1)
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const nowa = await db.shipment.findFirstOrThrow({ where: { orderId: id, state: 'UTWORZONA' } })
    expect(nowa.reference).not.toBe(s.reference)
    expect(fake.created).toHaveLength(2)
  })

  it('konto przełączone z powrotem na cień — anulowanie odmawia bez żądania do Allegro', async () => {
    await regula()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    await db.channelConfig.updateMany({ where: SCOPE, data: { statusMode: 'CIEN' } })
    const przed = fake.writes().length
    expect(await anulujPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/„Tylko podgląd”.*Anulowanie z Kompletora/) })
    expect(fake.writes().length).toBe(przed)
    expect(fake.cancelCommands.size).toBe(0)
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('UTWORZONA')
  })

  it('po anulowaniu oczekujący zapis numeru do kanału zamknięty bez alertu, numer zamówienia wyczyszczony', async () => {
    await regula()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    const o = await db.order.findUniqueOrThrow({ where: { id }, select: { externalId: true } })
    // numer przekazany do zamówienia (przejście z numerem) i oczekujący zapis numeru do Allegro
    await db.orderEvent.create({ data: { orderId: id, kind: 'DO_WYSLANIA', actorId: 'test', data: { z: 'SPAKOWANE', na: 'DO_WYSLANIA', nadanie: s.trackingNumber! } } })
    const w = await db.channelWrite.create({
      data: { orderId: id, ...SCOPE, kind: 'NADANIE', key: s.trackingNumber!, carrier: 'ALLEGRO', mode: 'PRACA', reference: 'ref-nadanie-test', nextAttemptAt: T0, createdAt: T0, attempts: 2, lastError: 'Allegro jeszcze nie dopisało numeru' },
    })
    expect((await ordersByNumber(db, { numer: o.externalId }))[0]?.numerNadania).toBe(s.trackingNumber)
    expect(await anulujPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'ANULOWANA' })
    expect(await db.channelWrite.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ state: 'WYSLANE', result: 'pominięte: przesyłka anulowana', lastError: null })
    expect((await ordersByNumber(db, { numer: o.externalId }))[0]?.numerNadania).toBeNull()
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'PRZESYLKA_ANULOWANA' } })
    expect(ev.data).toMatchObject({ nadanie: '', anulowaneNadanie: s.trackingNumber, zamknieteZapisyNumeru: 1 })
    expect(await db.alert.count({ where: { kind: { startsWith: 'KANAL_ZAPIS' } } })).toBe(0)
  })

  it('zapis numeru po wyczerpanych ponowieniach (BLAD z alertem) zamknięty przy anulowaniu razem z alertem; cudzy alert zostaje', async () => {
    await regula()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    const w = await db.channelWrite.create({
      data: { orderId: id, ...SCOPE, kind: 'NADANIE', key: s.trackingNumber!, carrier: 'ALLEGRO', mode: 'PRACA', reference: 'ref-nadanie-blad', state: 'BLAD', nextAttemptAt: T0, createdAt: T0, attempts: 5, lastError: 'Allegro odrzuca numer' },
    })
    await db.alert.create({ data: { kind: 'KANAL_ZAPIS_BLAD', ref: 'allegro', message: 'numer nie zapisał się', dedupeKey: `zapis:${w.id}:KANAL_ZAPIS_BLAD:5:${T0.toISOString()}` } })
    await db.alert.create({ data: { kind: 'KANAL_ZAPIS_BLAD', ref: 'allegro', message: 'inny zapis', dedupeKey: 'zapis:inny-zapis:KANAL_ZAPIS_BLAD:5:x' } })
    expect(await anulujPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'ANULOWANA' })
    expect(await db.channelWrite.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ state: 'WYSLANE', result: 'pominięte: przesyłka anulowana' })
    const otwarte = await db.alert.findMany({ where: { kind: 'KANAL_ZAPIS_BLAD', closedAt: null }, select: { dedupeKey: true } })
    expect(otwarte.map((a) => a.dedupeKey)).toEqual(['zapis:inny-zapis:KANAL_ZAPIS_BLAD:5:x'])
  })

  it('widok przesyłki pyta o anulowanie ten rejestr, który dostał (bez anulowania = bez przycisku)', async () => {
    await regula()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const reg = defaultRegistry()
    const bezAnulowania = { get: (k: string) => {
      const d = reg.get(k)
      return d ? { ...d, manifest: { ...d.manifest, capabilities: d.manifest.capabilities.filter((c) => c !== 'shipment.cancel') } } : d
    } } as unknown as AdapterRegistry
    expect((await widokPrzesylki(db, id, new Date(), reg))!.moznaAnulowac).toBe(true)
    expect((await widokPrzesylki(db, id, new Date(), bezAnulowania))!.moznaAnulowac).toBe(false)
  })

  it('przewoźnik bez anulowania z Kompletora: odmowa bez żądania', async () => {
    await regula()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    await db.shipment.update({ where: { id: s.id }, data: { adapterKey: 'dpd.services.zapis.v1' } })
    expect((await widokPrzesylki(db, id))!.moznaAnulowac).toBe(false)
  })
})

describe('„Rozstrzygnij ręcznie” dla Wysyłam z Allegro', () => {
  const NASZA = '00000000-0000-4000-9000-00000000a125'
  const CUDZA = '00000000-0000-4000-9000-00000000a126'
  const REF = 'ref-a125-allegro'

  async function niejednoznaczna() {
    await regula()
    const id = await zamowienie()
    const s = await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: REF, state: 'NIEJEDNOZNACZNA', adapterKey: ALLEGRO_WYSYLAM_ZAPIS_KEY, carrier: 'ALLEGRO', requestedBy: 'u' } })
    // w Allegro: cudza przesyłka (np. sąsiedni wiersz panelu) i nasza, utworzona komendą tej referencji (próba 1)
    for (const sid of [CUDZA, NASZA]) {
      fake.created.push(sid)
      fake.wys.shipments.set(sid, { id: sid, packages: [{ waybill: sid === NASZA ? 'AL000111222PL' : 'AL000999888PL' }] })
    }
    return { id, s }
  }
  const roz = (sid: string, numer: string) => rozstrzygnijRecznie(db, sid, { wariant: 'ISTNIEJE', numer }, { userId: 'u-biuro', deps: deps() })
  const bezZmian = async (sid: string) => {
    expect((await db.shipment.findUniqueOrThrow({ where: { id: sid } })).state).toBe('NIEJEDNOZNACZNA')
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })).toBe(0)
  }
  const komend = () => fake.requests.filter((r) => r.startsWith('POST /shipment-management/shipments/create-commands')).length

  it('brak komendy tej referencji, komenda w toku, inna przesyłka pod referencją i zły format = odmowa bez zapisu; nasza = UTWORZONA; zero nowych komend', async () => {
    const { s } = await niejednoznaczna()
    expect(await roz(s.id, 'nie-uuid-1234')).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/8-4-4-4-12/) })
    // Allegro nie zna żadnej komendy tej referencji: istniejąca przesyłka na koncie to nie ta (nie „spróbuj za kilka minut”)
    expect(await roz(s.id, CUDZA)).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/nie ma przesyłki utworzonej przez Kompletor/) })
    await bezZmian(s.id)
    fake.createCommands.set(commandIdUtworzenia(REF, 1), { polls: 1, outcome: 'SUCCESS', shipmentId: NASZA, input: {} })
    expect(await roz(s.id, NASZA)).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/jeszcze tworzy/) })
    expect(await roz(s.id, CUDZA)).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining(`inną przesyłkę (${NASZA})`) })
    await bezZmian(s.id)
    const ok = await roz(s.id, NASZA.toUpperCase())
    expect(ok, JSON.stringify(ok)).toMatchObject({ wynik: 'UTWORZONA', komunikat: expect.stringMatching(/Sprawdzone w Allegro/) })
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'UTWORZONA', externalRef: NASZA, trackingNumber: 'AL000111222PL' })
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })).toBe(1)
    expect(komend()).toBe(0)
    expect(fake.created).toEqual([CUDZA, NASZA])
  })

  it('wyłączone nadawanie: odmowa bez żądania do Allegro', async () => {
    const { s } = await niejednoznaczna()
    await regula({ zapisWlaczony: false })
    const przed = fake.requests.length
    expect(await roz(s.id, NASZA)).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/wyłączone/) })
    expect(fake.requests.length).toBe(przed)
    await bezZmian(s.id)
  })
})

describe('śledzenie przesyłki Wysyłam z Allegro w automacie', () => {
  it('włączone w ustawieniach: „w drodze” u przewoźnika = Wysłane; „czeka na nadanie” zostaje; tylko odczyty', async () => {
    await regula()
    const id = await zamowienie()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    await db.shipment.update({ where: { id: s.id }, data: { createdAt: T0 } })
    await db.order.update({ where: { id }, data: { status: 'DO_WYSLANIA' } })
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV/T/AL1' } })
    const przesylkaAllegro = fake.wys.shipments.get(s.externalRef!)!
    przesylkaAllegro['carrier'] = 'ALLEGRO'
    const t = (h: number) => ({ ...deps(), now: () => new Date(T0.getTime() + h * 3600_000) })
    // bez włączenia w ustawieniach firmy nowy moduł nie jest pytany
    expect(await sledzeniePrzesylek(db, t(3))).toMatchObject({ sprawdzone: 0, bledy: [] })
    await zapiszSledzeniePrzewoznikow(db, { [ALLEGRO_WYSYLAM_ZAPIS_KEY]: true }, [ALLEGRO_WYSYLAM_ZAPIS_KEY], 'u-admin')
    fake.wys.tracking.set('ALLEGRO/AL000111222PL', [{ code: 'PENDING', occurredAt: '2026-10-15T09:00:00Z' }])
    expect(await sledzeniePrzesylek(db, t(3))).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_WYSLANIA')
    fake.wys.tracking.set('ALLEGRO/AL000111222PL', [
      { code: 'PENDING', occurredAt: '2026-10-15T09:00:00Z' },
      { code: 'IN_TRANSIT', occurredAt: '2026-10-15T12:00:00Z' },
    ])
    const przed = fake.requests.filter((r) => !r.startsWith('GET')).length
    expect(await sledzeniePrzesylek(db, t(4))).toMatchObject({ sprawdzone: 1, przeniesione: 1, bledy: [] })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('WYSLANE')
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).carrierStatus).toBe('IN_TRANSIT')
    expect(fake.requests.filter((r) => !r.startsWith('GET')).length).toBe(przed)
  })
})
