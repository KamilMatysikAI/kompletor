// test całego obiegu druku — PRAWDZIWY kod agenta kontra PRAWDZIWE funkcje serwera, bez Windows.
//
// Wybrany wariant: pakiety da się połączyć bez odwzorowywania. Agent (`agent-druku/`) to osobny pakiet, ale jego źródła
// nie mają zależności uruchomieniowych, więc vitest głównego repo importuje je wprost:
//  - agent: klasy Agent (kolejka.ts), KlientSerwera (serwer.ts — ten sam klient HTTP, co na komputerze w magazynie),
//    RejestrWydrukow (rejestr.ts, plik w katalogu tymczasowym), LogPamieci; drukarki = AtrapaDrukarek z
//    agent-druku/test/atrapy.ts (nic się nie drukuje, PowerShell i SumatraPDF nie są wołane);
//  - serwer: KlientSerwera dostaje `fetch` = fetchDruku (tests/druk-pomocnicze.ts), który robi to samo co pliki
//    app/api/druk/**/route.ts: requireStationToken → lib/druk/agent-api.ts → lib/druk/zlecenia.ts na bazie testów (RLS);
//  - panel: zlecenia tworzy lib/druk/panel.ts (karty przez prawdziwe drukujKarty, lista, etykieta próbna, test).
// Jedyne, czego tu nie ma: warstwa HTTP Next (routing plików tras) i Windows — to sprawdza się ręcznie, lokalnie.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { Agent } from '../agent-druku/src/kolejka.js'
import { WERSJA_AGENTA } from '../agent-druku/src/kontrakt.js'
import { LogPamieci } from '../agent-druku/src/log.js'
import { RejestrWydrukow } from '../agent-druku/src/rejestr.js'
import { KlientSerwera } from '../agent-druku/src/serwer.js'
import { AtrapaDrukarek } from '../agent-druku/test/atrapy.js'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { statusZleceniaLubNull, wydrukTestowy, zlecZPanelu } from '@/lib/druk/panel'
import { ustawRouting } from '@/lib/druk/stanowiska'
import { resetLimitowDruku } from '@/lib/druk/tokeny'
import { WAZNOSC_MS } from '@/lib/druk/zlecenia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { fetchDruku, SERWER, stanowiskoZTokenem, zaleznosci } from './druk-pomocnicze'
import { order, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const deps = zaleznosci(sys, { [ORG_A]: a, [ORG_B]: b })
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
const DRUKARKI = { A4: 'Brother A4', TERMICZNA_1: 'Termiczna 1', TERMICZNA_2: 'Termiczna 2' }
let teraz = new Date('2026-11-04T08:00:00Z')
let katalog = ''
let klik = 0
const klucz = () => `obieg-klik-${String(++klik).padStart(8, '0')}`

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  resetLimitowDruku()
  teraz = new Date('2026-11-04T08:00:00Z')
  katalog = mkdtempSync(join(tmpdir(), 'druk-obieg-'))
})
afterEach(() => rmSync(katalog, { recursive: true, force: true }))
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

interface Stanowisko {
  agent: Agent
  drukarki: AtrapaDrukarek
  log: LogPamieci
  stationId: string
  code: string
  token: string
}

/** Agent jak na komputerze w magazynie: token z panelu, prawdziwy klient HTTP, rejestr na dysku, atrapa drukarek. */
async function agentStanowiska(
  db: PrismaClient = a,
  opcje: { code?: string; mapa?: Record<string, string>; drukarki?: AtrapaDrukarek; token?: string; stationId?: string; fetchOwijka?: (f: typeof fetch) => typeof fetch } = {},
): Promise<Stanowisko> {
  const code = opcje.code ?? 'magazyn-1'
  const st = opcje.token && opcje.stationId ? { token: opcje.token, id: opcje.stationId } : await stanowiskoZTokenem(db, code)
  const f = fetchDruku(deps, () => teraz)
  const drukarki = opcje.drukarki ?? new AtrapaDrukarek()
  const log = new LogPamieci()
  const { rejestr } = await RejestrWydrukow.wczytaj(join(katalog, code, 'wydrukowane.json'))
  const agent = new Agent({
    serwer: new KlientSerwera({ serwer: SERWER, token: st.token, stanowisko: code, timeoutMs: 5000, fetch: opcje.fetchOwijka ? opcje.fetchOwijka(f) : f }),
    drukarki,
    rejestr,
    log,
    ustawienia: { stanowisko: code, drukarki: opcje.mapa ?? DRUKARKI, katalogTymczasowy: join(katalog, code, 'tmp'), maksBajtowPliku: 20 << 20, maksKolejkaTermicznej: 5 },
    teraz: () => teraz,
  })
  return { agent, drukarki, log, stationId: st.id, code, token: st.token }
}

