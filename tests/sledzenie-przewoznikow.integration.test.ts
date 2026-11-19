// Automat śledzenia przesyłek z modułami włączanymi per przewoźnik i z końcem próbkowania: DPD (DPDInfoServices) po
// włączeniu w ustawieniach firmy przenosi odebraną paczkę do „Wysłane”, a bez włączenia nie jest pytany (zachowanie
// jak przed dodaniem modułu); przesyłka anulowana, kolejne odczyty bez znanego stanu i trwały błąd modułu wypadają
// z próbkowania. Atrapy HTTP, dane fikcyjne, zero połączeń z przewoźnikami.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, PrismaClient } from '@prisma/client'
import { SLEDZENIE_BLEDY_SIECI_LIMIT, SLEDZENIE_CO_MS, SLEDZENIE_NIEZNANY_MS, sledzeniePrzesylek, zadanieSledzenia } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { parseSledzeniePrzewoznikow, zapiszSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { DPD_ZAPIS_KEY } from '@/lib/adaptery/dpd'
import { kluczPrzewoznika, stanKonta } from '@/lib/integracje/zdrowie'
import { adapterDlaPrzesylki } from '@/lib/wysylka/nadanie'
import { kontoIntegracjiPrzewoznika } from '@/lib/wysylka/adapter-przewoznika'
import { oslonAdapter } from '@/lib/integracje/oslona'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { hasShipmentCreator, hasShipmentTracker, type PreparedParcel } from '@/lib/adaptery/kontrakt'
import { PP_ZAPIS_KEY, type PocztaPolskaZapis } from '@/lib/adaptery/pocztapolska'
import { organizationIdOf } from '@/lib/db'
import { ADRESAT_PP, NADAWCA_PP, PP_HASLO, PP_LOGIN, PP_URZAD, ppAtrapa } from './pocztapolska-atrapa'
import { PRZYKLADOWE_ODBIORY } from './pakowanie-fixtures'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, NADAWCA_TESTOWY, ODBIORCA_TESTOWY } from './dpd-atrapa'
import { DPD_INFO_HASLO, DPD_INFO_LOGIN, DPD_INFO_URL, dpdSledzenieAtrapa } from './dpd-sledzenie-atrapa'
import { INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa } from './inpost-atrapa'
import { testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const H = 3600_000
const DPD_KEY = 'dpd.services.zapis.v1'
const INPOST_KEY = 'inpost.shipx.zapis.v1'
const ENV = {
  EKRANY_PRACA: '1',
  INPOST_TOKEN,
  DPD_LOGIN,
  DPD_PASSWORD,
  DPD_SLEDZENIE_LOGIN: DPD_INFO_LOGIN,
  DPD_SLEDZENIE_HASLO: DPD_INFO_HASLO,
}

async function kontoPraca() {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', trackingMode: 'PRACA', config: { zapisWlaczony: true } } })
}

async function regulaDpd() {
  await db.carrierRule.updateMany({
    where: { carrier: 'DPD' },
    data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: DPD_KEY, config: { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, envPrefix: 'DPD', sledzenieUrl: DPD_INFO_URL } },
  })
}

async function regulaInpost(zapis = true) {
  await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: INPOST_KEY, config: { baseUrl: INPOST_SANDBOX, organizationId: INPOST_ORG, zapisWlaczony: zapis } } })
}

