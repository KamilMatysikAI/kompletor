// rozstrzygnięcie ręczne zamówienia kuriera „nie wiadomo, czy dotarło” („DPD przyjął” / „DPD nie przyjął”)
// i wolne przedziały podjazdu z dostępności DPD dla okna „Zamów kuriera”. Atrapa DPDServices, dane fikcyjne, zero
// połączeń z DPD.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { liniePaskaKuriera } from '@/lib/wysylka/kurier-widok'
import { przedzialyKuriera, rozstrzygnijKuriera, stanZamawianiaKuriera, zamowKuriera, ROZSTRZYGNIECIE_KURIERA_AUDIT, type DepsKuriera, type ZamowienieKuriera } from '@/lib/wysylka/zamowienie-kuriera'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, json, NADAWCA_TESTOWY } from './dpd-atrapa'
import { seedBase } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const ENV = { EKRANY_PRACA: '1', DPD_LOGIN, DPD_PASSWORD }
// poniedziałek 23.11.2026 13:00 w Warszawie
const TERAZ = new Date('2026-11-23T12:00:00Z')
const KONTO = { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, zamawianieKuriera: true, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20 }
const KURIER = '/public/courierorder/v1/packagesPickupCall'
const DOSTEPNOSC = '/public/courierorder/v1/courierOrderAvailability'

let atrapa: ReturnType<typeof dpdAtrapa>
const deps = (): DepsKuriera => ({ fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => TERAZ })
const ZLECENIE: ZamowienieKuriera = { carrier: 'DPD', data: '2026-11-23', odMin: 14 * 60, doMin: 17 * 60, liczba: 2, wagaKg: 3, userId: 'u-test', userName: 'Magazyn Test' }
const zamow = (z: Partial<ZamowienieKuriera> = {}) => zamowKuriera(db, { ...ZLECENIE, ...z }, deps())
const rozstrzygnij = (id: string, wariant: 'PRZYJAL' | 'NIE_PRZYJAL', numer?: string) => rozstrzygnijKuriera(db, { id, wariant, numer, userId: 'u-test', userName: 'Magazyn Test' }, deps())

async function firma(konto: Record<string, unknown> = KONTO): Promise<void> {
  await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: konto as never } })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_TESTOWY } } })
}

/** Zamówienie przerwane po wysłaniu: NIEJEDNOZNACZNY z alertem. */
async function niewiadoma(z: Partial<ZamowienieKuriera> = {}): Promise<string> {
  atrapa = dpdAtrapa([{ error: new Error('socket hang up') }])
  const w = await zamow(z)
  if (w.wynik !== 'NIEJEDNOZNACZNY') throw new Error(`oczekiwano NIEJEDNOZNACZNY, jest ${w.wynik}`)
  return w.zlecenie.id
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  atrapa = dpdAtrapa()
  await firma()
})