async function zamowienie(db: PrismaClient, externalId: string) {
  const p = await product(db, `SKU-${externalId}`, 10)
  return (await ingestOrder(db, order([{ productId: p, qty: 1 }], { externalId, createdAtChannel: new Date() }))).orderId!
}

const status = async (id: string) => (await statusZleceniaLubNull(a, id))!

describe('obieg: panel → serwer → agent → drukarka → wynik', () => {
  it('raport stanu, karty, lista, etykieta próbna i wydruk testowy: każde na właściwej drukarce, wynik OK w panelu', async () => {
    const s = await agentStanowiska()
    expect(await s.agent.raportujStan()).toBe(true)
    const st = await a.printStation.findUniqueOrThrow({ where: { id: s.stationId } })
    expect(st.agentVersion).toBe(WERSJA_AGENTA)
    expect((st.printers as { rola: string }[]).map((d) => d.rola)).toEqual(['A4', 'TERMICZNA_1', 'TERMICZNA_2'])

    const o1 = await zamowienie(a, '48213')
    await a.preparedShipment.create({ data: { orderId: o1, packageNo: 1, adapterKey: 'basecourier.v1', carrier: 'PACZKOMATY', courierCode: 'paczkomaty', parcelSize: 'A', weightKg: 0.5 } })
    const karta = await zlecZPanelu(a, KTO, { typ: 'karta', ids: [o1], stationId: s.stationId, klucz: klucz() }, { now: teraz })
    const listaW = await zlecZPanelu(a, KTO, { typ: 'lista', ids: [o1], stationId: s.stationId, klucz: klucz() }, { now: teraz })
    const etykieta = await zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.stationId, klucz: klucz() }, { now: teraz })
    const test = await wydrukTestowy(a, s.stationId, 'TERMICZNA_2', KTO.userId, teraz)

    const p = await s.agent.cyklZlecen()
    expect(p).toMatchObject({ pobrane: 4, wydrukowane: 4, bledy: 0, niewyslaneRaporty: 0 })
    expect(s.drukarki.wydruki.map((w) => [w.rodzaj, w.drukarka, w.skalowanie ?? null])).toEqual([
      ['pdf', 'Brother A4', 'fit'],
      ['pdf', 'Brother A4', 'fit'],
      ['raw', 'Termiczna 1', null],
      ['raw', 'Termiczna 2', null],
    ])
    expect(s.drukarki.wydruki[2]!.tresc).toContain('^CI28')
    expect(s.drukarki.wydruki[2]!.tresc).toContain('PRÓBA')
    for (const z of [karta.zlecenie, listaW.zlecenie, etykieta.zlecenie, test]) expect(await status(z.id), z.typ).toMatchObject({ status: 'OK' })
    expect((await status(etykieta.zlecenie.id)).drukarka).toBe('Termiczna 1')
    // kolejny cykl: nic do druku (serwer przestał zwracać zlecenia z wynikiem)
    expect(await s.agent.cyklZlecen()).toMatchObject({ pobrane: 0 })
    expect(s.drukarki.wydruki).toHaveLength(4)
    expect(await a.orderCardPrint.count()).toBe(1)
  })

  it('awaria termicznej: agent proponuje zapas, serwer tworzy nowe zlecenie, następny cykl drukuje na drugiej termicznej', async () => {
    const s = await agentStanowiska()
    await s.agent.raportujStan()
    const o1 = await zamowienie(a, '48700')
    await a.preparedShipment.create({ data: { orderId: o1, packageNo: 1, adapterKey: 'basecourier.v1', carrier: 'DPD', courierCode: 'dpd' } })
    s.drukarki.psute.add('Termiczna 1')
    const e = await zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.stationId, klucz: klucz() }, { now: teraz })
    expect(await s.agent.cyklZlecen()).toMatchObject({ pobrane: 1, bledy: 1 })
    const po = await status(e.zlecenie.id)
    expect(po).toMatchObject({ status: 'BLAD', zapas: { rola: 'TERMICZNA_2', status: 'OCZEKUJE' } })
    expect(po.komunikat).toMatch(/odrzuciła wydruk/)
    expect(await s.agent.cyklZlecen()).toMatchObject({ pobrane: 1, wydrukowane: 1 })
    expect(s.drukarki.wydruki.map((w) => [w.rodzaj, w.drukarka])).toEqual([['raw', 'Termiczna 2']])
    expect((await status(e.zlecenie.id)).zapas).toMatchObject({ status: 'OK' })
  })

  it('obie termiczne leżą: zapas na A4 jako PDF (ZPL na A4 by się nie wydrukował)', async () => {
    const s = await agentStanowiska()
    s.drukarki.ustawStan('Termiczna 1', { offline: true })
    s.drukarki.ustawStan('Termiczna 2', { status: 'PaperOut' })
    await s.agent.raportujStan()
    const t = await wydrukTestowy(a, s.stationId, 'TERMICZNA_1', KTO.userId, teraz)
    expect(await s.agent.cyklZlecen()).toMatchObject({ bledy: 1 })
    expect((await status(t.id)).zapas).toMatchObject({ rola: 'A4' })
    expect(await a.printJob.findFirstOrThrow({ where: { fallbackOfId: t.id } })).toMatchObject({ format: 'pdf', role: 'A4' })
    expect(await s.agent.cyklZlecen()).toMatchObject({ wydrukowane: 1 })
    expect(s.drukarki.wydruki.map((w) => [w.rodzaj, w.drukarka, w.skalowanie])).toEqual([['pdf', 'Brother A4', 'fit']])
  })

  it('przekroczony czas druku: BLAD „nie wiadomo, czy wyszło” bez zapasu — druga etykieta nie powstaje', async () => {
    const s = await agentStanowiska()
    await s.agent.raportujStan()
    s.drukarki.niepewne.add('Termiczna 1')
    const t = await wydrukTestowy(a, s.stationId, 'TERMICZNA_1', KTO.userId, teraz)
    await s.agent.cyklZlecen()
    expect(await status(t.id)).toMatchObject({ status: 'BLAD', zapas: null, komunikat: expect.stringMatching(/Nie wiadomo, czy wydruk wyszedł/) })
    expect(await a.printJob.count()).toBe(1)
    expect(await s.agent.cyklZlecen()).toMatchObject({ pobrane: 0 })
  })

  it('wynik zgubiony w sieci + restart agenta: serwer podaje zlecenie ponownie, agent odsyła OK z rejestru bez drugiego druku', async () => {
    let psujWynik = true
    const owijka = (f: typeof fetch) =>
      (async (u: RequestInfo | URL, init?: RequestInit) => {
        if (psujWynik && String(u).includes('/wynik')) {
          psujWynik = false
          throw new TypeError('fetch failed') // zerwane połączenie
        }
        return f(u, init)
      }) as typeof fetch
    const s = await agentStanowiska(a, { fetchOwijka: owijka })
    await s.agent.raportujStan()
    const t = await wydrukTestowy(a, s.stationId, 'A4', KTO.userId, teraz)
    expect(await s.agent.cyklZlecen()).toMatchObject({ wydrukowane: 1, niewyslaneRaporty: 1 })
    expect((await status(t.id)).status).toBe('OCZEKUJE')
    // „restart”: nowy Agent z tym samym rejestrem na dysku, tokenem i drukarkami
    const po = await agentStanowiska(a, { drukarki: s.drukarki, token: s.token, stationId: s.stationId })
    expect(await po.agent.cyklZlecen()).toMatchObject({ powtorzone: 1, wydrukowane: 0 })
    expect(s.drukarki.wydruki).toHaveLength(1)
    expect(await status(t.id)).toMatchObject({ status: 'OK' })
  })

  it('wiele drukarek (agent 0.2.0): A4_2 i TERMICZNA_4; stary agent 0.1.0 nie dostaje roli spoza swojego raportu', async () => {
    const drukarki = new AtrapaDrukarek()
    drukarki.stany.push({ nazwa: 'HP biuro', status: 'Normal', offline: false, zleceniaWKolejce: 0 }, { nazwa: 'Termiczna 4', status: 'Normal', offline: false, zleceniaWKolejce: 0 })
    const s = await agentStanowiska(a, { drukarki, mapa: { ...DRUKARKI, A4_2: 'HP biuro', TERMICZNA_4: 'Termiczna 4' } })
    await s.agent.raportujStan()
    await ustawRouting(a, s.stationId, { lista: 'A4_2', etykieta: 'TERMICZNA_4' }, KTO.userId)
    const o1 = await zamowienie(a, '48800')
    await a.preparedShipment.create({ data: { orderId: o1, packageNo: 1, adapterKey: 'basecourier.v1', carrier: 'DPD' } })
    await zlecZPanelu(a, KTO, { typ: 'lista', ids: [o1], stationId: s.stationId, klucz: klucz() }, { now: teraz })
    await zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.stationId, klucz: klucz() }, { now: teraz })
    await s.agent.cyklZlecen()
    expect(drukarki.wydruki.map((w) => [w.rodzaj, w.drukarka])).toEqual([
      ['pdf', 'HP biuro'],
      ['raw', 'Termiczna 4'],
    ])

    // stary agent: raport z trzema rolami (wersja 0.1.0) — routing na TERMICZNA_4 nie daje zlecenia
    await a.printStation.update({ where: { id: s.stationId }, data: { printers: [{ rola: 'A4', nazwa: 'Brother A4', stan: 'DOSTEPNA', zleceniaWKolejce: 0 }], agentVersion: '0.1.0' } })
    await expect(zlecZPanelu(a, KTO, { typ: 'etykieta', ids: [o1], stationId: s.stationId, klucz: klucz() }, { now: teraz })).rejects.toThrow(/nie ma drukarki Termiczna 4/)
  })

  it('zlecenie sprzed 8 godzin nie drukuje się po włączeniu komputera', async () => {
    const s = await agentStanowiska()
    await s.agent.raportujStan()
    const t = await wydrukTestowy(a, s.stationId, 'A4', KTO.userId, teraz)
    teraz = new Date(teraz.getTime() + WAZNOSC_MS + 60_000)
    expect(await s.agent.cyklZlecen()).toMatchObject({ pobrane: 0 })
    expect(s.drukarki.wydruki).toHaveLength(0)
    expect((await status(t.id)).status).toBe('WYGASLO')
  })

  it('dwie firmy: agent firmy B nie dostaje zleceń firmy A, a jego raport nie zmienia stanowiska A', async () => {
    const sa = await agentStanowiska(a)
    const sb = await agentStanowiska(b)
    await sa.agent.raportujStan()
    sb.drukarki.ustawStan('Brother A4', { offline: true })
    await sb.agent.raportujStan()
    await wydrukTestowy(a, sa.stationId, 'A4', KTO.userId, teraz)
    expect(await sb.agent.cyklZlecen()).toMatchObject({ pobrane: 0 })
    expect(await sa.agent.cyklZlecen()).toMatchObject({ wydrukowane: 1 })
    expect(sb.drukarki.wydruki).toHaveLength(0)
    const stA = await a.printStation.findUniqueOrThrow({ where: { id: sa.stationId } })
    expect((stA.printers as { stan: string }[]).every((d) => d.stan === 'DOSTEPNA')).toBe(true)
  })
})