let nr = 0
async function paczka(carrier: Carrier, c: PrismaClient = db, o: { metoda?: string; konto?: string } = {}): Promise<{ id: string; ref: string }> {
  const pid = await product(c, `P-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const metoda = o.metoda ?? (carrier === 'DPD' ? 'Kurier DPD' : undefined)
  const r = await ingestOrder(c, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: 'WOO_SD', paymentState: 'PAID', ...(metoda ? { deliveryMethod: metoda } : {}) }), { now: T0 })
  const id = r.orderId!
  await c.order.update({ where: { id }, data: { carrier, status: 'DO_WYSLANIA' } })
  await c.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: `FV/T/${nr}` } })
  const dpd = carrier === 'DPD' || carrier === 'DPD_EMPIK'
  const ref = dpd ? `0000${100000 + nr}U` : `${900_000 + nr}`
  await c.shipment.create({ data: { orderId: id, packageNo: 1, reference: `ref-${id}`, state: 'UTWORZONA', adapterKey: dpd ? DPD_KEY : INPOST_KEY, carrier, externalRef: ref, trackingNumber: `NR${100000 + nr}`, accountSuffix: o.konto ?? null } })
  return { id, ref }
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const przesylka = (orderId: string) => db.shipment.findFirstOrThrow({ where: { orderId } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.carrierPickup.createMany({ data: PRZYKLADOWE_ODBIORY })
  await kontoPraca()
})

describe('śledzenie per przewoźnik', () => {
  it('DPD domyślnie wyłączony: nie jest pytany (jak przed zmianą); po włączeniu „odebrana przez kuriera” = Wysłane, „zarejestrowana” zostaje', async () => {
    await regulaDpd()
    const odebrana = await paczka('DPD')
    const czeka = await paczka('DPD')
    const at = dpdSledzenieAtrapa()
    at.zdarzenia.set(odebrana.ref, [{ kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-12T14:00:00' }])
    at.zdarzenia.set(czeka.ref, [{ kod: '030103', opis: 'Zarejestrowano dane przesyłki', czas: '2026-11-12T08:00:00' }])
    const pozniej = new Date(Date.now() + 3 * H)
    const deps = { fetch: at.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => pozniej }

    expect(await sledzeniePrzesylek(db, deps)).toMatchObject({ sprawdzone: 0, przeniesione: 0, bledy: [] })
    expect(at.calls).toHaveLength(0)
    expect(await status(odebrana.id)).toBe('DO_WYSLANIA')

    await zapiszSledzeniePrzewoznikow(db, { [DPD_KEY]: true }, [DPD_KEY, INPOST_KEY], 'u-admin')
    expect(parseSledzeniePrzewoznikow((await db.organization.findFirstOrThrow()).settings)).toEqual({ [DPD_KEY]: true })
    expect(await db.auditLog.count({ where: { entity: 'Organization.wysylkaSledzenie' } })).toBe(1)
    const w = await sledzeniePrzesylek(db, deps)
    expect(w).toMatchObject({ sprawdzone: 2, przeniesione: 1, bledy: [] })
    expect(await status(odebrana.id)).toBe('WYSLANE')
    expect(await status(czeka.id)).toBe('DO_WYSLANIA')
    expect((await przesylka(czeka.id)).carrierStatus).toBe('030103 Zarejestrowano dane przesyłki')
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: odebrana.id, kind: 'WYSLANE' } })).actorId).toBe('system:sledzenie-przesylki')
    expect(at.calls.every((c) => c.url === DPD_INFO_URL)).toBe(true)

    // ponowny zapis bez zmian: bez drugiego śladu
    await zapiszSledzeniePrzewoznikow(db, { [DPD_KEY]: true }, [DPD_KEY, INPOST_KEY], 'u-admin')
    expect(await db.auditLog.count({ where: { entity: 'Organization.wysylkaSledzenie' } })).toBe(1)
  })
})

describe('koniec próbkowania', () => {
  it('InPost „canceled”: bez zmiany statusu i bez błędu, potem przesyłka nie jest pytana', async () => {
    await regulaInpost()
    const p = await paczka('PACZKOMATY')
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(p.ref), 'canceled')
    const t1 = new Date(Date.now() + 3 * H)
    const deps = (t: Date) => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    expect(await sledzeniePrzesylek(db, deps(t1))).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    expect((await przesylka(p.id)).trackingStoppedAt).not.toBeNull()
    expect(await status(p.id)).toBe('DO_WYSLANIA')
    const n = shipx.calls.length
    expect((await sledzeniePrzesylek(db, deps(new Date(t1.getTime() + H)))).sprawdzone).toBe(0)
    expect(shipx.calls).toHaveLength(n)
  })

  it('nieznany stan liczy się czasem: etykieta w piątek, kurier w poniedziałek = Wysłane; po progu samych nieznanych koniec', async () => {
    await regulaInpost()
    const p = await paczka('PACZKOMATY')
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(p.ref), 'status_spoza_listy')
    let t = new Date(Date.now() + 3 * H)
    const start = t.getTime()
    const deps = () => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    // przez weekend (ok. 68 h, odczyt co 4 h zamiast co pół godziny, żeby test był krótki): przesyłka cały czas w śledzeniu
    while (t.getTime() - start < 68 * H) {
      expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(1)
      t = new Date(t.getTime() + 4 * H)
    }
    expect((await przesylka(p.id)).trackingStoppedAt).toBeNull()
    expect((await przesylka(p.id)).trackingUnknownSince?.getTime()).toBe(start)
    shipx.ustawStatus(Number(p.ref), 'taken_by_courier')
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 1 })
    expect(await status(p.id)).toBe('WYSLANE')
    expect((await przesylka(p.id)).trackingUnknownSince).toBeNull()

    // druga paczka: nieznany stan bez przerwy dłużej niż próg = koniec próbkowania
    const q = await paczka('PACZKOMATY')
    shipx.ustawStatus(Number(q.ref), 'status_spoza_listy')
    const t0 = t.getTime()
    await sledzeniePrzesylek(db, deps())
    t = new Date(t0 + SLEDZENIE_NIEZNANY_MS - H)
    await sledzeniePrzesylek(db, deps())
    expect((await przesylka(q.id)).trackingStoppedAt).toBeNull()
    t = new Date(t0 + SLEDZENIE_NIEZNANY_MS + H)
    await sledzeniePrzesylek(db, deps())
    expect((await przesylka(q.id)).trackingStoppedAt).not.toBeNull()
    t = new Date(t.getTime() + H)
    // q po progu nie jest już pytana; pierwsza (po „Wysłane”) bez osi pytana o sam status najwyżej
    // SLEDZENIE_PO_WYSLANIU_DNI od „Wysłane” (zdarzenie z chwili zapisu, a zegar testu jest już ponad 7 dni dalej)
    const wywolaniaQ = () => shipx.calls.filter((c) => c.path.endsWith(`/${q.ref}`)).length
    const przedQ = wywolaniaQ()
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(0)
    expect(wywolaniaQ()).toBe(przedQ)
  })

  it('InPost 404 (np. zły adres usługi w regule): stan nieznany, bez końca od razu; po poprawie reguły paczka idzie do Wysłane; koniec dopiero po progu', async () => {
    await regulaInpost()
    const p = await paczka('PACZKOMATY')
    const shipx = inpostAtrapa()
    let t = new Date(Date.now() + 3 * H)
    const deps = () => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    // przesyłki nie ma pod tym adresem (atrapa bez statusu = 404) przez długi weekend: dalej w śledzeniu, bez błędu
    const start = t.getTime()
    while (t.getTime() - start < SLEDZENIE_NIEZNANY_MS - 4 * H) {
      expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, bledy: [] })
      t = new Date(t.getTime() + 8 * H)
    }
    expect((await przesylka(p.id)).trackingStoppedAt).toBeNull()
    shipx.ustawStatus(Number(p.ref), 'taken_by_courier')
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 1 })
    expect(await status(p.id)).toBe('WYSLANE')

    const q = await paczka('PACZKOMATY')
    const t0 = t.getTime()
    await sledzeniePrzesylek(db, deps())
    t = new Date(t0 + SLEDZENIE_NIEZNANY_MS + H)
    await sledzeniePrzesylek(db, deps())
    expect((await przesylka(q.id)).trackingStoppedAt).not.toBeNull()
  })

  it('próg nieznanego stanu przeżywa długi weekend: etykieta w środę 23.12, odbiór w poniedziałek 28.12', () => {
    const etykieta = new Date('2026-12-23T15:00:00+01:00').getTime()
    const odbior = new Date('2026-12-28T11:00:00+01:00').getTime()
    expect(SLEDZENIE_NIEZNANY_MS).toBeGreaterThan(odbior - etykieta)
  })
})

describe('błąd konta nie kończy śledzenia przesyłek', () => {
  it('zapis wyłączony w regule: jedna linia błędu na konto, przesyłki w śledzeniu; po włączeniu zapisu wracają', async () => {
    await regulaInpost(false)
    const p = await paczka('PACZKOMATY')
    const q = await paczka('PACZKOMATY')
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(p.ref), 'taken_by_courier')
    shipx.ustawStatus(Number(q.ref), 'confirmed')
    const t1 = new Date(Date.now() + 3 * H)
    const deps = (t: Date) => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    const w1 = await sledzeniePrzesylek(db, deps(t1))
    expect(w1.bledy).toHaveLength(1)
    expect(w1.bledy[0]).toMatch(/zapis wyłączony/)
    expect((await przesylka(p.id)).trackingStoppedAt).toBeNull()
    expect((await przesylka(q.id)).trackingStoppedAt).toBeNull()
    expect(shipx.calls).toHaveLength(0)
    await expect(zadanieSledzenia(db, deps(new Date(t1.getTime() + H)))).rejects.toThrow(/^śledzenie przesyłek: [^;]*$/)
    await regulaInpost(true)
    expect(await sledzeniePrzesylek(db, deps(new Date(t1.getTime() + 2 * H)))).toMatchObject({ sprawdzone: 2, przeniesione: 1, bledy: [] })
    expect(await status(p.id)).toBe('WYSLANE')
  })

  it('InPost 401 w jednym przebiegu (rotacja tokena): bez końca śledzenia, reszta konta nie pytana; następny przebieg przenosi', async () => {
    await regulaInpost()
    const p = await paczka('PACZKOMATY')
    const q = await paczka('PACZKOMATY')
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(p.ref), 'taken_by_courier')
    shipx.ustawStatus(Number(q.ref), 'taken_by_courier')
    shipx.reply({ status: 401, body: '{"error":"token_invalid"}' })
    const t1 = new Date(Date.now() + 3 * H)
    const deps = (t: Date) => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    const w1 = await sledzeniePrzesylek(db, deps(t1))
    expect(w1).toMatchObject({ sprawdzone: 0, przeniesione: 0 })
    expect(w1.bledy).toHaveLength(1)
    expect(shipx.calls).toHaveLength(1)
    for (const x of [p, q]) expect((await przesylka(x.id)).trackingStoppedAt).toBeNull()
    expect(await sledzeniePrzesylek(db, deps(new Date(t1.getTime() + H)))).toMatchObject({ sprawdzone: 2, przeniesione: 2, bledy: [] })
  })

  it('DPD: zły login usługi śledzenia nie kończy śledzenia i nie wyłącza konta nadawania; po poprawie danych paczka idzie do Wysłane', async () => {
    await regulaDpd()
    await zapiszSledzeniePrzewoznikow(db, { [DPD_ZAPIS_KEY]: true }, [DPD_ZAPIS_KEY], 'u-admin')
    const p = await paczka('DPD')
    const at = dpdSledzenieAtrapa()
    at.zdarzenia.set(p.ref, [{ kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-12T14:00:00' }])
    let t = new Date(Date.now() + 3 * H)
    const zle = { ...ENV, DPD_SLEDZENIE_HASLO: 'haslo-z-literowka' }
    const deps = (env: Record<string, string>) => ({ fetch: at.fetchImpl, env, secrets: { env, envFallback: true }, now: () => t })
    // 6 przebiegów z odmową (Fault o uprawnieniach i 401): próg wyłączenia konta to 5
    for (let i = 0; i < 6; i++) {
      if (i % 2) at.awarie.push({ status: 401, body: '' })
      const w = await sledzeniePrzesylek(db, deps(zle))
      expect(w.bledy).toHaveLength(1)
      t = new Date(t.getTime() + SLEDZENIE_CO_MS + 60_000)
    }
    expect((await przesylka(p.id)).trackingStoppedAt).toBeNull()
    const konto = await stanKonta(db, kluczPrzewoznika('dpd'))
    expect(konto?.disabledAt ?? null).toBeNull()
    expect(konto?.consecutiveFailures ?? 0).toBe(0)
    // nadawanie DPD (ten sam klucz konta) nie jest zablokowane: adapter przesyłki tworzy się i nie odkłada wywołań
    const a = await adapterDlaPrzesylki(db, await przesylka(p.id), deps(ENV))
    expect(a.manifest.adapterKey).toBe(DPD_ZAPIS_KEY)
    expect(await sledzeniePrzesylek(db, deps(ENV))).toMatchObject({ sprawdzone: 1, przeniesione: 1, bledy: [] })
    expect(await status(p.id)).toBe('WYSLANE')
  })

  it('DPD: pięć odmów śledzenia wprost przez osłonę konta nie liczy się do wyłączenia konta nadawania', async () => {
    await regulaDpd()
    const p = await paczka('DPD')
    const at = dpdSledzenieAtrapa()
    for (let i = 0; i < 6; i++) at.awarie.push({ status: 401, body: '' })
    const a = await adapterDlaPrzesylki(db, await przesylka(p.id), { fetch: at.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
    for (let i = 0; i < 6; i++) await expect((a as unknown as { trackShipment(r: string): Promise<unknown> }).trackShipment(p.ref)).rejects.toThrow(/odmowa dostępu/)
    const konto = await stanKonta(db, kluczPrzewoznika('dpd'))
    expect(konto?.disabledAt ?? null).toBeNull()
  })

  it(`${SLEDZENIE_BLEDY_SIECI_LIMIT} błędy sieci z rzędu jednego konta: reszta jego przesyłek czeka do następnego przebiegu`, async () => {
    await regulaInpost()
    const paczki: { id: string; ref: string }[] = []
    for (let i = 0; i < SLEDZENIE_BLEDY_SIECI_LIMIT + 2; i++) paczki.push(await paczka('PACZKOMATY'))
    const shipx = inpostAtrapa()
    for (const x of paczki) shipx.ustawStatus(Number(x.ref), 'taken_by_courier')
    // ShipX zawieszony: każde żądanie kończy się błędem sieci, dopóki `awaria`
    let awaria = true
    const pytane = new Set<string>()
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (!awaria) return shipx.fetchImpl(url, init)
      pytane.add(new URL(url).pathname)
      throw new Error('socket hang up')
    }
    const t1 = new Date(Date.now() + 3 * H)
    const deps = (t: Date) => ({ fetch: fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    const w1 = await sledzeniePrzesylek(db, deps(t1))
    expect(w1.sprawdzone).toBe(0)
    expect(pytane.size).toBe(SLEDZENIE_BLEDY_SIECI_LIMIT)
    expect(w1.bledy).toHaveLength(SLEDZENIE_BLEDY_SIECI_LIMIT + 1)
    expect(w1.bledy.at(-1)).toMatch(/błędy sieci z rzędu/)
    awaria = false
    for (const x of paczki) expect((await przesylka(x.id)).trackingStoppedAt).toBeNull()
    expect((await sledzeniePrzesylek(db, deps(new Date(t1.getTime() + H)))).przeniesione).toBe(paczki.length)
  })
})

describe('kolejka przebiegu: przesyłka z błędem nie zatrzymuje reszty konta', () => {
  /** ShipX: wybrane przesyłki z trwałą odpowiedzią (błąd sieci albo kod HTTP), reszta z atrapy. */
  function shipxZBledami(bledne: Map<string, 'siec' | number>) {
    const shipx = inpostAtrapa()
    const pytane: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const id = new URL(url).pathname.split('/').pop() ?? ''
      pytane.push(id)
      const b = bledne.get(id)
      if (b === 'siec') throw new Error('socket hang up')
      if (typeof b === 'number') return new Response('{"error":"forbidden"}', { status: b })
      return shipx.fetchImpl(url, init)
    }
    return { shipx, pytane, fetchImpl }
  }

  it(`najstarsze ${SLEDZENIE_BLEDY_SIECI_LIMIT} przesyłki z trwałym błędem sieci: nowsze odebrane idą do Wysłane w następnym przebiegu, błędne dalej pytane`, async () => {
    await regulaInpost()
    const zle: { id: string; ref: string }[] = []
    for (let i = 0; i < SLEDZENIE_BLEDY_SIECI_LIMIT; i++) zle.push(await paczka('PACZKOMATY'))
    const dobre = [await paczka('PACZKOMATY'), await paczka('PACZKOMATY')]
    const f = shipxZBledami(new Map(zle.map((x) => [x.ref, 'siec' as const])))
    for (const x of dobre) f.shipx.ustawStatus(Number(x.ref), 'taken_by_courier')
    let t = new Date(Date.now() + 3 * H)
    const deps = () => ({ fetch: f.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    const w1 = await sledzeniePrzesylek(db, deps())
    expect(w1.przeniesione).toBe(0)
    expect(w1.bledy.at(-1)).toMatch(/błędy sieci z rzędu/)
    t = new Date(t.getTime() + SLEDZENIE_CO_MS + 60_000)
    expect((await sledzeniePrzesylek(db, deps())).przeniesione).toBe(dobre.length)
    for (const x of dobre) expect(await status(x.id)).toBe('WYSLANE')
    // błędne zostają w śledzeniu i są pytane w kolejnych przebiegach
    const przed = f.pytane.length
    t = new Date(t.getTime() + SLEDZENIE_CO_MS + 60_000)
    await sledzeniePrzesylek(db, deps())
    expect(f.pytane.slice(przed).filter((id) => zle.some((x) => x.ref === id)).length).toBeGreaterThan(0)
    for (const x of zle) expect((await przesylka(x.id)).trackingStoppedAt).toBeNull()
  })

  it('najstarsza przesyłka z odmową 403 (wzięta za błąd konta): nowsze odebrane idą do Wysłane w następnym przebiegu', async () => {
    await regulaInpost()
    const zla = await paczka('PACZKOMATY')
    const dobre = [await paczka('PACZKOMATY'), await paczka('PACZKOMATY')]
    const f = shipxZBledami(new Map([[zla.ref, 403]]))
    for (const x of dobre) f.shipx.ustawStatus(Number(x.ref), 'taken_by_courier')
    let t = new Date(Date.now() + 3 * H)
    const deps = () => ({ fetch: f.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    const w1 = await sledzeniePrzesylek(db, deps())
    expect(w1).toMatchObject({ sprawdzone: 0, przeniesione: 0 })
    expect(f.pytane).toEqual([zla.ref])
    t = new Date(t.getTime() + SLEDZENIE_CO_MS + 60_000)
    expect((await sledzeniePrzesylek(db, deps())).przeniesione).toBe(dobre.length)
    for (const x of dobre) expect(await status(x.id)).toBe('WYSLANE')
    expect((await przesylka(zla.id)).trackingStoppedAt).toBeNull()
  })

  it('zepsute konto z ponad 50 przesyłkami nie zagłodzi zdrowego konta (przesyłki InPost czekające dłużej są pytane)', async () => {
    await regulaInpost()
    await regulaDpd()
    await zapiszSledzeniePrzewoznikow(db, { [DPD_ZAPIS_KEY]: true }, [DPD_ZAPIS_KEY], 'u-admin')
    const inpost = [await paczka('PACZKOMATY'), await paczka('PACZKOMATY')]
    const dpd: { id: string; ref: string }[] = []
    for (let i = 0; i < 55; i++) dpd.push(await paczka('DPD'))
    const shipx = inpostAtrapa()
    for (const x of inpost) shipx.ustawStatus(Number(x.ref), 'confirmed')
    const at = dpdSledzenieAtrapa()
    const fetchImpl = (url: string, init?: RequestInit) => (url.startsWith(DPD_INFO_URL) ? at.fetchImpl(url, init) : shipx.fetchImpl(url, init))
    // DPD: zły login usługi śledzenia = błąd konta przy każdej próbie
    const zle = { ...ENV, DPD_SLEDZENIE_HASLO: 'haslo-z-literowka' }
    let t = new Date(Date.now() + 3 * H)
    const deps = () => ({ fetch: fetchImpl, env: zle, secrets: { env: zle, envFallback: true }, now: () => t })
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(inpost.length)
    for (const x of inpost) shipx.ustawStatus(Number(x.ref), 'taken_by_courier')
    let przebiegi = 0
    while ((await status(inpost[0]!.id)) !== 'WYSLANE' && przebiegi < 5) {
      t = new Date(t.getTime() + SLEDZENIE_CO_MS + 60_000)
      const w = await sledzeniePrzesylek(db, deps())
      expect(w.bledy).toHaveLength(1) // jedno pytanie DPD na przebieg, jedna linia
      przebiegi++
    }
    // ceil(55 / 50) + 1 przebiegów: przesyłki zepsutego konta dostają świeży czas, więc nie wyprzedzają czekających dłużej
    expect(przebiegi).toBeLessThanOrEqual(3)
    for (const x of inpost) expect(await status(x.id)).toBe('WYSLANE')
    for (const x of dpd) expect((await przesylka(x.id)).trackingStoppedAt).toBeNull()
  })
})

describe('konta przewoźnika osobno', () => {
  it('dwa konta jednego modułu: błąd konta głównego DPD nie zatrzymuje konta EMPIK', async () => {
    await regulaDpd()
    // konto główne z wyłączonym zapisem (błąd konta), konto EMPIK z tym samym modułem i włączonym zapisem
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { config: { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: false, envPrefix: 'DPD', sledzenieUrl: DPD_INFO_URL } } })
    await db.carrierRule.updateMany({
      where: { carrier: 'DPD_EMPIK' },
      data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: DPD_KEY, config: { sekretyKonta: 'EMPIK', baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, envPrefix: 'DPD', sledzenieUrl: DPD_INFO_URL } },
    })
    await zapiszSledzeniePrzewoznikow(db, { [DPD_ZAPIS_KEY]: true }, [DPD_ZAPIS_KEY], 'u-admin')
    const glowne = [await paczka('DPD'), await paczka('DPD')]
    const empik = await paczka('DPD_EMPIK', db, { metoda: 'Odbiór w salonu Empik', konto: 'EMPIK' })
    const at = dpdSledzenieAtrapa()
    for (const x of [...glowne, empik]) at.zdarzenia.set(x.ref, [{ kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-12T14:00:00' }])
    const t = new Date(Date.now() + 3 * H)
    const w = await sledzeniePrzesylek(db, { fetch: at.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    expect(w).toMatchObject({ sprawdzone: 1, przeniesione: 1 })
    expect(w.bledy).toHaveLength(1)
    expect(w.bledy[0]).toMatch(/zapis wyłączony/)
    expect(await status(empik.id)).toBe('WYSLANE')
    for (const x of glowne) {
      expect(await status(x.id)).toBe('DO_WYSLANIA')
      expect((await przesylka(x.id)).trackingStoppedAt).toBeNull()
    }
  })

  it('DPD: 401 przy tworzeniu przesyłki nadal liczy się do wyłączenia konta nadawania (odmowa śledzenia nie)', async () => {
    await regulaDpd()
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { config: { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, envPrefix: 'DPD', sledzenieUrl: DPD_INFO_URL, nadawca: JSON.stringify(NADAWCA_TESTOWY) } } })
    const p = await paczka('DPD')
    const nadanie = dpdAtrapa(Array.from({ length: 10 }, () => ({ status: 401, body: '' })))
    const a = await adapterDlaPrzesylki(db, await przesylka(p.id), { fetch: nadanie.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
    const parcel: PreparedParcel = { courierCode: 'DPD_CLASSIC', gabaryt: 'DPD', sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 1.5, codAmount: null, pickupPoint: null, problems: [] }
    for (let i = 0; i < 6; i++) await a.createShipment({ carrier: 'DPD', parcel, recipient: ODBIORCA_TESTOWY }, `ref-401-${i}`).catch(() => undefined)
    expect(nadanie.calls.length).toBeGreaterThan(0)
    const konto = await stanKonta(db, kluczPrzewoznika('dpd'))
    expect(konto?.disabledAt ?? null).not.toBeNull()
  })

  it('Poczta Polska: pięć odmów usługi Śledzenie przez osłonę konta nie wyłącza konta eNadawcy', async () => {
    const pp = ppAtrapa({ sledzenie: { http: 401, body: '' } })
    const ad = defaultRegistry().create(PP_ZAPIS_KEY, {
      integration: { organizationId: organizationIdOf(db), kind: 'carrier', id: 'pp', name: 'Poczta Polska' },
      rawConfig: { urzadNadania: PP_URZAD, zapisWlaczony: true, nadawca: JSON.stringify(NADAWCA_PP) },
      rawSecrets: { ENADAWCA_LOGIN: PP_LOGIN, ENADAWCA_HASLO: PP_HASLO, SLEDZENIE_LOGIN: 'sledzenie_test', SLEDZENIE_HASLO: 'haslo-sledzenia-1' },
      fetch: pp.fetchImpl,
      http: { retry: { attempts: 2, baseDelayMs: 0 }, minIntervalMs: 0 },
    })
    if (!hasShipmentCreator(ad) || !hasShipmentTracker(ad)) throw new Error('bez shipment.create / shipment.track')
    const ref = 'a1b2c3d4-e5f6-5789-8abc-def012345678'
    const parcel: PreparedParcel = { courierCode: 'M', gabaryt: 'POCZTA_POLSKA', sideXCm: 15, sideYCm: 30, sideZCm: 40, weightKg: 1.5, codAmount: null, pickupPoint: null, problems: [] }
    const o = await (ad as unknown as PocztaPolskaZapis).createShipment({ carrier: 'POCZTA_POLSKA', parcel, recipient: ADRESAT_PP }, ref)
    expect(o.kind).toBe('OK')
    const guid = (o as { externalRef: string }).externalRef
    const konto = kontoIntegracjiPrzewoznika(PP_ZAPIS_KEY, null, 'Przewoźnik Poczta Polska')
    const oslona = await oslonAdapter(db, ad, konto)
    if (!hasShipmentTracker(oslona)) throw new Error('bez shipment.track')
    for (let i = 0; i < 6; i++) await expect(oslona.trackShipment(guid)).rejects.toThrow(/odmowa dostępu/)
    const stan = await stanKonta(db, konto.klucz)
    expect(stan?.disabledAt ?? null).toBeNull()
    expect(stan?.consecutiveFailures ?? 0).toBe(0)
  })
})