describe('rozstrzygnięcie ręczne niewiadomej', () => {
  it('„DPD nie przyjął”: BLAD z dopiskiem kto i kiedy, wpis w AuditLog, alert zamknięty; potem zamówienie tego dnia tylko z `drugi` (nowy wiersz)', async () => {
    const id = await niewiadoma()
    expect(await db.alert.count({ where: { dedupeKey: `kurier:${id}`, closedAt: null } })).toBe(1)
    expect(await rozstrzygnij(id, 'NIE_PRZYJAL')).toMatchObject({ wynik: 'ZAPISANE', zlecenie: { stan: 'BLAD', recznie: true } })
    const w = await db.courierPickupOrder.findUniqueOrThrow({ where: { id } })
    expect(w).toMatchObject({ state: 'BLAD', failureKind: 'RECZNE' })
    expect(w.lastError).toMatch(/^Rozstrzygnięte ręcznie: przewoźnik nie przyjął zlecenia \(zaznaczył: Magazyn Test, 2026-11-23 13:00\)\. Wcześniej: /)
    expect(await db.alert.count({ where: { dedupeKey: `kurier:${id}`, closedAt: null } })).toBe(0)
    const audyt = await db.auditLog.findMany({ where: { entity: ROZSTRZYGNIECIE_KURIERA_AUDIT, entityId: id } })
    expect(audyt).toHaveLength(1)
    expect(audyt[0]).toMatchObject({ actorId: 'user:u-test', before: { stan: 'NIEJEDNOZNACZNY' }, after: { wariant: 'NIE_PRZYJAL', stan: 'BLAD', dzien: '2026-11-23' } })
    // ręczne „nie przyjął” to nie pewność: bez `drugi` nie woła DPD i prosi o potwierdzenie drugiego podjazdu
    atrapa = dpdAtrapa([json({ status: { status: 'OK' }, orderNumber: 'ZK-5', checkSum: 'c' })])
    expect(await zamow({ odMin: 15 * 60 })).toMatchObject({ wynik: 'POTWIERDZ_DRUGI', zlecenie: { id, stan: 'BLAD', recznie: true }, powod: expect.stringContaining('drugi, płatny podjazd') })
    expect(atrapa.calls).toEqual([])
    // z `drugi` woła DPD; wiersz rozstrzygnięty ręcznie zostaje, zamówienie to nowa próba
    const z2 = await zamow({ odMin: 15 * 60, drugi: true })
    expect(z2).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false, zlecenie: { numer: 'ZK-5', proba: 2, recznie: false } })
    expect(z2.wynik === 'ZAMOWIONY' && z2.zlecenie.id).not.toBe(id)
    expect(atrapa.calls.filter((c) => c.path === KURIER)).toHaveLength(1)
    expect(await db.courierPickupOrder.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'BLAD', failureKind: 'RECZNE' })
  })

  it('po ręcznym „nie przyjął” i pewnej odmowie DPD przy drugiej próbie dalej trzeba potwierdzić drugi podjazd; zwykła odmowa DPD nie wymaga potwierdzenia', async () => {
    const id = await niewiadoma()
    await rozstrzygnij(id, 'NIE_PRZYJAL')
    atrapa = dpdAtrapa([json({ status: { status: 'VALIDATION_ERROR' } })])
    expect(await zamow({ drugi: true })).toMatchObject({ wynik: 'BLAD' })
    atrapa = dpdAtrapa()
    expect(await zamow()).toMatchObject({ wynik: 'POTWIERDZ_DRUGI', zlecenie: { id } })
    expect(atrapa.calls).toEqual([])
    // inny dzień: pewna odmowa DPD, kolejne zamówienie bez ostrzeżenia tym samym wierszem
    atrapa = dpdAtrapa([json({ status: { status: 'VALIDATION_ERROR' } }), json({ status: { status: 'OK' }, orderNumber: 'ZK-7', checkSum: 'c' })])
    const b = await zamow({ data: '2026-11-24' })
    if (b.wynik !== 'BLAD') throw new Error('oczekiwano BLAD')
    expect(await zamow({ data: '2026-11-24' })).toMatchObject({ wynik: 'ZAMOWIONY', zlecenie: { id: b.zlecenie.id, numer: 'ZK-7', proba: 1 } })
  })

  it('„DPD przyjął” z numerem: ZAMOWIONY z numerem i dopiskiem; bez numeru też można; następne „Zamów kuriera” nie woła DPD', async () => {
    const id = await niewiadoma()
    expect(await rozstrzygnij(id, 'PRZYJAL', ' AD1 123 ')).toMatchObject({ wynik: 'ZAPISANE', zlecenie: { stan: 'ZAMOWIONY', numer: 'AD1123', recznie: true } })
    atrapa = dpdAtrapa()
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true })
    expect(atrapa.calls).toEqual([])
    const id2 = await niewiadoma({ data: '2026-11-24' })
    expect(await rozstrzygnij(id2, 'PRZYJAL', '')).toMatchObject({ wynik: 'ZAPISANE', zlecenie: { stan: 'ZAMOWIONY', numer: null } })
  })

  it('OK z numerem zlecenia z samych zer = niewiadoma (do rozstrzygnięcia), nie zamówienie nr „0”', async () => {
    atrapa = dpdAtrapa([json({ status: { status: 'OK' }, orderNumber: '000', checkSum: 'c' })])
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', zlecenie: { stan: 'NIEJEDNOZNACZNY', numer: null } })
  })

  it('idempotentne: drugie kliknięcie tym samym wariantem = „już rozstrzygnięte” bez drugiego wpisu; inny wariant po rozstrzygnięciu = odmowa', async () => {
    const id = await niewiadoma()
    await rozstrzygnij(id, 'NIE_PRZYJAL')
    expect(await rozstrzygnij(id, 'NIE_PRZYJAL')).toMatchObject({ wynik: 'JUZ_ROZSTRZYGNIETE' })
    expect(await rozstrzygnij(id, 'PRZYJAL')).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('zmienił się') })
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_KURIERA_AUDIT } })).toBe(1)
  })

  it('równoległe kliknięcia: jedno rozstrzygnięcie i jeden wpis', async () => {
    const id = await niewiadoma()
    const w = await Promise.all([rozstrzygnij(id, 'NIE_PRZYJAL'), rozstrzygnij(id, 'NIE_PRZYJAL'), rozstrzygnij(id, 'NIE_PRZYJAL')])
    expect(w.filter((x) => x.wynik === 'ZAPISANE')).toHaveLength(1)
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_KURIERA_AUDIT } })).toBe(1)
  })

  it('tylko niewiadoma: odmowa przewoźnika albo zamówienie nie dają się rozstrzygnąć; zły numer i brak wiersza = odmowa', async () => {
    atrapa = dpdAtrapa([json({ status: { status: 'VALIDATION_ERROR' } })])
    const b = await zamow()
    if (b.wynik !== 'BLAD') throw new Error('oczekiwano BLAD')
    expect(await rozstrzygnij(b.zlecenie.id, 'NIE_PRZYJAL')).toMatchObject({ wynik: 'ODMOWA' })
    const id = await niewiadoma({ data: '2026-11-24' })
    expect(await rozstrzygnij(id, 'PRZYJAL', 'zły numer!')).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('Numer zlecenia') })
    expect(await rozstrzygnij('nie-ma-takiego', 'NIE_PRZYJAL')).toMatchObject({ wynik: 'ODMOWA' })
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_KURIERA_AUDIT } })).toBe(0)
  })

  it('linie paska: dziś (po rozstrzygnięciu kolejna próba jako nowy wiersz, ręczne „nie przyjął” zwinięte) i jutro → dwie linie, minione dni pominięte', async () => {
    const a = await niewiadoma({ odMin: 14 * 60 })
    await rozstrzygnij(a, 'NIE_PRZYJAL')
    atrapa = dpdAtrapa([{ error: new Error('socket hang up') }])
    await zamow({ odMin: 12 * 60, doMin: 14 * 60, drugi: true })
    await niewiadoma({ data: '2026-11-24', odMin: 16 * 60, doMin: 17 * 60 })
    const k = (await stanZamawianiaKuriera(db, deps())).get('DPD')!
    const linie = liniePaskaKuriera(k.zlecenia, '2026-11-23')
    expect(linie.map((l) => l.dzien)).toEqual(['2026-11-23', '2026-11-24'])
    expect(linie[0]!.glowna).toMatchObject({ stan: 'NIEJEDNOZNACZNY', odMin: 12 * 60, proba: 2 })
    expect(linie[0]!.pozostale).toMatchObject([{ id: a, stan: 'BLAD', recznie: true }])
    expect(linie[1]!.pozostale).toEqual([])
  })
})

