// konto zasilane tylko przez API Kompletora (EASYTOOLS: zamówienia z POST /api/v1/zamowienia, bez adaptera
// w rejestrze, bez ofert i bez sklepu do zapisu). Sprawdza na bazie: przełączenie z ekranu konta bez testu połączenia,
// zbiorcze „Włącz tryb pracy” z Pulpitu (konto dostaje pracę bez stanów), zamówienie kształtu ogólnego z zestawem
// (rezerwacja składników, idempotencja), bramka pracy karty (pakowanie, nadanie, faktury) i brak skutków ubocznych:
// zero wierszy zapisu do kanału, zero alertów i zapis stanów bez adaptera. Dane fikcyjne, bez sieci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { parseGeneralOrder } from '@/lib/api/zapis-ogolny'
import { trybKonta, zmienTrybKonta } from '@/lib/kanaly/tryb'
import { adapterStanowKonta, przebiegZapisuKanalow, zaplanujZapisy } from '@/lib/kanaly/zapis-host'
import { kontoZamowienia, pracaDostepna } from '@/lib/praca/wlacznik'
import { przyjmijZamowienie } from '@/lib/zamowienia/ogolne'
import { wlaczPraceFirmy } from '@/lib/start/tryb-firmy'
import { ORG_A, testDb, truncateAll } from './db'
import { ACC, bundle, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const ET = ACC.EASYTOOLS
const where = { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...ET } }
const PRACA_ENV = { EKRANY_PRACA: '1' }
const ENV = { ...PRACA_ENV, CUSTOMER_DATA_KEYS: `1:${'4'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'e'.repeat(64) }
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

let registry: AdapterRegistry
const opts = (env: Record<string, string> = PRACA_ENV) => ({ actorId: 'test', env, registry, firmaZBl: true, now: T0 })
const tryby = async () => {
  const r = await db.channelConfig.findUniqueOrThrow({ where })
  return { stockMode: r.stockMode, statusMode: r.statusMode, trackingMode: r.trackingMode }
}

/** Treść jak z crona EasyTools (`kompletor_zadanie`): kształt ogólny, kanał EASYTOOLS, klient z adresem, same pozycje fizyczne. */
const tresc = (numer: string, pozycje: { sku: string; ilosc: number; cenaBrutto: number; vat?: string }[]) => ({
  kanal: 'EASYTOOLS',
  numer,
  zrodlo: 'EasyTools',
  zlozono: T0.toISOString(),
  platnosc: 'PAID',
  platnoscMetoda: 'Karta (test), opłacone',
  dostawa: { sposob: 'Kurier DPD (test, wysyłka w cenie)', koszt: 0 },
  chceFakture: false,
  klient: {
    adres: { ulica: 'Przykładowa', numerDomu: '1', numerLokalu: '2', kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' },
    imieNazwisko: 'Anna Przykładowa',
    email: 'klientka@example.com',
    telefon: '+48 600 000 000',
  },
  pozycje,
})

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  // konto jak na produkcji: adapter spoza rejestru, bez testu połączenia, bez ofert, w podglądzie
  await db.channelConfig.create({ data: { ...ET, name: 'EasyTools test', adapterKey: 'easytools.v1' } })
  registry = new AdapterRegistry([fakeDefinition(new FakeChannelState(), 'WOO')])
})

describe('konto tylko przez API: przełączenie', () => {
  it('ekran konta: praca bez stanów i pełna praca bez testu połączenia; wyłącznik instancji dalej obowiązuje', async () => {
    await expect(zmienTrybKonta(db, ET, 'BEZ_STANOW', opts({}))).rejects.toThrow(/przechodzących z BaseLinkera/)
    expect(await tryby()).toEqual({ stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN' })
    expect(await zmienTrybKonta(db, ET, 'BEZ_STANOW', opts())).toBe('ZMIENIONO')
    expect(await tryby()).toEqual({ stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'PRACA' })
    expect(await zmienTrybKonta(db, ET, 'CIEN', opts())).toBe('ZMIENIONO')
    expect(await zmienTrybKonta(db, ET, 'PRACA', opts())).toBe('ZMIENIONO')
    expect(await tryby()).toEqual({ stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA' })
    // wyłączone konto blokuje jak każde inne
    await zmienTrybKonta(db, ET, 'CIEN', opts())
    await db.channelConfig.update({ where, data: { active: false } })
    await expect(zmienTrybKonta(db, ET, 'BEZ_STANOW', opts())).rejects.toThrow(/wyłączone/)
  })

  it('Pulpit „Włącz tryb pracy”: konto tylko przez API dostaje pracę bez stanów, konta sklepów bez testu zostają z powodem', async () => {
    const w = await wlaczPraceFirmy(db, opts())
    expect(w.wlaczone).toEqual(['EasyTools test'])
    const row = await db.channelConfig.findUniqueOrThrow({ where })
    expect(trybKonta(row)).toBe('BEZ_STANOW')
    expect(row.goRef).toBe('panel:praca-bez-stanow')
    // sklepy bez sprawdzonego połączenia nie przechodzą (dotychczasowe zachowanie bez zmian)
    expect(w.pominiete.map((p) => p.nazwa)).toContain('WOO_SD test')
    // idempotencja: drugi klik nic nie zmienia na koncie tylko przez API
    expect((await wlaczPraceFirmy(db, opts())).wlaczone).not.toContain('EasyTools test')
  })
})

describe('konto tylko przez API w pracy: zamówienie z API jak zwykłe, bez skutków ubocznych', () => {
  it('zestaw i towar: rezerwacja składników, powtórka DUPLIKAT, karta w pracy, zero zapisów do kanału i alertów', async () => {
    await zmienTrybKonta(db, ET, 'BEZ_STANOW', opts())
    const kula = await product(db, 'TEST-KULA', 10, { priceGross: 19.7 })
    const serce = await product(db, 'TEST-SERCE', 10, { priceGross: 21.7 })
    await bundle(db, 'TEST-PROBKI', [{ id: kula, qty: 1 }, { id: serce, qty: 1 }])
    const zestaw = await product(db, 'TEST-ZESTAW', 3, { priceGross: 119 })
    const body = tresc('00000000-0000-4000-8000-0000000000a1', [
      { sku: 'TEST-PROBKI', ilosc: 1, cenaBrutto: 41.4, vat: '23' },
      { sku: 'TEST-ZESTAW', ilosc: 1, cenaBrutto: 119, vat: '23' },
    ])
    const o = { source: 'api' as const, actorId: 'api:test', env: ENV, now: T0 }
    const r1 = await przyjmijZamowienie(db, parseGeneralOrder(body), o)
    expect(r1.status).toBe(201)
    expect(r1.body).toMatchObject({ status: 'DO_REALIZACJI', outcome: 'NOWE', klient: 'ZAPISANO' })
    const id = r1.body.id
    const zam = await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true } })
    expect(zam).toMatchObject({ channel: 'EASYTOOLS', channelAccountId: 'et', carrier: 'DPD', paymentState: 'PAID' })
    expect(zam.reservations.map((x) => [x.productId, x.qtyBase, x.state]).sort()).toEqual(
      [[kula, 1, 'ACTIVE'], [serce, 1, 'ACTIVE'], [zestaw, 1, 'ACTIVE']].sort(),
    )
    const r2 = await przyjmijZamowienie(db, parseGeneralOrder(body), o)
    expect(r2).toMatchObject({ status: 200, body: { id, outcome: 'DUPLIKAT' } })

    // bramka pracy karty (płatność, statusy, pakowanie, nadanie): konto prowadzi zamówienia
    const k = await kontoZamowienia(db, ET, PRACA_ENV)
    expect(pracaDostepna(k, PRACA_ENV)).toBe(true)

    // wysłane w Kompletorze: host zapisu nic nie planuje ani nie wysyła (brak adaptera = brak zapisu, bez błędów)
    await db.order.update({ where: { id }, data: { status: 'WYSLANE' } })
    await zaplanujZapisy(db, registry, { now: at(M) })
    await przebiegZapisuKanalow(db, { registry, secrets: { env: {}, envFallback: false }, now: at(2 * M) })
    expect(await db.channelWrite.count({ where: { channel: 'EASYTOOLS' } })).toBe(0)
    expect(await adapterStanowKonta(db, ET, { registry, secrets: { env: {}, envFallback: false }, now: at(2 * M) })).toBeNull()
    expect(await db.alert.count()).toBe(0)
  })

  it('pełna praca (ze stanami) też bez skutków: zapis stanów zablokowany powodem, bez alertu', async () => {
    await zmienTrybKonta(db, ET, 'PRACA', opts())
    const ad = await adapterStanowKonta(db, ET, { registry, secrets: { env: {}, envFallback: false }, now: at(M) })
    expect(ad).toEqual({ zablokowane: expect.stringMatching(/adaptera/) })
    expect(await db.alert.count()).toBe(0)
  })
})