describe('wolne przedziały podjazdu (courierOrderAvailability)', () => {
  it('przedziały z kodu pocztowego nadawcy firmy (bez dni, `offset` w minutach); tylko odczyt (GET), bez zamówienia', async () => {
    atrapa = dpdAtrapa([json({ status: 'OK', ranges: [{ offset: 360, range: '09:00-17:00' }, { offset: 180, range: '11:00-14:00' }, { offset: 180, range: '14:00-17:00' }], traceId: 't' })])
    expect(await przedzialyKuriera(db, 'DPD', deps())).toEqual({
      tryb: 'LISTA',
      przedzialy: [
        { odMin: 540, doMin: 1020, offsetMin: 360 },
        { odMin: 660, doMin: 840, offsetMin: 180 },
        { odMin: 840, doMin: 1020, offsetMin: 180 },
      ],
      dni: {},
    })
    expect(atrapa.calls).toHaveLength(1)
    expect(atrapa.calls[0]).toMatchObject({ path: DOSTEPNOSC, method: 'GET' })
    expect(await db.courierPickupOrder.count()).toBe(0)
  })

  it('RANGE_NOT_FOUND = lista pusta (brak przedziałów); błąd DPD = pola godzin z dopiskiem; zamawianie wyłączone = pola bez żądania', async () => {
    atrapa = dpdAtrapa([json({ status: 'RANGE_NOT_FOUND', traceId: 't' })])
    expect(await przedzialyKuriera(db, 'DPD', deps())).toEqual({ tryb: 'LISTA', przedzialy: [], dni: {} })
    atrapa = dpdAtrapa([json({}, 503)])
    expect(await przedzialyKuriera(db, 'DPD', deps())).toMatchObject({ tryb: 'POLA', uwaga: expect.stringContaining('Nie udało się pobrać wolnych przedziałów') })
    expect(atrapa.calls).toHaveLength(1)
    await firma({ ...KONTO, zamawianieKuriera: undefined })
    atrapa = dpdAtrapa()
    expect(await przedzialyKuriera(db, 'DPD', deps())).toEqual({ tryb: 'POLA', uwaga: null })
    expect(atrapa.calls).toEqual([])
  })
})
